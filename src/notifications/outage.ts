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

const DEFAULT_STATE: OutageState = { schemaVersion: 1, outageActive: false, queue: [] };
const MAX_QUEUE = 64;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REASONS = new Set([
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
  "sync",
  "workspace",
  "secrets",
  "controller",
  "child-start",
  "timeout",
  "unknown",
]);

export function isNotificationReason(value: string): boolean {
  return REASONS.has(value);
}

/* A busy lock is another local run holding this workspace, a validation failure is the operator's
   own manifest, and a consumer-setup failure is their own setup script exiting non-zero — none of
   them says the remote is down, so none may raise an outage. */
const LOCAL_REASONS = new Set(["lock", "validation", "consumer-setup"]);

export function isOutageReason(value: string): boolean {
  return REASONS.has(value) && !LOCAL_REASONS.has(value);
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

async function deliver(runtime: OutageRuntime, state: OutageState): Promise<DeliveryResult> {
  let current = state;
  let delivered = true;
  while (current.queue.length > 0) {
    try {
      await runtime.send(current.queue[0]!);
    } catch {
      delivered = false;
      break;
    }
    current = { ...current, queue: current.queue.slice(1) };
    await runtime.writeState(current);
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
