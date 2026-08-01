import { posix } from "node:path";

import type { BoundedProcessRequest, BoundedProcessResult } from "../ssh/client.js";

const CAPTURE_BYTES = 64 * 1024;
const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const IDENTITY = /^[0-9a-f]{24}$/u;
const SSH_TARGET = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/u;
const LIST_TEMPLATE = "{{ json . }}";

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

function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/"
  ) {
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
    throw new Error("Mutagen session list returned malformed JSON");
  }
  if (!Array.isArray(value)) throw new Error("Mutagen session list must return a JSON array");
  // Mirrors Mutagen's public Session JSON emitted by sync/list.go via `{{ json . }}`.
  return value.map((item) => {
    if (!isRecord(item) || !text(item.identifier) || !text(item.name) || typeof item.paused !== "boolean")
      throw new Error("Mutagen session list returned a malformed session");
    const alpha = endpointText(item.alpha);
    const betaValue = endpointText(item.beta);
    const mode = text(item.mode) ? item.mode : nestedText(item.configuration, "synchronizationMode");
    const ignores = nestedStringArray(item.ignore, "paths");
    const conflicts = item.conflicts === undefined ? [] : item.conflicts;
    const excludedConflicts = item.excludedConflicts === undefined ? 0 : item.excludedConflicts;
    if (!Array.isArray(conflicts) || !Number.isSafeInteger(excludedConflicts) || Number(excludedConflicts) < 0)
      throw new Error("Mutagen session list returned malformed conflict state");
    if (item.status !== undefined && typeof item.status !== "string")
      throw new Error("Mutagen session list returned malformed status");
    if (!item.paused && !text(item.status)) throw new Error("active Mutagen session is missing status");
    return {
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
    throw new Error("Mutagen session list returned a malformed endpoint or configuration");
  return value[key];
}

function nestedStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key]) || !value[key].every(text)) {
    throw new Error("Mutagen session list returned malformed ignore configuration");
  }
  return [...value[key]];
}

function endpointText(value: unknown): string {
  if (!isRecord(value)) throw new Error("Mutagen session list returned a malformed endpoint or configuration");
  if (text(value.url)) return value.url;
  if (value.protocol === "local" && text(value.path)) return value.path;
  if (value.protocol === "ssh" && text(value.host) && text(value.path)) {
    if (value.user !== undefined && !text(value.user)) {
      throw new Error("Mutagen session list returned a malformed endpoint or configuration");
    }
    return `${value.user === undefined ? "" : `${value.user}@`}${value.host}:${value.path}`;
  }
  throw new Error("Mutagen session list returned a malformed endpoint or configuration");
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

function assertOwnedRecord(record: SessionRecord, expected: ValidatedSession): void {
  if (record.alpha !== expected.alpha || record.beta !== expected.beta) {
    throw new Error("Mutagen session endpoint mismatch");
  }
  if (record.mode !== "one-way-replica") throw new Error("Mutagen session mode mismatch");
  if (
    record.ignores.length !== expected.ignores.length ||
    !expected.ignores.every((pattern) => record.ignores.includes(pattern))
  ) {
    throw new Error("Mutagen session ignore mismatch");
  }
}

function assertOwnedTerminationRecord(record: SessionRecord, expected: ValidatedTermination): void {
  assertCanonicalAbsolutePath(record.alpha, "Mutagen alpha root");
  if (record.beta !== expected.beta) throw new Error("Mutagen session endpoint mismatch");
  if (record.mode !== "one-way-replica") throw new Error("Mutagen session mode mismatch");
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

  private async listOwned(expected: ValidatedSession): Promise<SessionRecord | undefined> {
    const result = await this.run(["sync", "list", "--template", LIST_TEMPLATE], "Mutagen session list");
    if (result.exitCode !== 0) {
      throw new Error(`Mutagen session list failed with exit code ${result.exitCode}`);
    }
    const matches = parseListing(result.stdout).filter(({ name }) => name === expected.name);
    if (matches.length > 1) throw new Error("multiple Mutagen sessions have the owned name");
    const match = matches[0];
    if (match) assertOwnedRecord(match, expected);
    return match;
  }

  async terminateOwned(
    options: Pick<MutagenSessionOptions, "consumer" | "profile" | "identity" | "betaTarget" | "betaRoot">,
  ): Promise<void> {
    const expected = validateTerminationOptions(options);
    const result = await this.run(["sync", "list", "--template", LIST_TEMPLATE], "Mutagen session list");
    if (result.exitCode !== 0) {
      throw new Error(`Mutagen session list failed with exit code ${result.exitCode}`);
    }
    const matches = parseListing(result.stdout).filter(({ name }) => name === expected.name);
    if (matches.length > 1) throw new Error("multiple Mutagen sessions have the owned name");
    const match = matches[0];
    if (!match) return;
    assertOwnedTerminationRecord(match, expected);
    await this.checked(["sync", "terminate", expected.name], "Mutagen session retention terminate");
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
    const existing = await this.listOwned(expected);
    if (!existing) await this.create(expected, true);
    if (existing && statusKind(existing) === "conflict") {
      throw new Error("Mutagen session has conflicts");
    }
    if (existing && statusKind(existing) === "recoverable") {
      throw new Error("Mutagen session is disconnected before Git reconciliation");
    }
    if (existing && statusKind(existing) !== "paused") {
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
