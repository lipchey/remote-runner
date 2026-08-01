import { posix } from "node:path";

import { parseDocument } from "yaml";

import type { EnvironmentIdentity } from "./fingerprint.js";

const PACKAGE_MANAGER = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface HealthySetupState {
  readonly fingerprint: string;
  readonly environment: EnvironmentIdentity;
}

export interface DependencySetupRuntime {
  readHealthyState(): Promise<HealthySetupState | undefined>;
  runSetup(
    script: string,
    workspaceRoot: string,
    environment: EnvironmentIdentity,
  ): Promise<{ readonly exitCode: number }>;
  runEnsure(
    command: readonly string[],
    workspaceRoot: string,
    environment: EnvironmentIdentity,
  ): Promise<{ readonly exitCode: number }>;
  writeHealthyState(state: HealthySetupState): Promise<void>;
}

export interface DependencySetupInput extends HealthySetupState {
  readonly workspaceRoot: string;
  readonly setup: readonly string[];
  readonly ensure: readonly (readonly string[])[];
}

export interface SetupResult extends HealthySetupState {
  readonly setupRan: boolean;
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
  return (
    left.node === right.node &&
    left.packageManager === right.packageManager &&
    left.uv === right.uv &&
    left.gitleaks === right.gitleaks
  );
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

async function runSetup(runtime: DependencySetupRuntime, input: DependencySetupInput): Promise<void> {
  for (const script of input.setup) {
    const result = await runtime.runSetup(script, input.workspaceRoot, input.environment);
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      throw new Error(`dependency setup ${script} failed with exit code ${String(result.exitCode)}`);
    }
  }
}

async function runEnsure(
  runtime: DependencySetupRuntime,
  input: DependencySetupInput,
  failClosed: boolean,
): Promise<boolean> {
  for (const command of input.ensure) {
    let result: { readonly exitCode: number };
    try {
      result = await runtime.runEnsure(command, input.workspaceRoot, input.environment);
    } catch (caught) {
      if (failClosed) throw new Error(`dependency ensure ${command[0]} failed`, { cause: caught });
      return false;
    }
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      if (failClosed) {
        throw new Error(`dependency ensure ${command[0]} failed with exit code ${String(result.exitCode)}`);
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
    if (await runEnsure(runtime, input, false)) {
      return { fingerprint: input.fingerprint, environment: input.environment, setupRan: false };
    }
  }
  await runSetup(runtime, input);
  await runEnsure(runtime, input, true);
  const healthy = { fingerprint: input.fingerprint, environment: input.environment };
  await runtime.writeHealthyState(healthy);
  return { ...healthy, setupRan: true };
}
