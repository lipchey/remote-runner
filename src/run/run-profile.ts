import type { Profile, RunMode } from "../config/types.js";
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
  runLocal(command: readonly string[]): Promise<number>;
  /* Announces the outage a fallback run would have announced. Without it the notification would
     ride on runLocal alone, so a profile declaring `fallback: fail` — or any run pinned to
     `mode: remote` — would exit 75 with the remote down and no alert anywhere. */
  failClosed(): Promise<void>;
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

async function runLocal(runtime: RunProfileRuntime, command: readonly string[]): Promise<number> {
  try {
    const code = await runtime.runLocal(command);
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

function mayFallback(mode: RunMode, profile: Pick<Profile, "fallback">): boolean {
  return mode === "auto" && profile.fallback === "local";
}

export async function runProfile(
  runtime: RunProfileRuntime,
  profile: Pick<Profile, "mode" | "fallback">,
  command: readonly string[],
  modeOverride?: RunMode,
): Promise<number> {
  if (!validCommand(command)) return USAGE_EXIT_CODE;
  const mode = modeOverride ?? profile.mode;
  if (mode === "local") return runLocal(runtime, command);

  let prepared: PrepareResult | undefined;
  for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt += 1) {
    try {
      prepared = await runtime.prepareRemote();
    } catch {
      return failClosed(runtime);
    }
    if (prepared.ok || !prepared.retryable) break;
  }
  if (prepared === undefined || !prepared.ok) {
    /* A lock failure means another run of THIS workspace is already doing the work. Running it
       again locally is precisely the duplicate the wait exists to prevent, so contention fails
       closed instead of falling back. These reasons are also kept off the outage channel, but by
       `LOCAL_REASONS` in notifications/outage.ts — this list decides the local run only, so a
       reason added here must be added there too or it starts paging the operator. */
    const localIsPointless =
      prepared?.ok === false && (prepared.reason === LOCK_REASON || prepared.reason === CONSUMER_SETUP_REASON);
    return mayFallback(mode, profile) && !localIsPointless ? runLocal(runtime, command) : failClosed(runtime);
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
    return INFRASTRUCTURE_EXIT_CODE;
  }

  if (remote.kind === "not-started") {
    try {
      await prepared.release();
    } catch {
      /* The child never started and the reason is already pending, so a release that fails on top
         of it must not swallow the alert — that is the same silence on a different path. */
      return failClosed(runtime);
    }
    if (childStarted) return INFRASTRUCTURE_EXIT_CODE;
    if (remote.reason === WORKLOAD_COMMAND_REASON) return WORKLOAD_COMMAND_EXIT_CODE;
    return mayFallback(mode, profile) ? runLocal(runtime, command) : failClosed(runtime);
  }

  if (!childStarted) {
    try {
      await prepared.release();
    } catch {
      /* already failing closed */
    }
    return INFRASTRUCTURE_EXIT_CODE;
  }
  if (releaseDeferred) {
    try {
      await prepared.release();
    } catch {
      /* Nothing is running any more, so the workload's exit code stands; the lock is left for the
         next acquirer's dead-owner takeover. */
    }
  }
  return validExitCode(remote.exitCode) ? remote.exitCode : INFRASTRUCTURE_EXIT_CODE;
}
