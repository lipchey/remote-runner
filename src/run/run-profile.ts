import type { Profile, RunMode } from "../config/types.js";
import { stableReason } from "../notifications/outage.js";
import type { PrepareResult } from "./prepare.js";

export const INFRASTRUCTURE_EXIT_CODE = 75;
/* An unexecutable workload command is the caller's error: it fails identically on the remote and
   locally, so it must not spend a local fallback run nor raise an outage notification. */
export const WORKLOAD_COMMAND_REASON = "workload-command";
const WORKLOAD_COMMAND_EXIT_CODE = 127;
const LOCK_REASON = "lock";
/* The consumer's own setup or ensure command exiting non-zero on the remote is the caller's error
   too: it fails identically in a local run, so it neither spends a fallback nor claims the remote
   is unavailable. */
const CONSUMER_SETUP_REASON = "consumer-setup";
/* A secret collection failure is deliberately NOT in the set below. It looks like a caller error
   that repeats, but nothing in the provider contract makes an immediate second collection fail the
   same way, and since the local leg collects for itself it either recovers from a transient failure
   or fails closed there with the same reason — so withholding the fallback only loses the case it
   could have served. */
/* Reasons whose local rerun cannot do anything the remote attempt did not already do: a busy lock
   means another run of THIS workspace is doing the work, and a consumer setup command that exited
   non-zero exits the same way locally. Exported so the invariant against `LOCAL_REASONS` in
   notifications/outage.ts is CHECKED rather than kept by hand: every reason here must also be one
   that raises no outage, or it starts paging the operator about a remote that is fine. Containment
   only — `LOCAL_REASONS` answers a different question ("does this say the remote is down") and
   holds `validation` on purpose, which is no reason to skip a local run. */
export const LOCAL_RERUN_POINTLESS_REASONS: ReadonlySet<string> = new Set([
  LOCK_REASON,
  CONSUMER_SETUP_REASON,
  "account-busy",
]);
const USAGE_EXIT_CODE = 64;
const MAX_PREPARATION_ATTEMPTS = 2;

export type RemoteExecutionResult =
  { readonly kind: "completed"; readonly exitCode: number } | { readonly kind: "not-started"; readonly reason: string };

export interface RunProfileRuntime {
  prepareRemote(): Promise<PrepareResult>;
  startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ): Promise<RemoteExecutionResult>;
  /* `prepared` carries the secrets a completed preparation already collected for the remote child,
     so the run that substitutes for it carries the same values rather than a second reading of a
     source that may have moved — or failed — since. A run that never reached that step passes
     nothing and the local leg collects for itself. */
  runLocal(command: readonly string[], prepared?: Readonly<Record<string, string>>): Promise<number>;
  /* Announces the outage a fallback run would have announced. Without it the notification would
     ride on runLocal alone, so a profile declaring `fallback: fail` — or any run pinned to
     `mode: remote` — would exit 75 with the remote down and no alert anywhere. */
  failClosed(): Promise<void>;
}

export type LegResult =
  { readonly kind: "exit"; readonly status: number } | { readonly kind: "failover"; readonly reason: string };

export function isRemoteFallback(fallback: string): boolean {
  return fallback !== "local" && fallback !== "fail";
}

function validExitCode(code: number): boolean {
  return Number.isSafeInteger(code) && code >= 0 && code <= 255;
}

function validCommand(command: readonly string[]): boolean {
  return (
    command.length > 0 &&
    command[0] !== undefined &&
    command[0].length > 0 &&
    command.every((part) => typeof part === "string" && !part.includes("\0"))
  );
}

async function runLocal(
  runtime: RunProfileRuntime,
  command: readonly string[],
  prepared?: Readonly<Record<string, string>>,
): Promise<number> {
  try {
    const code = await runtime.runLocal(command, prepared);
    return validExitCode(code) ? code : INFRASTRUCTURE_EXIT_CODE;
  } catch {
    return INFRASTRUCTURE_EXIT_CODE;
  }
}

async function failClosed(runtime: RunProfileRuntime): Promise<number> {
  try {
    await runtime.failClosed();
  } catch {
    /* the run is already failing; an undeliverable alert may not change what the caller is told */
  }
  return INFRASTRUCTURE_EXIT_CODE;
}

export function mayFallback(mode: RunMode, profile: Pick<Profile, "fallback">): boolean {
  return mode === "auto" && profile.fallback === "local";
}

export async function runProfileLeg(
  runtime: RunProfileRuntime,
  profile: Pick<Profile, "mode" | "fallback">,
  command: readonly string[],
  modeOverride?: RunMode,
): Promise<LegResult> {
  if (!validCommand(command)) return { kind: "exit", status: USAGE_EXIT_CODE };
  const mode = modeOverride ?? profile.mode;
  if (mode === "local") return { kind: "exit", status: await runLocal(runtime, command) };

  let prepared: PrepareResult | undefined;
  let onlyReachabilityFailures = true;
  for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt += 1) {
    try {
      prepared = await runtime.prepareRemote();
    } catch {
      return { kind: "exit", status: await failClosed(runtime) };
    }
    if (prepared.ok) break;
    onlyReachabilityFailures &&= prepared.failureClass === "reachability";
    if (!prepared.retryable || prepared.failureClass === "security" || prepared.failureClass === "local") break;
  }
  if (prepared === undefined || !prepared.ok) {
    if (
      isRemoteFallback(profile.fallback) &&
      prepared?.ok === false &&
      prepared.failureClass === "reachability" &&
      onlyReachabilityFailures
    ) {
      return { kind: "failover", reason: stableReason(prepared.reason) };
    }
    const localIsPointless = prepared?.ok === false && LOCAL_RERUN_POINTLESS_REASONS.has(prepared.reason);
    return {
      kind: "exit",
      status:
        mayFallback(mode, profile) && !localIsPointless ? await runLocal(runtime, command) : await failClosed(runtime),
    };
  }

  let childStarted = false;
  let releaseDeferred = false;
  let remote: RemoteExecutionResult;
  try {
    remote = await runtime.startRemote(command, prepared.secrets, async () => {
      if (childStarted) return;
      childStarted = true;
      try {
        await prepared.release();
      } catch {
        /* The workload is already running. A rejection here reaches the stream as a failure and
           SIGKILLs it, so the release is deferred to after the workload instead — an early release
           failure is usually another acquirer briefly holding the operation guard. */
        releaseDeferred = true;
      }
    });
  } catch {
    try {
      await prepared.release();
    } catch {
      /* retain the authoritative failure */
    }
    return { kind: "exit", status: INFRASTRUCTURE_EXIT_CODE };
  }

  if (remote.kind === "not-started") {
    try {
      await prepared.release();
    } catch {
      /* The child never started and the reason is already pending, so a release that fails on top
         of it must not swallow the alert — that is the same silence on a different path. */
      return { kind: "exit", status: await failClosed(runtime) };
    }
    if (childStarted) return { kind: "exit", status: INFRASTRUCTURE_EXIT_CODE };
    if (remote.reason === WORKLOAD_COMMAND_REASON) return { kind: "exit", status: WORKLOAD_COMMAND_EXIT_CODE };
    const unsafeOrPointless = remote.reason === "connection-lost" || LOCAL_RERUN_POINTLESS_REASONS.has(remote.reason);
    return {
      kind: "exit",
      status:
        mayFallback(mode, profile) && !unsafeOrPointless
          ? await runLocal(runtime, command, prepared.secrets)
          : await failClosed(runtime),
    };
  }

  if (!childStarted) {
    try {
      await prepared.release();
    } catch {
      /* already failing closed */
    }
    return { kind: "exit", status: INFRASTRUCTURE_EXIT_CODE };
  }
  if (releaseDeferred) {
    try {
      await prepared.release();
    } catch {
      /* Nothing is running any more, so the workload's exit code stands; the lock is left for the
         next acquirer's dead-owner takeover. */
    }
  }
  return {
    kind: "exit",
    status: validExitCode(remote.exitCode) ? remote.exitCode : INFRASTRUCTURE_EXIT_CODE,
  };
}

export async function runProfile(
  runtime: RunProfileRuntime,
  profile: Pick<Profile, "mode" | "fallback">,
  command: readonly string[],
  modeOverride?: RunMode,
): Promise<number> {
  const result = await runProfileLeg(runtime, profile, command, modeOverride);
  return result.kind === "exit" ? result.status : INFRASTRUCTURE_EXIT_CODE;
}
