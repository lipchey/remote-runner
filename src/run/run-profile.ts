import type { Profile, RunMode } from "../config/types.js";
import type { PrepareResult } from "./prepare.js";

export const INFRASTRUCTURE_EXIT_CODE = 75;
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
      return INFRASTRUCTURE_EXIT_CODE;
    }
    if (prepared.ok || !prepared.retryable) break;
  }
  if (prepared === undefined || !prepared.ok) {
    return mayFallback(mode, profile) ? runLocal(runtime, command) : INFRASTRUCTURE_EXIT_CODE;
  }

  let childStarted = false;
  let remote: RemoteExecutionResult;
  try {
    remote = await runtime.startRemote(command, prepared.secrets, async () => {
      if (childStarted) return;
      childStarted = true;
      await prepared.release();
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
      return INFRASTRUCTURE_EXIT_CODE;
    }
    if (childStarted) return INFRASTRUCTURE_EXIT_CODE;
    return mayFallback(mode, profile) ? runLocal(runtime, command) : INFRASTRUCTURE_EXIT_CODE;
  }

  if (!childStarted) {
    try {
      await prepared.release();
    } catch {
      /* already failing closed */
    }
    return INFRASTRUCTURE_EXIT_CODE;
  }
  return validExitCode(remote.exitCode) ? remote.exitCode : INFRASTRUCTURE_EXIT_CODE;
}
