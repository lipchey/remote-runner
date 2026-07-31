import { readFile } from "node:fs/promises";

import { loadManifestText } from "./config/load-manifest.js";
import type { Profile, RunMode } from "./config/types.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readFile(path: string): Promise<string | Uint8Array>;
  ensureController?(): Promise<void>;
  runProfile?(profile: Profile, command: readonly string[], mode?: RunMode): Promise<number>;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  readFile: async (path) => readFile(path),
};

const HELP = [
  "remote-runner run <profile> -- <command...>",
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

  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
}

async function readManifest(path: string, dependencies: CliDependencies) {
  const contents = await dependencies.readFile(path);
  return loadManifestText(typeof contents === "string" ? contents : new TextDecoder().decode(contents));
}

async function runSelectedProfile(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const profileId = argv[0];
  const separator = argv.indexOf("--");
  if (profileId === undefined || profileId.startsWith("-") || separator < 1 || separator === argv.length - 1) {
    io.stderr("run requires <profile> [options] -- <command...>");
    return 2;
  }
  let manifestPath = ".remote-runner.yaml";
  let mode: RunMode | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < separator; index += 1) {
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
    if (value === undefined || index + 1 >= separator) {
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
  const command = argv.slice(separator + 1);
  if (command[0]?.length === 0 || command.some((part) => part.includes("\0"))) {
    io.stderr("run command must be a safe argument array");
    return 2;
  }
  let manifest;
  try { manifest = await readManifest(manifestPath, dependencies); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`invalid manifest: ${message}`);
    return 2;
  }
  const profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    io.stderr(`profile not found: ${profileId}`);
    return 2;
  }
  if (dependencies.runProfile === undefined || dependencies.ensureController === undefined) {
    io.stderr("remote-runner execution runtime is not configured");
    return 70;
  }
  try { await dependencies.ensureController(); } catch {
    io.stderr("remote-runner controller repair failed");
    return 70;
  }
  try { return await dependencies.runProfile(profile, command, mode); } catch {
    io.stderr("remote-runner execution failed");
    return 70;
  }
}

async function validateManifest(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
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
