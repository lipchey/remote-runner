import { readFile } from "node:fs/promises";
import process from "node:process";

import { loadManifestText, remoteFallbackOf } from "./config/load-manifest.js";
import type { Profile, RunMode } from "./config/types.js";
import { corpusJson, formatCorpus, type CorpusOptions, type CorpusReport } from "./diagnostics/corpus.js";
import type { DoctorProfileReport } from "./diagnostics/doctor.js";

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface ResolveAnswer {
  readonly requested: string;
  readonly selected: string | null;
  readonly remoteLabel: string | null;
  readonly fallbackActive: boolean;
  readonly reason: string | null;
  readonly checkedAt: string;
}

export interface ResolveResult {
  readonly outcome: "selected" | "unreachable" | "security";
  readonly answer: ResolveAnswer;
}

export interface CliDependencies {
  readFile(path: string): Promise<string | Uint8Array>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  ensureController?(): Promise<void>;
  runProfile?(
    profile: Profile,
    commandOverride: readonly string[] | undefined,
    mode?: RunMode,
    controllerEnsureMs?: number,
    fallback?: Profile,
  ): Promise<number>;
  resolveProfile?(profile: Profile, fallback: Profile | undefined, mode: RunMode): Promise<ResolveResult>;
  enqueuePrewarm?(profile: Profile, manifestPath: string): Promise<"published" | "coalesced">;
  statusProfile?(profile?: string, manifestPath?: string): Promise<string>;
  doctorProfile?(profile?: string, manifestPath?: string): Promise<readonly DoctorProfileReport[]>;
  logsProfile?(profile?: string, manifestPath?: string): Promise<readonly string[]>;
  readLogCorpus?(options: CorpusOptions): Promise<CorpusReport>;
  benchmarkProfile?(profile: Profile): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  readFile: async (path) => readFile(path),
};

const HELP = [
  "remote-runner install",
  "remote-runner run <profile> [options] [-- <command...>]",
  "remote-runner resolve <profile> [--manifest <path>] --json",
  "remote-runner prewarm <profile> [--manifest <path>]",
  "remote-runner validate [profile] [--manifest <path>]",
  "remote-runner status [profile] [--manifest <path>]",
  "remote-runner doctor [profile] [--manifest <path>]",
  "remote-runner logs [profile] [--manifest <path>]",
  "remote-runner logs --all [--json] [--since <date>] [--cold-threshold-ms <n>]",
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

  if (argv[0] === "resolve") {
    return resolveSelectedProfile(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "prewarm") {
    return enqueueSelectedPrewarm(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "status" || argv[0] === "doctor") {
    return runReadOnlyDiagnostic(argv[0], argv.slice(1), io, dependencies);
  }

  if (argv[0] === "logs") {
    return runLogsCommand(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "benchmark") {
    return runBenchmarkCommand(argv.slice(1), io, dependencies);
  }

  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
}

function environmentMode(dependencies: CliDependencies): RunMode | undefined {
  const value = (dependencies.environment ?? process.env).REMOTE_RUNNER_MODE;
  if (value === undefined || value === "") return undefined;
  if (value === "auto" || value === "local" || value === "remote") return value;
  throw new Error(value);
}

async function resolveSelectedProfile(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const profileId = argv[0];
  if (profileId === undefined || profileId.startsWith("-")) {
    io.stderr("resolve requires <profile> [--manifest <path>] --json");
    return 2;
  }
  let manifestPath = ".remote-runner.yaml";
  let manifestSet = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" && !json) {
      json = true;
      continue;
    }
    if (argument === "--manifest" && !manifestSet) {
      const value = argv[++index];
      if (value !== undefined && !value.startsWith("-")) {
        manifestPath = value;
        manifestSet = true;
        continue;
      }
    }
    io.stderr("resolve requires <profile> [--manifest <path>] --json");
    return 2;
  }
  if (!json) {
    io.stderr("resolve requires --json");
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
  let mode: RunMode;
  try {
    mode = environmentMode(dependencies) ?? profile.mode;
  } catch (error) {
    io.stderr(`invalid REMOTE_RUNNER_MODE: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (dependencies.resolveProfile === undefined) {
    io.stderr("remote-runner resolve runtime is not configured");
    return 70;
  }
  try {
    const result = await dependencies.resolveProfile(profile, remoteFallbackOf(manifest, profile), mode);
    io.stdout(JSON.stringify(result.answer));
    return result.outcome === "selected" ? 0 : result.outcome === "security" ? 4 : 3;
  } catch {
    io.stderr("remote-runner resolve failed");
    return 70;
  }
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

/* The cut is a string compare against ISO timestamps, so an impossible value compares perfectly well
   and silently selects a range no reader intended: `2026-02-30` needs a calendar round-trip, and
   `2026-08-17T99:99Z` sorts above every real timestamp that day. Every component is range-checked. */
function isUtcDatePrefix(value: string): boolean {
  const parts = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?Z?)?$/u.exec(value);
  if (parts === null) return false;
  const [, day, hour, minute, second] = parts;
  if (day === undefined || !new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)) return false;
  return (
    (hour === undefined || Number(hour) <= 23) &&
    (minute === undefined || Number(minute) <= 59) &&
    (second === undefined || Number(second) <= 59)
  );
}

async function runLogsCommand(argv: readonly string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  let all = false;
  let json = false;
  let since: string | undefined;
  let coldThresholdMs: number | undefined;
  let profileId: string | undefined;
  let manifestPath: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("-")) {
      if (profileId !== undefined) {
        io.stderr("logs accepts at most one profile");
        return 2;
      }
      profileId = argument;
      continue;
    }
    if (seen.has(argument)) {
      io.stderr(`duplicate logs argument: ${argument}`);
      return 2;
    }
    seen.add(argument);
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument !== "--since" && argument !== "--cold-threshold-ms" && argument !== "--manifest") {
      io.stderr(`unknown logs argument: ${argument}`);
      return 2;
    }
    const value = argv[index + 1];
    index += 1;
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      io.stderr(`logs requires a value after ${argument}`);
      return 2;
    }
    if (argument === "--manifest") {
      manifestPath = value;
      continue;
    }
    if (argument === "--since") {
      if (!isUtcDatePrefix(value)) {
        io.stderr("logs --since takes a real UTC date or ISO prefix, e.g. 2026-08-17");
        return 2;
      }
      since = value;
      continue;
    }
    const threshold = Number(value);
    /* Safe, not merely integral: a value past 2^53 is silently rounded, so the threshold echoed back
       in the envelope would not be the one the caller asked for. */
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      io.stderr("logs --cold-threshold-ms takes a positive integer");
      return 2;
    }
    coldThresholdMs = threshold;
  }

  if (!all) {
    if (json || since !== undefined || coldThresholdMs !== undefined) {
      io.stderr("logs --json, --since and --cold-threshold-ms only apply to --all");
      return 2;
    }
    return tailOneProfile(profileId, io, dependencies, manifestPath);
  }
  if (manifestPath !== undefined) {
    io.stderr("logs --all reads the global run corpus and takes no --manifest option");
    return 2;
  }
  if (profileId !== undefined) {
    io.stderr("logs --all reads every profile and takes no profile argument");
    return 2;
  }
  if (dependencies.readLogCorpus === undefined) {
    io.stderr("remote-runner logs runtime is not configured");
    return 70;
  }
  let report: CorpusReport;
  try {
    report = await dependencies.readLogCorpus({
      ...(since === undefined ? {} : { since }),
      ...(coldThresholdMs === undefined ? {} : { coldThresholdMs }),
    });
  } catch {
    io.stderr("remote-runner logs failed");
    return 70;
  }
  io.stdout(json ? JSON.stringify(corpusJson(report.provenance, report.summary)) : formatCorpus(report));
  /* The exit code answers "did the read work", never "did the lane pass": a corpus of failures is
     exactly what this command exists to print. */
  return 0;
}

async function tailOneProfile(
  profileId: string | undefined,
  io: CliIo,
  dependencies: CliDependencies,
  manifestPath?: string,
): Promise<number> {
  if (dependencies.logsProfile === undefined) {
    io.stderr("remote-runner logs runtime is not configured");
    return 70;
  }
  try {
    for (const line of await dependencies.logsProfile(profileId, manifestPath)) io.stdout(line);
  } catch {
    io.stderr("remote-runner logs failed");
    return 70;
  }
  return 0;
}

async function runReadOnlyDiagnostic(
  command: "status" | "doctor",
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  let profile: string | undefined;
  let manifestPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--manifest") {
      if (manifestPath !== undefined) {
        io.stderr(`duplicate ${command} argument: --manifest`);
        return 2;
      }
      const value = argv[++index];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        io.stderr(`${command} requires a value after --manifest`);
        return 2;
      }
      manifestPath = value;
    } else if (argument.startsWith("-") || profile !== undefined) {
      io.stderr(`${command} accepts at most one profile and --manifest <path>`);
      return 2;
    } else {
      profile = argument;
    }
  }
  try {
    if (command === "status" && dependencies.statusProfile !== undefined) {
      io.stdout(await dependencies.statusProfile(profile, manifestPath));
      return 0;
    }
    if (command === "doctor" && dependencies.doctorProfile !== undefined) {
      const reports = await dependencies.doctorProfile(profile, manifestPath);
      /* The serialized shape stays the operator-facing contract — one report for a named profile,
         the wrapper for every profile — so only the exit code carries the new signal. */
      io.stdout(JSON.stringify(profile === undefined ? { profiles: reports } : reports[0]!.report));
      return reports.some(({ report }) => report.checks.some((check) => check.status === "fail")) ? 1 : 0;
    }
  } catch {
    io.stderr(`remote-runner ${command} failed`);
    return 70;
  }
  io.stderr(`remote-runner ${command} runtime is not configured`);
  return 70;
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
    try {
      mode = environmentMode(dependencies);
    } catch (error) {
      io.stderr(`invalid REMOTE_RUNNER_MODE: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
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
  const fallback = remoteFallbackOf(manifest, profile);
  if (dependencies.runProfile === undefined || dependencies.ensureController === undefined) {
    io.stderr("remote-runner execution runtime is not configured");
    return 70;
  }
  const effectiveMode = mode ?? profile.mode;
  /* Measured here because the repair runs before the runner's own clock starts, and a slow one is
     dispatch time the run record would otherwise carry nowhere. */
  let controllerEnsureMs: number | undefined;
  if (effectiveMode !== "local") {
    const startedMs = performance.now();
    try {
      await dependencies.ensureController();
    } catch {
      if (effectiveMode !== "auto" || (profile.fallback !== "local" && fallback?.fallback !== "local")) {
        io.stderr("remote-runner controller repair failed");
        return 70;
      }
      io.stderr("remote-runner controller unavailable; continuing automatic fallback policy");
    }
    controllerEnsureMs = Math.round(performance.now() - startedMs);
  }
  try {
    return await dependencies.runProfile(profile, commandOverride, effectiveMode, controllerEnsureMs, fallback);
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
