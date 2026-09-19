import { posix } from "node:path";

import { DiagnosableError, diagnosableMessage } from "../runtime/diagnostic.js";
import { pathIdentity } from "../runtime/identity.js";
import { SSH_TARGET, type BoundedProcessRequest, type BoundedProcessResult } from "../ssh/client.js";

const CAPTURE_BYTES = 64 * 1024;
const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const IDENTITY = /^[0-9a-f]{24}$/u;
/* Mutagen's own session identifier shape (`sync_` plus base62, v0.18.1). Enforced because the sweep
   passes it as a bare `<session>` argument: `sync terminate` also reads `-a` there, which terminates
   EVERY session on the machine, so an identifier that is not this shape is not spendable as argv. */
const SESSION_IDENTIFIER = /^sync_[A-Za-z0-9]{1,64}$/u;
const LIST_TEMPLATE = "{{ json . }}";
/* Diagnostics list sessions exactly as the run does, so a probe can never green on a listing the
   run would reject. */
export const MUTAGEN_LIST_ARGUMENTS: readonly string[] = ["sync", "list", "--template", LIST_TEMPLATE];

export const MANDATORY_MUTAGEN_IGNORES = [
  ".git",
  "node_modules",
  ".pnpm-store",
  ".nx",
  "dist",
  "coverage",
  ".artifacts",
  ".env",
  ".age-key.age",
  ".tools/gitleaks",
] as const;

export interface MutagenProcessRuntime {
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

export interface MonotonicClock {
  now(): number;
}

export interface MutagenSessionOptions {
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly canonicalAlphaRoot: string;
  readonly betaTarget: string;
  readonly betaRoot: string;
  readonly ignores: readonly string[];
}

declare const pausedSessionBrand: unique symbol;

export interface PausedMutagenSession {
  readonly [pausedSessionBrand]: true;
}

export interface MutagenFlushResult {
  readonly session: PausedMutagenSession;
  readonly flushDurationMs: number;
  readonly transferredBytes?: number;
}

interface ValidatedSession {
  readonly name: string;
  readonly alpha: string;
  readonly beta: string;
  readonly ignores: readonly string[];
}

interface ValidatedTermination {
  readonly name: string;
  readonly beta: string;
}

interface SessionRecord {
  readonly identifier: string;
  readonly name: string;
  readonly alpha: string;
  readonly beta: string;
  readonly mode: string;
  readonly ignores: readonly string[];
  readonly paused: boolean;
  readonly status?: string;
  readonly conflicts: number;
  readonly excludedConflicts: number;
}

interface DescriptorState {
  readonly session: ValidatedSession;
  used: boolean;
}

function assertPattern(pattern: string): void {
  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  if (
    body.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(body) ||
    body.includes("\\") ||
    body.startsWith("/") ||
    /^[A-Za-z]:/u.test(body) ||
    body.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Mutagen ignore must be a safe relative pattern");
  }
}

export function compileIgnores(profilePatterns: readonly string[]): string[] {
  const compiled = new Set<string>(MANDATORY_MUTAGEN_IGNORES);
  for (const pattern of profilePatterns) {
    if (pattern.startsWith("!")) {
      throw new Error("Mutagen user ignore negation is not allowed");
    }
    assertPattern(pattern);
    compiled.add(pattern);
  }
  return [...compiled];
}

export function mutagenSessionName(consumer: string, profile: string, identity: string): string {
  if (!COMPONENT.test(consumer)) throw new Error("consumer must be a safe session component");
  if (!COMPONENT.test(profile)) throw new Error("profile must be a safe session component");
  if (!IDENTITY.test(identity)) throw new Error("identity must be exactly 24 lowercase hex characters");
  return `remote-runner-${consumer}-${profile}-${identity}`;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return !(
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/"
  );
}

function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (!isCanonicalAbsolutePath(value)) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
}

function betaEndpoint(target: string, root: string): string {
  if (!SSH_TARGET.test(target) || target.startsWith("-")) {
    throw new Error("Mutagen SSH target must be a safe user and host pair");
  }
  assertCanonicalAbsolutePath(root, "Mutagen beta root");
  return `${target}:${root}`;
}

function validateOptions(options: MutagenSessionOptions): ValidatedSession {
  const name = mutagenSessionName(options.consumer, options.profile, options.identity);
  assertCanonicalAbsolutePath(options.canonicalAlphaRoot, "Mutagen alpha root");
  return {
    name,
    alpha: options.canonicalAlphaRoot,
    beta: betaEndpoint(options.betaTarget, options.betaRoot),
    ignores: compileIgnores(options.ignores),
  };
}

function validateTerminationOptions(
  options: Pick<MutagenSessionOptions, "consumer" | "profile" | "identity" | "betaTarget" | "betaRoot">,
): ValidatedTermination {
  return {
    name: mutagenSessionName(options.consumer, options.profile, options.identity),
    beta: betaEndpoint(options.betaTarget, options.betaRoot),
  };
}

function bounded(result: BoundedProcessResult, label: string): void {
  if (result.outputTruncated || result.stdout.byteLength > CAPTURE_BYTES || result.stderr.byteLength > CAPTURE_BYTES) {
    throw new Error(`${label} exceeded the process output limit`);
  }
}

function decode(contents: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
}

function parseListing(contents: Uint8Array): SessionRecord[] {
  const output = decode(contents, "Mutagen session list");
  if (output.length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new DiagnosableError("Mutagen session list returned malformed JSON");
  }
  if (!Array.isArray(value)) throw new DiagnosableError("Mutagen session list must return a JSON array");
  // Mirrors Mutagen's public Session JSON emitted by sync/list.go via `{{ json . }}`.
  return value.map((item) => {
    if (!isRecord(item) || !text(item.identifier) || !text(item.name) || typeof item.paused !== "boolean")
      throw new DiagnosableError("Mutagen session list returned a malformed session");
    const alpha = endpointText(item.alpha);
    const betaValue = endpointText(item.beta);
    const mode = text(item.mode) ? item.mode : nestedText(item.configuration, "synchronizationMode");
    const ignores = nestedStringArray(item.ignore, "paths");
    const conflicts = item.conflicts === undefined ? [] : item.conflicts;
    const excludedConflicts = item.excludedConflicts === undefined ? 0 : item.excludedConflicts;
    if (!Array.isArray(conflicts) || !Number.isSafeInteger(excludedConflicts) || Number(excludedConflicts) < 0)
      throw new DiagnosableError("Mutagen session list returned malformed conflict state");
    if (item.status !== undefined && typeof item.status !== "string")
      throw new DiagnosableError("Mutagen session list returned malformed status");
    if (!item.paused && !text(item.status)) throw new DiagnosableError("active Mutagen session is missing status");
    return {
      identifier: item.identifier,
      name: item.name,
      alpha,
      beta: betaValue,
      mode,
      ignores,
      paused: item.paused,
      ...(item.status === undefined ? {} : { status: item.status }),
      conflicts: conflicts.length,
      excludedConflicts: Number(excludedConflicts),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function nestedText(value: unknown, key: string): string {
  if (!isRecord(value) || !text(value[key]))
    throw new DiagnosableError("Mutagen session list returned a malformed endpoint or configuration");
  return value[key];
}

function nestedStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key]) || !value[key].every(text)) {
    throw new DiagnosableError("Mutagen session list returned malformed ignore configuration");
  }
  return [...value[key]];
}

function endpointText(value: unknown): string {
  if (!isRecord(value))
    throw new DiagnosableError("Mutagen session list returned a malformed endpoint or configuration");
  if (text(value.url)) return value.url;
  if (value.protocol === "local" && text(value.path)) return value.path;
  if (value.protocol === "ssh" && text(value.host) && text(value.path)) {
    if (value.user !== undefined && !text(value.user)) {
      throw new DiagnosableError("Mutagen session list returned a malformed endpoint or configuration");
    }
    return `${value.user === undefined ? "" : `${value.user}@`}${value.host}:${value.path}`;
  }
  throw new DiagnosableError("Mutagen session list returned a malformed endpoint or configuration");
}

function statusKind(record: SessionRecord): "paused" | "healthy" | "recoverable" | "conflict" {
  if (record.conflicts > 0 || record.excludedConflicts > 0) return "conflict";
  if (record.paused) return "paused";
  const status = record.status!;
  if (status === "disconnected" || status.startsWith("halted-")) return "recoverable";
  if (
    [
      "watching",
      "scanning",
      "waiting-for-rescan",
      "reconciling",
      "staging-alpha",
      "staging-beta",
      "transitioning",
      "saving",
      "connecting-alpha",
      "connecting-beta",
    ].includes(status)
  )
    return "healthy";
  throw new Error(`Mutagen session has unrecognized status: ${status}`);
}

function ignoresMatch(record: SessionRecord, expected: { readonly ignores: readonly string[] }): boolean {
  return (
    record.ignores.length === expected.ignores.length &&
    expected.ignores.every((pattern) => record.ignores.includes(pattern))
  );
}

function assertOwnedRecord(record: SessionRecord, expected: ValidatedSession, repairableIgnores = false): void {
  if (record.alpha !== expected.alpha || record.beta !== expected.beta) {
    throw new DiagnosableError("Mutagen session endpoint mismatch");
  }
  if (record.mode !== "one-way-replica") throw new DiagnosableError("Mutagen session mode mismatch");
  /* Tolerated only before the pause, where drift is still repairable by recreation: once a
     descriptor is prepared, a session swapped in under the owned name must never sync under
     exclusions this run did not compile. */
  if (!repairableIgnores && !ignoresMatch(record, expected)) {
    throw new DiagnosableError("Mutagen session ignore mismatch");
  }
}

export interface OwnedSessionExpectation {
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly canonicalAlphaRoot: string;
  readonly betaTarget: string;
  /* Absolute only. Diagnostics cannot resolve the remote `$HOME` themselves, and a suffix match
     against a home-relative root would accept any prefix — the very false green this probe exists to
     remove — so an endpoint that could not be resolved is reported as unverified instead. */
  readonly betaRoot?: string;
  readonly ignores: readonly string[];
}

export interface OwnedSessionObservation {
  readonly status: "ok" | "warn" | "fail";
  readonly detail?: string;
}

/* `mutagen sync list <name>` exiting 0 only proves a session with the owned NAME exists — it was
   green through an incident where every run failed at sync-pause. This applies the same rules the
   run applies before pausing, minus ignore drift, which the run now repairs by recreation. */
export function inspectOwnedSession(listing: Uint8Array, expected: OwnedSessionExpectation): OwnedSessionObservation {
  try {
    const name = mutagenSessionName(expected.consumer, expected.profile, expected.identity);
    assertCanonicalAbsolutePath(expected.canonicalAlphaRoot, "Mutagen alpha root");
    const matches = parseListing(listing).filter((record) => record.name === name);
    if (matches.length > 1) throw new DiagnosableError("multiple Mutagen sessions have the owned name");
    const record = matches[0];
    /* A missing session is the normal state before the first run and after retention: the next run
       creates it. */
    if (!record) return { status: "ok" };
    const beta = expected.betaRoot === undefined ? undefined : betaEndpoint(expected.betaTarget, expected.betaRoot);
    if (record.alpha !== expected.canonicalAlphaRoot || (beta !== undefined && record.beta !== beta)) {
      throw new DiagnosableError("Mutagen session endpoint mismatch");
    }
    if (record.mode !== "one-way-replica") throw new DiagnosableError("Mutagen session mode mismatch");
    const kind = statusKind(record);
    if (kind === "conflict") throw new DiagnosableError("Mutagen session has conflicts");
    /* Both states are repaired by the next run recreating the session, so neither is a failure —
       but until then the session is not synchronizing, or is excluding the pre-drift set: a path
       added to the manifest because it is sensitive is still being synchronized right now. */
    if (kind === "recoverable") {
      return { status: "warn", detail: "Mutagen session is disconnected; the next run recreates it" };
    }
    if (!ignoresMatch(record, { ignores: compileIgnores(expected.ignores) })) {
      return { status: "warn", detail: "Mutagen session ignores drifted; the next run recreates it" };
    }
    if (beta === undefined) return { status: "warn", detail: "Mutagen beta endpoint unverified" };
    return { status: "ok" };
  } catch (caught) {
    return { status: "fail", detail: diagnosableMessage(caught) ?? "Mutagen session inspection failed" };
  }
}

export interface AbandonedSessionSweep {
  readonly clientId: string;
  readonly consumer: string;
  readonly profile: string;
  readonly betaTarget: string;
  readonly profileRoot: string;
  /* Answers false ONLY for a root that is genuinely gone. Every other filesystem answer — permission
     denied, an unreachable mount — must read as present: absence is what terminates a session, so an
     unanswerable path has to keep it alive. */
  alphaExists(root: string): Promise<boolean>;
}

function assertOwnedTerminationRecord(record: SessionRecord, expected: ValidatedTermination): void {
  assertCanonicalAbsolutePath(record.alpha, "Mutagen alpha root");
  if (record.beta !== expected.beta) throw new DiagnosableError("Mutagen session endpoint mismatch");
  if (record.mode !== "one-way-replica") throw new DiagnosableError("Mutagen session mode mismatch");
}

export class MutagenSyncLifecycle {
  private readonly descriptors = new WeakMap<object, DescriptorState>();
  constructor(
    private readonly processes: MutagenProcessRuntime,
    private readonly clock: MonotonicClock,
  ) {}

  private async run(args: readonly string[], label: string): Promise<BoundedProcessResult> {
    const result = await this.processes.run({
      command: "mutagen",
      args,
      maxOutputBytes: CAPTURE_BYTES,
    });
    bounded(result, label);
    return result;
  }

  private async checked(args: readonly string[], label: string): Promise<void> {
    const result = await this.run(args, label);
    if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
  }

  private async listOwned(expected: ValidatedSession, repairableIgnores = false): Promise<SessionRecord | undefined> {
    const result = await this.run(MUTAGEN_LIST_ARGUMENTS, "Mutagen session list");
    if (result.exitCode !== 0) {
      throw new DiagnosableError("Mutagen session list failed");
    }
    const matches = parseListing(result.stdout).filter(({ name }) => name === expected.name);
    if (matches.length > 1) throw new DiagnosableError("multiple Mutagen sessions have the owned name");
    const match = matches[0];
    if (match) assertOwnedRecord(match, expected, repairableIgnores);
    return match;
  }

  async terminateOwned(
    options: Pick<MutagenSessionOptions, "consumer" | "profile" | "identity" | "betaTarget" | "betaRoot">,
  ): Promise<void> {
    const expected = validateTerminationOptions(options);
    const result = await this.run(MUTAGEN_LIST_ARGUMENTS, "Mutagen session list");
    if (result.exitCode !== 0) {
      throw new DiagnosableError("Mutagen session list failed");
    }
    const matches = parseListing(result.stdout).filter(({ name }) => name === expected.name);
    if (matches.length > 1) throw new DiagnosableError("multiple Mutagen sessions have the owned name");
    const match = matches[0];
    if (!match) return;
    assertOwnedTerminationRecord(match, expected);
    await this.checked(["sync", "terminate", expected.name], "Mutagen session retention terminate");
  }

  /* One session exists per local worktree. Every other path that terminates one — retention, and the
     drift and disconnect recoveries below — acts on the identity that is currently running, and none
     of them ever asks whether a session's ALPHA is still on disk, so deleting a worktree leaks its
     session for good (6 of 18 live sessions on the author's laptop, 2026-08-05). A completed remote
     run cannot know a sibling identity's remote state, but it can see that the sibling's local root
     is gone, so it sweeps its own namespace. */
  async terminateAbandoned(sweep: AbandonedSessionSweep): Promise<void> {
    const result = await this.run(MUTAGEN_LIST_ARGUMENTS, "Mutagen session list");
    if (result.exitCode !== 0) throw new DiagnosableError("Mutagen session list failed");
    const listing = parseListing(result.stdout);
    /* A duplicated name means the evidence cannot be attributed: one of the twins may belong to a live
       worktree. The run path refuses an ambiguous owned name outright; a sweep skips just that name,
       leaving the rest of the namespace reapable. */
    const ambiguous = new Set(
      listing
        .filter(({ name }, index) => listing.findIndex((other) => other.name === name) !== index)
        .map(({ name }) => name),
    );
    let failures = 0;
    for (const record of listing) {
      const identity = record.name.slice(record.name.lastIndexOf("-") + 1);
      if (
        ambiguous.has(record.name) ||
        !IDENTITY.test(identity) ||
        record.name !== mutagenSessionName(sweep.consumer, sweep.profile, identity)
      ) {
        continue;
      }
      /* An owned NAME is not an owned session, and this branch terminates. The identity is the sha256
         of the alpha root the creating run canonicalized (`worktreeIdentity`), and Mutagen echoes that
         path back verbatim — checked against all 11 live sessions on this laptop, 2026-08-05 — so a
         record whose own alpha does not derive its identity was never created by this runner for it,
         whatever the name claims. Endpoint, mode and a probeable canonical alpha are checked for the
         same reason: the sweep reconstructs the expectation instead of receiving it. */
      if (
        pathIdentity(record.alpha, sweep.clientId) !== identity ||
        record.beta !== betaEndpoint(sweep.betaTarget, posix.join(sweep.profileRoot, identity)) ||
        record.mode !== "one-way-replica" ||
        !isCanonicalAbsolutePath(record.alpha) ||
        !SESSION_IDENTIFIER.test(record.identifier)
      ) {
        continue;
      }
      if (await sweep.alphaExists(record.alpha)) continue;
      try {
        /* By identifier, never by name. A name is a slot: between this listing and this command another
           run of the same profile can recreate the worktree at that path and create a live session
           under the same name — the profile lock is released the moment the workload's child starts,
           long before this sweep runs — and terminating by name would kill that new session on evidence
           gathered about the old one. An identifier belongs to one session for its lifetime, so the
           worst case becomes a command that matches nothing. */
        await this.checked(["sync", "terminate", record.identifier], "Mutagen abandoned session terminate");
      } catch {
        /* One refusal — a session terminated by hand since the listing, a daemon that dropped it — must
           not strand every later orphan until the next run; the count is reported after the sweep. */
        failures += 1;
      }
    }
    if (failures > 0) throw new Error(`${failures} abandoned Mutagen session terminations failed`);
  }

  private createArguments(session: ValidatedSession, paused: boolean): string[] {
    return [
      "sync",
      "create",
      "--name",
      session.name,
      "--sync-mode",
      "one-way-replica",
      ...(paused ? ["--paused"] : []),
      ...session.ignores.flatMap((pattern) => ["--ignore", pattern]),
      "--",
      session.alpha,
      session.beta,
    ];
  }

  private async create(session: ValidatedSession, paused = false): Promise<void> {
    await this.checked(this.createArguments(session, paused), "Mutagen session create");
  }

  async pauseForGitReconcile(options: MutagenSessionOptions): Promise<PausedMutagenSession> {
    const expected = validateOptions(options);
    await this.checked(["daemon", "start"], "Mutagen daemon start");
    let existing = await this.listOwned(expected, true);
    if (existing && statusKind(existing) === "conflict") {
      throw new DiagnosableError("Mutagen session has conflicts");
    }
    /* Mutagen cannot reconfigure a live session, so a manifest ignore edit is repaired by
       recreating it; a session left disconnected by a laptop sleep or a remote reboot is repaired
       the same way resumeAndFlush already repairs it. Failing closed on either would make every
       later run unavailable instead. */
    if (existing && (statusKind(existing) === "recoverable" || !ignoresMatch(existing, expected))) {
      await this.checked(["sync", "terminate", expected.name], "Mutagen session drift or recovery terminate");
      existing = undefined;
    }
    if (!existing) await this.create(expected, true);
    else if (statusKind(existing) !== "paused") {
      await this.checked(["sync", "pause", expected.name], "Mutagen session pause");
    }
    const descriptor = {} as PausedMutagenSession;
    this.descriptors.set(descriptor, { session: expected, used: false });
    return descriptor;
  }

  private async flushAndInspect(
    expected: ValidatedSession,
  ): Promise<{ readonly record: SessionRecord; readonly flushSucceeded: boolean }> {
    const flush = await this.run(["sync", "flush", expected.name], "Mutagen session flush");
    const record = await this.listOwned(expected);
    if (!record) throw new Error("owned Mutagen session disappeared after flush");
    return { record, flushSucceeded: flush.exitCode === 0 };
  }

  async resumeAndFlush(descriptor: PausedMutagenSession): Promise<MutagenFlushResult> {
    const state = this.descriptors.get(descriptor);
    if (!state || state.used) throw new Error("invalid or already-consumed Mutagen session descriptor");
    state.used = true;
    const resume = await this.run(["sync", "resume", state.session.name], "Mutagen session resume");
    let recoverBeforeFlush = false;
    if (resume.exitCode !== 0) {
      const record = await this.listOwned(state.session);
      if (!record || statusKind(record) !== "recoverable") {
        throw new Error(`Mutagen session resume failed with exit code ${resume.exitCode}`);
      }
      recoverBeforeFlush = true;
    }
    const startedAt = this.clock.now();
    if (recoverBeforeFlush) {
      await this.checked(["sync", "terminate", state.session.name], "Mutagen session recovery terminate");
      await this.create(state.session);
    }
    let outcome = await this.flushAndInspect(state.session);
    let kind = statusKind(outcome.record);
    if (kind === "conflict") throw new Error("Mutagen session has conflicts after flush");
    if (kind === "recoverable" && !recoverBeforeFlush) {
      await this.checked(["sync", "terminate", state.session.name], "Mutagen session recovery terminate");
      await this.create(state.session);
      outcome = await this.flushAndInspect(state.session);
      kind = statusKind(outcome.record);
    }
    if (recoverBeforeFlush || kind === "recoverable") {
      if (kind === "recoverable") throw new Error("Mutagen session recovery did not reconnect");
      if (kind === "conflict") throw new Error("Mutagen session recovery produced conflicts");
      if (!outcome.flushSucceeded) throw new Error("Mutagen session recovery flush failed");
    } else if (!outcome.flushSucceeded) {
      throw new Error("Mutagen session flush failed");
    }
    if (kind !== "healthy") throw new Error("Mutagen session is not active after flush");
    const finishedAt = this.clock.now();
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      throw new Error("monotonic clock returned invalid readings");
    }
    const result = {
      session: descriptor,
      flushDurationMs: finishedAt - startedAt,
    };
    return result;
  }
}
