import { readFile } from "node:fs/promises";

import { loadManifestText } from "./config/load-manifest.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliDependencies {
  readFile(path: string): Promise<string | Uint8Array>;
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

  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
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
    const contents = await dependencies.readFile(manifestPath);
    manifest = loadManifestText(
      typeof contents === "string" ? contents : new TextDecoder().decode(contents),
    );
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
