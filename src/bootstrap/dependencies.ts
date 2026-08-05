import { posix } from "node:path";

import { parseDocument } from "yaml";

import { DiagnosableError } from "../runtime/diagnostic.js";

import type { EnvironmentIdentity } from "./fingerprint.js";

const PACKAGE_MANAGER = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface HealthySetupState {
  readonly fingerprint: string;
  readonly environment: EnvironmentIdentity;
}

/* `spawned` is the transport's, not the remote command's: false means the local ssh client never
   started, so `exitCode` was manufactured here and proves nothing about what ran remotely. Carried
   this far because attribution below turns on it — a code alone cannot say "never ran". */
export interface DependencyCommandResult {
  readonly exitCode: number;
  readonly spawned: boolean;
}

export interface DependencySetupRuntime {
  readHealthyState(): Promise<HealthySetupState | undefined>;
  checkArtifact?(artifact: string, workspaceRoot: string): Promise<DependencyCommandResult>;
  runSetup(script: string, workspaceRoot: string, environment: EnvironmentIdentity): Promise<DependencyCommandResult>;
  runEnsure(
    command: readonly string[],
    workspaceRoot: string,
    environment: EnvironmentIdentity,
  ): Promise<DependencyCommandResult>;
  writeHealthyState(state: HealthySetupState): Promise<void>;
}

export interface DependencySetupInput extends HealthySetupState {
  readonly workspaceRoot: string;
  readonly setup: readonly string[];
  readonly artifacts?: readonly string[];
  readonly ensure: readonly (readonly string[])[];
}

export interface SetupResult extends HealthySetupState {
  readonly setupRan: boolean;
}

/* The remote RAN the consumer's own setup/ensure command and it exited non-zero. That is the
   consumer's error, not the remote's: it fails identically in a local fallback run and says nothing
   about the workstation being reachable, so the caller classifies it away from `bootstrap`.
   Raised only where an exit code was actually observed — a runtime call that throws never got one,
   and a transport that died mid-command is a genuine remote failure.
   Diagnosable because the message interpolates only a manifest-authored script or command name and
   a number: no remote output, no provider output, no native error text. Without it the whole class
   reaches the operator as one bare `reason=consumer-setup` line naming nothing to act on. */
export class DependencyCommandError extends DiagnosableError {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "DependencyCommandError";
  }
}

/* Blaming the consumer silences the outage notification AND skips the local fallback, so this is an
   ALLOW-LIST of codes that PROVE the remote shell ran the consumer's own command and it failed.
   Stated as what is admitted, never as "everything except X": the wide form is what once admitted a
   code no remote command had emitted.
   Admitted: 1..124, the command's own failure status, and only after `spawned` has established that
   an exit code was observed at all.
   Excluded: 0 is not a failure; 125 is the workspace wrapper's own `cd` failure (see
   remoteWorkspaceCommandArguments — a remote workspace that vanished); 128..255 covers ssh's own 255
   and any client killed by a signal.
   126/127 are excluded too, although the remote shell does emit them: setup scripts live INSIDE the
   synced workspace and ensure commands resolve through toolchain roots under it, so "not found" and
   "not executable" there describe a sync Mutagen did not deliver, a lost exec bit, or a toolchain a
   retention prune erased — while the local checkout still holds the file. That is the same
   attribution the artifact postcondition below refuses for its own 1, and for the same reason:
   blaming the consumer withholds the fallback run that would have succeeded.
   Each exclusion resolves toward alerting, which costs a spurious fallback rather than a silenced
   outage. */
const LAST_CONSUMER_EXIT_CODE = 124;

function commandFailure(command: string, result: DependencyCommandResult, message: string): Error {
  const { exitCode } = result;
  return result.spawned && Number.isSafeInteger(exitCode) && exitCode >= 1 && exitCode <= LAST_CONSUMER_EXIT_CODE
    ? new DependencyCommandError(command, exitCode, message)
    : new Error(message);
}

function safeRelative(value: string): boolean {
  const candidate = value.startsWith("./") ? value.slice(2) : value;
  return (
    candidate.length > 0 &&
    !candidate.startsWith("/") &&
    !candidate.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(candidate) &&
    !/^[A-Za-z]:/u.test(candidate) &&
    candidate.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sameEnvironment(left: EnvironmentIdentity, right: EnvironmentIdentity): boolean {
  return left.node === right.node && left.packageManager === right.packageManager && left.uv === right.uv;
}

export function packageManagerFromPackageJson(contents: Uint8Array): string {
  if (contents.byteLength > 1024 * 1024) throw new Error("package.json exceeds the bootstrap limit");
  const text = decoder.decode(contents);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (caught) {
    throw new Error("package.json must be strict JSON", { cause: caught });
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`package.json is invalid: ${document.errors[0]!.message}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("package.json must be an object");
  }
  const packageManager = (value as { readonly packageManager?: unknown }).packageManager;
  if (typeof packageManager !== "string" || !PACKAGE_MANAGER.test(packageManager)) {
    throw new Error("package.json packageManager must be an exact package@version specifier");
  }
  return packageManager;
}

function validate(input: DependencySetupInput): void {
  if (!/^sha256:[^\u0000\s]+$/u.test(input.fingerprint)) throw new Error("dependency fingerprint is invalid");
  if (
    !posix.isAbsolute(input.workspaceRoot) ||
    input.workspaceRoot === "/" ||
    posix.normalize(input.workspaceRoot) !== input.workspaceRoot ||
    /[\u0000-\u001f\u007f]/u.test(input.workspaceRoot)
  ) {
    throw new Error("workspace root must be a safe canonical absolute path");
  }
  for (const script of input.setup)
    if (!safeRelative(script)) throw new Error("setup script must be a safe relative path");
  for (const artifact of input.artifacts ?? [])
    if (!safeRelative(artifact)) throw new Error("bootstrap artifact must be a safe relative path");
  for (const command of input.ensure) {
    if (
      command.length === 0 ||
      command[0] === undefined ||
      command[0].length === 0 ||
      command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    ) {
      throw new Error("ensure command must be a non-empty safe argument array");
    }
  }
  for (const [name, value] of Object.entries(input.environment)) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`environment identity ${name} is invalid`);
    }
  }
}

async function checkArtifacts(
  runtime: DependencySetupRuntime,
  input: DependencySetupInput,
  failClosed: boolean,
): Promise<boolean> {
  const artifacts = input.artifacts ?? [];
  if (artifacts.length === 0) return true;
  if (runtime.checkArtifact === undefined) {
    throw new Error("bootstrap artifact inspection runtime is unavailable");
  }
  for (const artifact of artifacts) {
    let result: DependencyCommandResult;
    try {
      result = await runtime.checkArtifact(artifact, input.workspaceRoot);
    } catch (caught) {
      throw new Error(`bootstrap artifact inspection failed: ${artifact}`, { cause: caught });
    }
    /* The exit code of a client that never started means NOTHING, whatever it is: Node reports the
       negative errno on close (-2 ENOENT, -24 EMFILE), and nothing pins it there. So the spawn check
       comes first and unconditionally, rather than excluding whichever values happen to collide with
       `test -f`'s 0/1 today — read as an answer, a failed spawn triggers a setup rerun against a
       remote nothing can reach. */
    if (!result.spawned || !Number.isSafeInteger(result.exitCode) || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error(`bootstrap artifact inspection failed with exit code ${String(result.exitCode)}: ${artifact}`);
    }
    if (result.exitCode === 1) {
      /* This is the runner's OWN postcondition, not a consumer command that was observed exiting
         non-zero: the artifact is equally absent when the remote workspace or the sync is damaged
         while the local checkout still has it, and blaming the consumer there withholds the
         fallback for a genuine remote failure. */
      if (failClosed) throw new Error(`bootstrap artifact is still missing after setup: ${artifact}`);
      return false;
    }
  }
  return true;
}

async function runSetup(runtime: DependencySetupRuntime, input: DependencySetupInput): Promise<void> {
  for (const script of input.setup) {
    const result = await runtime.runSetup(script, input.workspaceRoot, input.environment);
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      throw commandFailure(
        script,
        result,
        `dependency setup ${script} failed with exit code ${String(result.exitCode)}`,
      );
    }
  }
}

async function runEnsure(
  runtime: DependencySetupRuntime,
  input: DependencySetupInput,
  failClosed: boolean,
): Promise<boolean> {
  for (const command of input.ensure) {
    let result: DependencyCommandResult;
    try {
      result = await runtime.runEnsure(command, input.workspaceRoot, input.environment);
    } catch (caught) {
      /* No exit code was ever observed, so nothing here says the command itself failed — the
         transport dying mid-ensure is a remote problem and keeps the plain error. */
      if (failClosed) throw new Error(`dependency ensure ${command[0]} failed`, { cause: caught });
      return false;
    }
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      if (failClosed) {
        throw commandFailure(
          command[0]!,
          result,
          `dependency ensure ${command[0]} failed with exit code ${String(result.exitCode)}`,
        );
      }
      return false;
    }
  }
  return true;
}

export async function ensureDependencySetup(
  runtime: DependencySetupRuntime,
  input: DependencySetupInput,
): Promise<SetupResult> {
  validate(input);
  const previous = await runtime.readHealthyState();
  if (previous?.fingerprint === input.fingerprint && sameEnvironment(previous.environment, input.environment)) {
    if ((await checkArtifacts(runtime, input, false)) && (await runEnsure(runtime, input, false))) {
      return { fingerprint: input.fingerprint, environment: input.environment, setupRan: false };
    }
  }
  await runSetup(runtime, input);
  await checkArtifacts(runtime, input, true);
  await runEnsure(runtime, input, true);
  const healthy = { fingerprint: input.fingerprint, environment: input.environment };
  await runtime.writeHealthyState(healthy);
  return { ...healthy, setupRan: true };
}
