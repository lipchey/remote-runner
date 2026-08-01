import { readFile } from "node:fs/promises";
import process from "node:process";

import { loadManifestText } from "./config/load-manifest.js";
import type { Profile, RunMode } from "./config/types.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readFile(path: string): Promise<string | Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  ensureController?(): Promise<void>;
  runProfile?(profile: Profile, command: readonly string[], mode?: RunMode): Promise<number>;
  enqueuePrewarm?(profile: Profile, manifestPath: string): Promise<"published" | "coalesced">;
  statusProfile?(profile?: string): Promise<string>;
  doctorProfile?(profile?: string): Promise<unknown>;
  logsProfile?(profile?: string): Promise<readonly string[]>;
  repairProfile?(profile: string, apply: boolean): Promise<unknown>;
  benchmarkProfile?(profile: Profile): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  readFile: async (path) => readFile(path),
};

const HELP = [
  "remote-runner install",
  "remote-runner run <profile> [options] [-- <command...>]",
  "remote-runner prewarm <profile> [--manifest <path>]",
  "remote-runner validate [profile] [--manifest <path>]",
  "remote-runner status [profile]",
  "remote-runner doctor [profile]",
  "remote-runner logs [profile]",
  "remote-runner repair <profile> --dry-run|--apply",
  "remote-runner benchmark <profile>",
].join("\n");

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help") {
    io.stdout(HELP);
    return 0;
  }

  if (argv[0] === "validate") {
    return validateManifest(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "run") {
    return runSelectedProfile(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "prewarm") {
    return enqueueSelectedPrewarm(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "status" || argv[0] === "doctor" || argv[0] === "logs") {
    return runReadOnlyDiagnostic(argv[0], argv.slice(1), io, dependencies);
  }

  if (argv[0] === "repair") {
    return runRepair(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "benchmark") {
    return runBenchmarkCommand(argv.slice(1), io, dependencies);
  }

  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
}

async function runBenchmarkCommand(argv: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const profileId = argv[0];
  let manifestPath = ".remote-runner.yaml";
  if (
    profileId === undefined ||
    profileId.startsWith("-") ||
    (argv.length !== 1 && argv.length !== 3) ||
    (argv.length === 3 && (argv[1] !== "--manifest" || argv[2]?.startsWith("--")))
  ) {
    io.stderr("benchmark requires <profile> [--manifest <path>]");
    return 2;
  }
  if (argv[2] !== undefined) manifestPath = argv[2];
  let manifest;
  try {
    manifest = await readManifest(manifestPath, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`invalid manifest: ${message}`);
    return 2;
  }
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    io.stderr(`profile not found: ${profileId}`);
    return 2;
  }
  if (dependencies.benchmarkProfile === undefined) {
    io.stderr("remote-runner benchmark runtime is not configured");
    return 70;
  }
  try {
    io.stdout(JSON.stringify(await dependencies.benchmarkProfile(profile)));
    return 0;
  } catch {
    io.stderr("remote-runner benchmark failed");
    return 70;
  }
}

async function runReadOnlyDiagnostic(
  command: "status" | "doctor" | "logs",
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  if (argv.length > 1 || argv[0]?.startsWith("-")) {
    io.stderr(`${command} accepts at most one profile`);
    return 2;
  }
  const profile = argv[0];
  try {
    if (command === "status" && dependencies.statusProfile !== undefined) {
      io.stdout(await dependencies.statusProfile(profile));
      return 0;
    }
    if (command === "doctor" && dependencies.doctorProfile !== undefined) {
      io.stdout(JSON.stringify(await dependencies.doctorProfile(profile)));
      return 0;
    }
    if (command === "logs" && dependencies.logsProfile !== undefined) {
      for (const line of await dependencies.logsProfile(profile)) io.stdout(line);
      return 0;
    }
  } catch {
    io.stderr(`remote-runner ${command} failed`);
    return 70;
  }
  io.stderr(`remote-runner ${command} runtime is not configured`);
  return 70;
}

async function runRepair(argv: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const profile = argv[0];
  const mode = argv[1];
  if (
    argv.length !== 2 ||
    profile === undefined ||
    profile.startsWith("-") ||
    (mode !== "--dry-run" && mode !== "--apply")
  ) {
    io.stderr("repair requires <profile> --dry-run|--apply");
    return 2;
  }
  if (dependencies.repairProfile === undefined) {
    io.stderr("remote-runner repair runtime is not configured");
    return 70;
  }
  try {
    io.stdout(JSON.stringify(await dependencies.repairProfile(profile, mode === "--apply")));
    return 0;
  } catch {
    io.stderr("remote-runner repair failed");
    return 70;
  }
}

async function readManifest(path: string, dependencies: CliDependencies) {
  const contents = await dependencies.readFile(path);
  return loadManifestText(typeof contents === "string" ? contents : new TextDecoder().decode(contents));
}

function reportPrewarmFailure(io: CliIo): number {
  io.stderr("remote-runner prewarm failed; worktree preserved and the first manual verify will retry");
  return 0;
}

async function enqueueSelectedPrewarm(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const profileId = argv[0];
  if (
    profileId === undefined ||
    profileId.startsWith("-") ||
    (argv.length !== 1 && argv.length !== 3) ||
    (argv.length === 3 && (argv[1] !== "--manifest" || argv[2] === undefined || argv[2].startsWith("--")))
  ) {
    return reportPrewarmFailure(io);
  }
  const manifestPath = argv[2] ?? ".remote-runner.yaml";
  let manifest;
  try {
    manifest = await readManifest(manifestPath, dependencies);
  } catch {
    return reportPrewarmFailure(io);
  }
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined || dependencies.enqueuePrewarm === undefined) {
    return reportPrewarmFailure(io);
  }
  try {
    const outcome = await dependencies.enqueuePrewarm(profile, manifestPath);
    io.stdout(outcome === "published" ? `prewarm queued: ${profile.id}` : `prewarm already queued: ${profile.id}`);
    return 0;
  } catch {
    return reportPrewarmFailure(io);
  }
}

async function runSelectedProfile(argv: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const profileId = argv[0];
  const separator = argv.indexOf("--");
  if (profileId === undefined || profileId.startsWith("-") || separator === 0 || separator === argv.length - 1) {
    io.stderr("run requires <profile> [options] -- <command...>");
    return 2;
  }
  let manifestPath = ".remote-runner.yaml";
  let mode: RunMode | undefined;
  const seen = new Set<string>();
  const optionEnd = separator === -1 ? argv.length : separator;
  for (let index = 1; index < optionEnd; index += 1) {
    const argument = argv[index];
    if (argument !== "--manifest" && argument !== "--mode") {
      io.stderr(`unknown run argument: ${argument ?? ""}`);
      return 2;
    }
    if (seen.has(argument)) {
      io.stderr(`duplicate run argument: ${argument}`);
      return 2;
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || index + 1 >= optionEnd) {
      io.stderr(`run requires a value after ${argument}`);
      return 2;
    }
    if (argument === "--manifest") manifestPath = value;
    else if (value === "auto" || value === "local" || value === "remote") mode = value;
    else {
      io.stderr(`invalid run mode: ${value}`);
      return 2;
    }
    index += 1;
  }
  if (mode === undefined) {
    const environmentMode = (dependencies.environment ?? process.env).REMOTE_RUNNER_MODE;
    if (environmentMode !== undefined && environmentMode !== "") {
      if (environmentMode !== "auto" && environmentMode !== "local" && environmentMode !== "remote") {
        io.stderr(`invalid REMOTE_RUNNER_MODE: ${environmentMode}`);
        return 2;
      }
      mode = environmentMode;
    }
  }
  const commandOverride = separator === -1 ? undefined : argv.slice(separator + 1);
  if (
    commandOverride !== undefined &&
    (commandOverride[0]?.length === 0 || commandOverride.some((part) => part.includes("\0")))
  ) {
    io.stderr("run command must be a safe argument array");
    return 2;
  }
  let manifest;
  try {
    manifest = await readManifest(manifestPath, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`invalid manifest: ${message}`);
    return 2;
  }
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    io.stderr(`profile not found: ${profileId}`);
    return 2;
  }
  const command = commandOverride ?? profile.workload.command;
  if (dependencies.runProfile === undefined || dependencies.ensureController === undefined) {
    io.stderr("remote-runner execution runtime is not configured");
    return 70;
  }
  const effectiveMode = mode ?? profile.mode;
  if (effectiveMode !== "local") {
    try {
      await dependencies.ensureController();
    } catch {
      if (effectiveMode !== "auto" || profile.fallback !== "local") {
        io.stderr("remote-runner controller repair failed");
        return 70;
      }
      io.stderr("remote-runner controller unavailable; continuing automatic fallback policy");
    }
  }
  try {
    return await dependencies.runProfile(profile, command, effectiveMode);
  } catch {
    io.stderr("remote-runner execution failed");
    return 70;
  }
}

async function validateManifest(argv: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  let manifestPath = ".remote-runner.yaml";
  let profileId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      const path = argv[index + 1];
      if (path === undefined || path.startsWith("--")) {
        io.stderr("validate requires a path after --manifest");
        return 2;
      }
      manifestPath = path;
      index += 1;
      continue;
    }
    if (argument === undefined || argument.startsWith("-")) {
      io.stderr(`unknown validate argument: ${argument ?? ""}`);
      return 2;
    }
    if (profileId !== undefined) {
      io.stderr(`unexpected validate argument: ${argument}`);
      return 2;
    }
    profileId = argument;
  }

  let manifest;
  try {
    manifest = await readManifest(manifestPath, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`invalid manifest: ${message}`);
    return 2;
  }

  if (profileId !== undefined) {
    if (!manifest.profiles.some((profile) => profile.id === profileId)) {
      io.stderr(`profile not found: ${profileId}`);
      return 2;
    }
    io.stdout(`valid profile: ${profileId} (${manifestPath})`);
    return 0;
  }

  const noun = manifest.profiles.length === 1 ? "profile" : "profiles";
  io.stdout(`valid manifest: ${manifestPath} (${manifest.profiles.length} ${noun})`);
  return 0;
}
