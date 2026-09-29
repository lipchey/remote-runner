import type { FailureClass } from "../run/prepare.js";

export interface NotificationEvent {
  readonly kind: "outage" | "recovery";
  readonly consumer: string;
  readonly profile: string;
  readonly remoteLabel: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface OutageState {
  readonly schemaVersion: 1;
  readonly outageActive: boolean;
  readonly activeReason?: string;
  readonly queue: readonly NotificationEvent[];
}

export interface NotificationContext {
  readonly consumer: string;
  readonly profile: string;
  readonly remoteLabel: string;
}

export interface OutageRuntime {
  readState(): Promise<OutageState | undefined>;
  writeState(state: OutageState): Promise<void>;
  now(): string;
  send(event: NotificationEvent): Promise<void>;
}

export interface DeliveryResult {
  readonly delivered: boolean;
  readonly pending: number;
}

export interface FallbackTopology {
  readonly target: string;
  readonly hostKeySha256: string;
  readonly fallback: string;
  readonly fallbackTarget: string;
}

export interface FallbackContext {
  readonly consumer: string;
  readonly requested: string;
  readonly fallback: string;
  readonly remoteLabel: string;
  readonly topology: FallbackTopology;
}

interface FallbackEventBase {
  readonly consumer: string;
  readonly requested: string;
  readonly fallback: string;
  readonly remoteLabel: string;
  readonly timestamp: string;
}

export type FallbackEvent =
  | (FallbackEventBase & {
      readonly kind: "primary-down";
      readonly class: "reachability";
      readonly reason: string;
    })
  | (FallbackEventBase & {
      readonly kind: "primary-refused";
      readonly class: FailureClass;
      readonly reason: string;
    })
  | (FallbackEventBase & {
      readonly kind: "primary-recovered";
      readonly cleared: "outage" | "refusal" | "both";
    });

export interface FallbackState {
  readonly schemaVersion: 2;
  readonly consumer: string;
  readonly primary: string;
  readonly topology: FallbackTopology;
  readonly outage: { readonly reason: string; readonly since: string } | null;
  readonly refusal: { readonly class: FailureClass; readonly reason: string; readonly since: string } | null;
  readonly negative: { readonly checkedAt: string; readonly ttlMs: number } | null;
  readonly lease: { readonly takenAt: string; readonly ttlMs: number } | null;
  readonly lastRecoveryAt: string | null;
  readonly backoffTtlMs: number;
  readonly queue: readonly FallbackEvent[];
}

export interface FallbackRuntime {
  readState(): Promise<unknown>;
  writeState(state: FallbackState): Promise<void>;
  nowMs(): number;
  send(event: FallbackEvent): Promise<void>;
  warn(message: string): void;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

const DEFAULT_STATE: OutageState = { schemaVersion: 1, outageActive: false, queue: [] };
const MAX_QUEUE = 64;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const NEGATIVE_BASE_MS = 60_000;
export const NEGATIVE_MAX_MS = 600_000;
export const FLAP_WINDOW_MS = 900_000;
export const LEASE_MS = 60_000;
export const MAX_DELIVERIES_PER_HOLD = 4;
export const NOTIFICATION_REASONS = new Set([
  "dns",
  "host-key",
  "authentication",
  "transport",
  "remote-shell",
  "capacity",
  "bootstrap",
  "consumer-setup",
  "validation",
  "lock",
  "account-busy",
  "sync",
  "workspace",
  "secrets",
  "controller",
  "child-start",
  "connection-lost",
  "timeout",
  "unknown",
]);

export function isNotificationReason(value: string): boolean {
  return NOTIFICATION_REASONS.has(value);
}

/* The notification channel and durable state carry only closed-set reasons, so a caller crossing
   into them maps here first and an unrecognised value degrades to a known code instead of being
   persisted verbatim. The stderr and runner-log lines are not bound by this — they keep the raw
   reason on purpose, because a wrong reason there is a diagnostic, not a stored fact. */
export function stableReason(value: string): string {
  return isNotificationReason(value) ? value : "unknown";
}

/* A busy lock is another local run holding this workspace, a validation failure is the operator's
   own manifest, a consumer-setup failure is their own setup script exiting non-zero, and a secrets
   failure is their own dotenv or provider — collected on this machine, and encoded here too, so
   neither half of it ever touches the remote — none of them says the remote is down, so none may
   raise an outage. */
const LOCAL_REASONS = new Set(["lock", "account-busy", "validation", "consumer-setup", "secrets"]);

export function isOutageReason(value: string): boolean {
  return NOTIFICATION_REASONS.has(value) && !LOCAL_REASONS.has(value);
}

function closed(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validateEvent(event: NotificationEvent): boolean {
  return (
    closed(event, ["consumer", "kind", "profile", "reason", "remoteLabel", "timestamp"]) &&
    (event.kind === "outage" || event.kind === "recovery") &&
    [event.consumer, event.profile, event.remoteLabel].every((value) => FIELD.test(value)) &&
    isNotificationReason(event.reason) &&
    Number.isFinite(new Date(event.timestamp).valueOf()) &&
    new Date(event.timestamp).toISOString() === event.timestamp
  );
}

function validateState(value: OutageState | undefined): OutageState {
  if (value === undefined) return DEFAULT_STATE;
  const expectedKeys = value.outageActive
    ? ["activeReason", "outageActive", "queue", "schemaVersion"]
    : ["outageActive", "queue", "schemaVersion"];
  if (
    !closed(value, expectedKeys) ||
    value.schemaVersion !== 1 ||
    typeof value.outageActive !== "boolean" ||
    !Array.isArray(value.queue) ||
    value.queue.length > MAX_QUEUE ||
    value.queue.some((event) => !validateEvent(event)) ||
    (value.outageActive
      ? typeof value.activeReason !== "string" || !isNotificationReason(value.activeReason)
      : value.activeReason !== undefined)
  ) {
    throw new Error("outage state is corrupt");
  }
  const queue = value.queue.filter((entry) => isOutageReason(entry.reason));
  /* State written before local reasons stopped raising outages can still carry an ACTIVE `lock` or
     `validation` outage. Left in place it swallows the next real outage (an active outage suppresses
     the new event) and later emits a recovery for an outage that never happened. */
  if (value.outageActive && !isOutageReason(value.activeReason ?? "")) {
    return { schemaVersion: 1, outageActive: false, queue };
  }
  return { ...value, queue };
}

function event(
  runtime: OutageRuntime,
  context: NotificationContext,
  kind: "outage" | "recovery",
  reason: string,
): NotificationEvent {
  const candidate = { kind, ...context, reason, timestamp: runtime.now() };
  if (!validateEvent(candidate)) throw new Error("notification event is invalid");
  return candidate;
}

async function deliver<Event, State extends { readonly queue: readonly Event[] }>(
  runtime: { send(event: Event): Promise<void>; writeState(state: State): Promise<void> },
  state: State,
  limit = Number.POSITIVE_INFINITY,
): Promise<DeliveryResult> {
  let current = state;
  let delivered = true;
  let count = 0;
  while (current.queue.length > 0 && count < limit) {
    try {
      await runtime.send(current.queue[0]!);
    } catch {
      delivered = false;
      break;
    }
    current = { ...current, queue: current.queue.slice(1) } as State;
    await runtime.writeState(current);
    count += 1;
  }
  return { delivered, pending: current.queue.length };
}

export async function recordFallback(
  runtime: OutageRuntime,
  context: NotificationContext,
  reason: string,
): Promise<DeliveryResult> {
  let state = validateState(await runtime.readState());
  if (!state.outageActive) {
    if (state.queue.length >= MAX_QUEUE) throw new Error("notification queue is full");
    state = {
      ...state,
      outageActive: true,
      activeReason: reason,
      queue: [...state.queue, event(runtime, context, "outage", reason)],
    };
    await runtime.writeState(state);
  }
  return deliver(runtime, state);
}

export async function recordRemoteChildStarted(
  runtime: OutageRuntime,
  context: NotificationContext,
): Promise<DeliveryResult> {
  let state = validateState(await runtime.readState());
  if (state.outageActive) {
    if (state.queue.length >= MAX_QUEUE) throw new Error("notification queue is full");
    const reason = state.activeReason!;
    state = {
      schemaVersion: 1,
      outageActive: false,
      queue: [...state.queue, event(runtime, context, "recovery", reason)],
    };
    await runtime.writeState(state);
  }
  return deliver(runtime, state);
}

const FAILURE_CLASSES = new Set<FailureClass>(["reachability", "local", "security", "remote"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateTopology(value: unknown): value is FallbackTopology {
  return (
    record(value) &&
    closed(value, ["fallback", "fallbackTarget", "hostKeySha256", "target"]) &&
    typeof value.fallback === "string" &&
    FIELD.test(value.fallback) &&
    [value.target, value.hostKeySha256, value.fallbackTarget].every(
      (field) => typeof field === "string" && field.length > 0,
    )
  );
}

function validateFallbackEvent(value: unknown): value is FallbackEvent {
  if (!record(value) || typeof value.kind !== "string") return false;
  const expected =
    value.kind === "primary-recovered"
      ? ["cleared", "consumer", "fallback", "kind", "remoteLabel", "requested", "timestamp"]
      : ["class", "consumer", "fallback", "kind", "reason", "remoteLabel", "requested", "timestamp"];
  if (
    !closed(value, expected) ||
    ![value.consumer, value.requested, value.fallback, value.remoteLabel].every(
      (field) => typeof field === "string" && FIELD.test(field),
    ) ||
    !canonicalTimestamp(value.timestamp)
  ) {
    return false;
  }
  if (value.kind === "primary-recovered") {
    return value.cleared === "outage" || value.cleared === "refusal" || value.cleared === "both";
  }
  if (
    (value.kind !== "primary-down" && value.kind !== "primary-refused") ||
    typeof value.class !== "string" ||
    !FAILURE_CLASSES.has(value.class as FailureClass) ||
    typeof value.reason !== "string" ||
    !isNotificationReason(value.reason)
  ) {
    return false;
  }
  return value.kind !== "primary-down" || value.class === "reachability";
}

function validateOutage(value: unknown): value is NonNullable<FallbackState["outage"]> {
  return (
    record(value) &&
    closed(value, ["reason", "since"]) &&
    typeof value.reason === "string" &&
    isOutageReason(value.reason) &&
    canonicalTimestamp(value.since)
  );
}

function validateRefusal(value: unknown): value is NonNullable<FallbackState["refusal"]> {
  return (
    record(value) &&
    closed(value, ["class", "reason", "since"]) &&
    typeof value.class === "string" &&
    FAILURE_CLASSES.has(value.class as FailureClass) &&
    typeof value.reason === "string" &&
    isNotificationReason(value.reason) &&
    canonicalTimestamp(value.since)
  );
}

function validateTimedEntry(value: unknown, timestampKey: "checkedAt" | "takenAt"): boolean {
  return (
    record(value) &&
    closed(value, [timestampKey, "ttlMs"]) &&
    canonicalTimestamp(value[timestampKey]) &&
    positiveInteger(value.ttlMs)
  );
}

function validateFallbackState(value: unknown): FallbackState {
  if (
    !record(value) ||
    !closed(value, [
      "backoffTtlMs",
      "consumer",
      "lastRecoveryAt",
      "lease",
      "negative",
      "outage",
      "primary",
      "queue",
      "refusal",
      "schemaVersion",
      "topology",
    ]) ||
    value.schemaVersion !== 2 ||
    typeof value.consumer !== "string" ||
    !FIELD.test(value.consumer) ||
    typeof value.primary !== "string" ||
    !FIELD.test(value.primary) ||
    !validateTopology(value.topology) ||
    (value.outage !== null && !validateOutage(value.outage)) ||
    (value.refusal !== null && !validateRefusal(value.refusal)) ||
    (value.negative !== null && !validateTimedEntry(value.negative, "checkedAt")) ||
    (value.lease !== null && !validateTimedEntry(value.lease, "takenAt")) ||
    (value.lastRecoveryAt !== null && !canonicalTimestamp(value.lastRecoveryAt)) ||
    !positiveInteger(value.backoffTtlMs) ||
    value.backoffTtlMs > NEGATIVE_MAX_MS ||
    !Array.isArray(value.queue) ||
    value.queue.length > MAX_QUEUE ||
    value.queue.some((entry) => !validateFallbackEvent(entry))
  ) {
    throw new Error("fallback state is corrupt");
  }
  return value as unknown as FallbackState;
}

function validateFallbackContext(context: FallbackContext): void {
  if (
    ![context.consumer, context.requested, context.fallback, context.remoteLabel].every((field) => FIELD.test(field)) ||
    !validateTopology(context.topology) ||
    context.topology.fallback !== context.fallback
  ) {
    throw new Error("fallback context is invalid");
  }
}

function emptyFallbackState(context: FallbackContext, queue: readonly FallbackEvent[] = []): FallbackState {
  return {
    schemaVersion: 2,
    consumer: context.consumer,
    primary: context.requested,
    topology: { ...context.topology },
    outage: null,
    refusal: null,
    negative: null,
    lease: null,
    lastRecoveryAt: null,
    backoffTtlMs: NEGATIVE_BASE_MS,
    queue,
  };
}

function sameTopology(left: FallbackTopology, right: FallbackTopology): boolean {
  return (
    left.target === right.target &&
    left.hostKeySha256 === right.hostKeySha256 &&
    left.fallback === right.fallback &&
    left.fallbackTarget === right.fallbackTarget
  );
}

async function fallbackState(
  runtime: FallbackRuntime,
  context: FallbackContext,
): Promise<{ readonly state: FallbackState; readonly reset: boolean }> {
  validateFallbackContext(context);
  const stored = await runtime.readState();
  if (stored === undefined) return { state: emptyFallbackState(context), reset: false };
  const state = validateFallbackState(stored);
  if (state.consumer !== context.consumer || state.primary !== context.requested) {
    throw new Error("fallback state is corrupt");
  }
  if (sameTopology(state.topology, context.topology)) return { state, reset: false };
  const reset = emptyFallbackState(context, state.queue);
  await runtime.writeState(reset);
  runtime.warn("remote-runner: fallback topology changed; state reset");
  return { state: reset, reset: true };
}

function timestamp(runtime: FallbackRuntime): string {
  const value = new Date(runtime.nowMs());
  if (!Number.isFinite(value.valueOf())) throw new Error("fallback clock is invalid");
  return value.toISOString();
}

function fresh(entry: { readonly ttlMs: number }, at: string, nowMs: number): boolean {
  const startedAt = new Date(at).valueOf();
  return startedAt <= nowMs && nowMs < startedAt + Math.min(entry.ttlMs, NEGATIVE_MAX_MS);
}

function enqueue(state: FallbackState, event: FallbackEvent): FallbackState {
  if (state.queue.length >= MAX_QUEUE) throw new Error("notification queue is full");
  if (!validateFallbackEvent(event)) throw new Error("fallback event is invalid");
  return { ...state, queue: [...state.queue, event] };
}

function fallbackEvent(
  runtime: FallbackRuntime,
  context: FallbackContext,
  specific:
    | { readonly kind: "primary-down"; readonly class: "reachability"; readonly reason: string }
    | { readonly kind: "primary-refused"; readonly class: FailureClass; readonly reason: string }
    | { readonly kind: "primary-recovered"; readonly cleared: "outage" | "refusal" | "both" },
): FallbackEvent {
  return {
    ...specific,
    consumer: context.consumer,
    requested: context.requested,
    fallback: context.fallback,
    remoteLabel: context.remoteLabel,
    timestamp: timestamp(runtime),
  };
}

async function deliverFallback(runtime: FallbackRuntime, state: FallbackState): Promise<DeliveryResult> {
  return deliver(runtime, state, MAX_DELIVERIES_PER_HOLD);
}

export async function selectPrimary(runtime: FallbackRuntime, context: FallbackContext): Promise<boolean> {
  return runtime.withLock(async () => {
    const loaded = await fallbackState(runtime, context);
    if (loaded.reset) return true;
    const state = loaded.state;
    if (state.refusal !== null) return true;
    const nowMs = runtime.nowMs();
    if (state.negative !== null && fresh(state.negative, state.negative.checkedAt, nowMs)) return false;
    if (state.outage !== null && state.lease !== null && fresh(state.lease, state.lease.takenAt, nowMs)) return false;
    if (state.outage !== null && state.negative !== null) {
      await runtime.writeState({
        ...state,
        lease: { takenAt: timestamp(runtime), ttlMs: LEASE_MS },
      });
    }
    return true;
  });
}

export async function observeUnreachable(
  runtime: FallbackRuntime,
  context: FallbackContext,
  reason: string,
): Promise<DeliveryResult> {
  return runtime.withLock(async () => {
    const loaded = await fallbackState(runtime, context);
    if (loaded.reset) return { delivered: true, pending: loaded.state.queue.length };
    let state = loaded.state;
    const stable = stableReason(reason);
    if (!isOutageReason(stable)) throw new Error("fallback outage reason is invalid");
    const now = timestamp(runtime);
    const nowMs = runtime.nowMs();
    const withinFlapWindow =
      state.lastRecoveryAt !== null &&
      new Date(state.lastRecoveryAt).valueOf() <= nowMs &&
      nowMs - new Date(state.lastRecoveryAt).valueOf() < FLAP_WINDOW_MS;
    const ttlMs =
      state.outage === null ? (withinFlapWindow ? state.backoffTtlMs : NEGATIVE_BASE_MS) : state.backoffTtlMs;
    if (state.outage === null) {
      state = enqueue(
        { ...state, outage: { reason: stable, since: now } },
        fallbackEvent(runtime, context, { kind: "primary-down", class: "reachability", reason: stable }),
      );
    }
    state = {
      ...state,
      negative: { checkedAt: now, ttlMs },
      lease: null,
      backoffTtlMs: Math.min(ttlMs * 2, NEGATIVE_MAX_MS),
    };
    await runtime.writeState(state);
    return deliverFallback(runtime, state);
  });
}

export async function observeReachable(runtime: FallbackRuntime, context: FallbackContext): Promise<DeliveryResult> {
  return runtime.withLock(async () => {
    const loaded = await fallbackState(runtime, context);
    if (loaded.reset) return { delivered: true, pending: loaded.state.queue.length };
    let state = loaded.state;
    if (state.negative !== null || state.lease !== null) {
      state = { ...state, negative: null, lease: null };
      await runtime.writeState(state);
    }
    return deliverFallback(runtime, state);
  });
}

export async function observeRefused(
  runtime: FallbackRuntime,
  context: FallbackContext,
  failureClass: FailureClass,
  reason: string,
): Promise<DeliveryResult> {
  return runtime.withLock(async () => {
    const loaded = await fallbackState(runtime, context);
    if (loaded.reset) return { delivered: true, pending: loaded.state.queue.length };
    let state = loaded.state;
    const stable = stableReason(reason);
    if (!FAILURE_CLASSES.has(failureClass)) throw new Error("fallback failure class is invalid");
    const recordRefusal = failureClass !== "remote" || isOutageReason(stable);
    const changed = recordRefusal && (state.refusal?.class !== failureClass || state.refusal.reason !== stable);
    state = { ...state, negative: null, lease: null };
    if (changed) {
      const since = timestamp(runtime);
      state = enqueue(
        { ...state, refusal: { class: failureClass, reason: stable, since } },
        fallbackEvent(runtime, context, {
          kind: "primary-refused",
          class: failureClass,
          reason: stable,
        }),
      );
    }
    if (changed || loaded.state.negative !== null || loaded.state.lease !== null) await runtime.writeState(state);
    return deliverFallback(runtime, state);
  });
}

export async function observePrimaryChildStarted(
  runtime: FallbackRuntime,
  context: FallbackContext,
): Promise<DeliveryResult> {
  return runtime.withLock(async () => {
    const loaded = await fallbackState(runtime, context);
    if (loaded.reset) return { delivered: true, pending: loaded.state.queue.length };
    let state = loaded.state;
    if (state.outage !== null || state.refusal !== null) {
      const cleared =
        state.outage !== null && state.refusal !== null ? "both" : state.outage !== null ? "outage" : "refusal";
      const recoveredAt = timestamp(runtime);
      state = enqueue(
        {
          ...state,
          outage: null,
          refusal: null,
          negative: null,
          lease: null,
          lastRecoveryAt: recoveredAt,
        },
        fallbackEvent(runtime, context, { kind: "primary-recovered", cleared }),
      );
      await runtime.writeState(state);
    }
    return deliverFallback(runtime, state);
  });
}
