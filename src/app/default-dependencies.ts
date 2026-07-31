import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { runBenchmark, type BenchmarkExecution } from "../benchmark/run-benchmark.js";
import type { CliDependencies } from "../cli.js";
import { loadManifestText } from "../config/load-manifest.js";
import type { ManifestV1, Profile, RunMode } from "../config/types.js";
import { doctor, formatStatus, tailLogs, type DiagnosticProbe, type DiagnosticStatus } from "../diagnostics/doctor.js";
import { repair, type RepairAction, type RepairReceipt } from "../diagnostics/repair.js";
import { mutagenDarwinArchitecture } from "../install/mutagen.js";
import { createNodeNotificationCallbacks } from "../node/notifications.js";
import { ensureNodeController, NodeControllerRuntime } from "../node/controller.js";
import {
  ensureManagedSshTransport,
  mutagenSshEnvironment,
  type ManagedSshTransport,
} from "../node/managed-ssh.js";
import { NodeProcessRuntime } from "../node/process.js";
import { worktreeIdentity } from "../runtime/identity.js";
import { runProfile } from "../run/run-profile.js";
import { runSsh, type SshProcessRuntime } from "../ssh/client.js";
import { mutagenSessionName } from "../sync/mutagen.js";
import { createProfileRuntime } from "./profile-runtime.js";
import { NodeProfileServices } from "./pilot-services.js";

const CAPTURE_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface NodeCliDependencyOptions {
  readonly home?: string;
  readonly sourceRoot?: string;
  readonly launcherSource?: Uint8Array;
  readonly managedSsh?: ManagedSshTransport;
  readonly processes?: NodeProcessRuntime;
  readonly now?: () => string;
  readonly executeProfile?: (
    profile: Profile,
    command: readonly string[],
    mode: RunMode,
  ) => Promise<number>;
}

export interface NodeCliDependencies extends CliDependencies {
  readonly identity: string;
  loadManifest(): Promise<ManifestV1>;
}

export function installedMutagenPath(home: string): string {
  const machine = arch() === "arm64" ? "arm64" : "x86_64";
  const distribution = mutagenDarwinArchitecture(machine);
  return join(home, ".local", "share", "remote-runner", "bin", `mutagen-v0.18.1-darwin-${distribution}`, "mutagen");
}

export function launcherAssetCandidates(moduleUrl: string): readonly URL[] {
  return [
    new URL("../../assets/remote-launcher.mjs", moduleUrl),
    new URL("../../../assets/remote-launcher.mjs", moduleUrl),
  ];
}

async function readLauncherSource(): Promise<Uint8Array> {
  for (const candidate of launcherAssetCandidates(import.meta.url)) {
    try { return new Uint8Array(await readFile(candidate)); }
    catch (caught) {
      if (!(typeof caught === "object" && caught !== null && "code" in caught && (caught as { code?: unknown }).code === "ENOENT")) throw caught;
    }
  }
  throw new Error("remote launcher asset is missing");
}

function errorCode(caught: unknown): string | undefined {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { readonly code?: unknown }).code)
    : undefined;
}

function profileRoot(home: string, profile: Pick<Profile, "consumer" | "id">, identity: string): string {
  return join(home, ".local", "state", "remote-runner", "profiles", profile.consumer, profile.id, identity);
}

function selectedProfiles(manifest: ManifestV1, profileId?: string): readonly Profile[] {
  if (profileId === undefined) return manifest.profiles;
  const profile = manifest.profiles.find(({ id }) => id === profileId);
  if (profile === undefined) throw new Error(`profile not found: ${profileId}`);
  return [profile];
}

function confinedPath(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("output path escapes source root");
  }
  return target;
}

function hostFromTarget(target: string): string {
  return target.includes("@") ? target.slice(target.lastIndexOf("@") + 1) : target;
}

function remoteWorkspace(profile: Profile, identity: string): string {
  return `.cache/remote-runner/workspaces/${profile.consumer}/${profile.id}/${identity}`;
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try { return decoder.decode(await readFile(path)); }
  catch (caught) {
    if (errorCode(caught) === "ENOENT") return undefined;
    throw caught;
  }
}

function sessionStatus(output: Uint8Array, expectedName: string): "watching" | "paused" | "missing" | "unknown" {
  let sawSession = false;
  try {
    for (const line of decoder.decode(output).split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const value = JSON.parse(line) as { readonly name?: unknown; readonly paused?: unknown; readonly status?: unknown };
      if (typeof value !== "object" || value === null) return "unknown";
      if (value.name !== expectedName) continue;
      sawSession = true;
      if (value.paused === true) return "paused";
      if (value.paused !== false || typeof value.status !== "string") return "unknown";
      if (value.status === "watching") return "watching";
    }
  } catch { return "unknown"; }
  return sawSession ? "unknown" : "missing";
}

async function inspectRemoteStatus(
  processes: SshProcessRuntime,
  profile: Profile,
  identity: string,
  knownHostsPath: string,
): Promise<{ readonly workspace: "ready" | "missing" | "dirty" | "unknown"; readonly fingerprint: "current" | "stale" | "missing" | "unknown" }> {
  const workspace = `.cache/remote-runner/workspaces/${profile.consumer}/${profile.id}/${identity}`;
  const setupState = `.local/state/remote-runner/profiles/${profile.consumer}/${profile.id}/${identity}/setup.json`;
  const script = [
    "workspace=$HOME/$1", "setup=$HOME/$2",
    "if [ ! -d \"$workspace\" ]; then workspace_status=missing; elif [ -n \"$(git -C \"$workspace\" status --porcelain 2>/dev/null)\" ]; then workspace_status=dirty; else workspace_status=ready; fi",
    "if [ -f \"$setup\" ]; then fingerprint_status=current; else fingerprint_status=missing; fi",
    "printf '{\"workspace\":\"%s\",\"fingerprint\":\"%s\"}\\n' \"$workspace_status\" \"$fingerprint_status\"",
  ].join("; ");
  const result = await runSsh(
    processes,
    profile.remote.target,
    ["sh", "-ceu", script, "remote-runner-status", workspace, setupState],
    profile.probes.connectTimeoutSeconds,
    knownHostsPath,
    CAPTURE_BYTES,
  );
  if (result.exitCode !== 0) return { workspace: "unknown", fingerprint: "unknown" };
  try {
    const parsed = JSON.parse(decoder.decode(result.stdout)) as { workspace?: unknown; fingerprint?: unknown };
    const workspaceStatus = parsed.workspace;
    const fingerprintStatus = parsed.fingerprint;
    return {
      workspace: workspaceStatus === "ready" || workspaceStatus === "missing" || workspaceStatus === "dirty" ? workspaceStatus : "unknown",
      fingerprint: fingerprintStatus === "current" || fingerprintStatus === "stale" || fingerprintStatus === "missing" ? fingerprintStatus : "unknown",
    };
  } catch { return { workspace: "unknown", fingerprint: "unknown" }; }
}

async function inspectOutage(path: string): Promise<"clear" | "active" | "pending" | "unknown"> {
  const contents = await readOptionalUtf8(path);
  if (contents === undefined) return "clear";
  try {
    const parsed = JSON.parse(contents) as { readonly outageActive?: unknown; readonly queue?: unknown };
    if (typeof parsed.outageActive !== "boolean" || !Array.isArray(parsed.queue)) return "unknown";
    if (parsed.queue.length > 0) return "pending";
    return parsed.outageActive ? "active" : "clear";
  } catch { return "unknown"; }
}

async function inspectProbe(
  probe: DiagnosticProbe,
  profile: Profile,
  identity: string,
  options: {
    readonly home: string;
    readonly sourceRoot: string;
    readonly knownHostsPath: string;
    readonly mutagenCommand: string;
    readonly managedSshPath: string;
    readonly processes: NodeProcessRuntime;
  },
): Promise<{ readonly status: DiagnosticStatus }> {
  if (probe.id === "profile.validation") return { status: "ok" };
  if (probe.id === "controller.health") {
    const state = await new NodeControllerRuntime(options.home, options.processes).inspect();
    return { status: state.loaded && state.running && state.compatible ? "ok" : "fail" };
  }
  if (probe.id === "runtime.unknown") return { status: "ok" };

  let command: string;
  let args: readonly string[];
  let environment: Readonly<Record<string, string>> | undefined;
  const workspace = remoteWorkspace(profile, identity);
  if (probe.id === "network.dns") {
    command = "dscacheutil";
    args = ["-q", "host", "-a", "name", hostFromTarget(profile.remote.target)];
  } else if (probe.id === "ssh.host-key") {
    command = "ssh-keygen";
    args = ["-F", hostFromTarget(profile.remote.target), "-f", options.knownHostsPath];
  } else if (probe.id === "runtime.lock") {
    command = "ls";
    args = ["-ld", join(options.home, ".local", "state", "remote-runner", "locks", identity)];
  } else if (probe.id === "sync.session") {
    command = options.mutagenCommand;
    args = ["sync", "list", mutagenSessionName(profile.consumer, profile.id, identity)];
    environment = mutagenSshEnvironment(options.managedSshPath);
  } else if (probe.id === "workload.child-start") {
    command = "tail";
    args = ["-n", "50", join(profileRoot(options.home, profile, identity), "runner.log")];
  } else {
    const remoteArguments = probe.id === "remote.capacity"
      ? ["sh", "-ceu", "exec df -Pk \"$HOME/$1\"", "remote-runner-capacity", workspace]
      : probe.id === "remote.bootstrap"
        ? ["sh", "-ceu", "command -v node >/dev/null && command -v pnpm >/dev/null"]
        : probe.id === "remote.workspace"
          ? ["sh", "-ceu", "exec git -C \"$HOME/$1\" status --short --branch", "remote-runner-workspace", workspace]
          : probe.id === "secrets.persistence"
            ? ["sh", "-ceu", "exec find \"$HOME/$1\" -maxdepth 1 -name .env -print", "remote-runner-secrets", workspace]
            : ["true"];
    const result = await runSsh(
      options.processes,
      profile.remote.target,
      remoteArguments,
      probe.id === "network.timeout" ? Math.min(2, profile.probes.connectTimeoutSeconds) : profile.probes.connectTimeoutSeconds,
      options.knownHostsPath,
      CAPTURE_BYTES,
    );
    return { status: result.exitCode === 0 ? "ok" : "fail" };
  }
  const result = await options.processes.run({ command, args, ...(environment === undefined ? {} : { environment }), maxOutputBytes: CAPTURE_BYTES });
  return { status: result.exitCode === 0 ? "ok" : "fail" };
}

export async function createNodeCliDependencies(
  options: NodeCliDependencyOptions = {},
): Promise<NodeCliDependencies> {
  const home = options.home ?? homedir();
  const sourceRoot = await realpath(options.sourceRoot ?? process.cwd());
  const identity = worktreeIdentity(sourceRoot);
  const processes = options.processes ?? new NodeProcessRuntime();
  const mutagenCommand = installedMutagenPath(home);
  const diagnosticSsh = options.managedSsh ?? {
    changed: false,
    directory: join(home, ".local", "share", "remote-runner", "ssh"),
    knownHostsPath: join(home, ".local", "state", "remote-runner", "known_hosts", "managed"),
  };

  const loadManifest = async (): Promise<ManifestV1> => loadManifestText(
    await readFile(join(sourceRoot, ".remote-runner.yaml"), "utf8"),
  );

  let resourcesPromise: Promise<{ readonly managedSsh: ManagedSshTransport; readonly launcherSource: Uint8Array }> | undefined;
  const executionResources = () => resourcesPromise ??= (async () => {
    const managedSsh = options.managedSsh ?? await ensureManagedSshTransport(home);
    const launcherSource = options.launcherSource ?? await readLauncherSource();
    if (managedSsh.changed) {
      const stopped = await processes.run({
        command: mutagenCommand,
        args: ["daemon", "stop"],
        environment: mutagenSshEnvironment(managedSsh.directory),
        maxOutputBytes: CAPTURE_BYTES,
      });
      if (stopped.exitCode !== 0 && stopped.exitCode !== 127) {
        throw new Error("unable to restart Mutagen after managed SSH transport update");
      }
    }
    return { managedSsh, launcherSource };
  })();

  const executeProfile = options.executeProfile ?? (async (
    profile: Profile,
    command: readonly string[],
    mode: RunMode,
  ): Promise<number> => {
    const resources = await executionResources();
    const notifications = createNodeNotificationCallbacks({
      statePath: join(profileRoot(home, profile, identity), "outage.json"),
      configPath: join(home, ".claude", ".telegram-ask.conf"),
      context: { consumer: profile.consumer, profile: profile.id, remoteLabel: profile.remote.label },
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
    const services = new NodeProfileServices(profile, {
      home,
      sourceRoot,
      launcherSource: resources.launcherSource,
      mutagenCommand,
      managedSshPath: resources.managedSsh.directory,
      knownHostsPath: resources.managedSsh.knownHostsPath,
      processes,
      recordFallback: notifications.recordFallback,
      recordRemoteChildStarted: notifications.recordRemoteChildStarted,
    });
    return runProfile(createProfileRuntime(services), profile, command, mode);
  });

  const dependencies: NodeCliDependencies = {
    identity,
    loadManifest,
    readFile: async (path) => readFile(path),
    ensureController: () => ensureNodeController(home),
    runProfile: (profile, command, mode) => executeProfile(profile, command, mode ?? profile.mode),
    async statusProfile(profileId) {
      const profiles = selectedProfiles(await loadManifest(), profileId);
      const controllerState = await new NodeControllerRuntime(home, processes).inspect();
      const controller = !controllerState.compatible ? "incompatible" : controllerState.running ? "running" : "stopped";
      const lines: string[] = [];
      for (const profile of profiles) {
        const expectedSession = mutagenSessionName(profile.consumer, profile.id, identity);
        const sessionResult = await processes.run({
          command: mutagenCommand,
          args: ["sync", "list", "--template", "{{ json . }}", expectedSession],
          environment: mutagenSshEnvironment(diagnosticSsh.directory),
          maxOutputBytes: CAPTURE_BYTES,
        });
        const session = sessionResult.exitCode === 0 ? sessionStatus(sessionResult.stdout, expectedSession) : "unknown";
        const remote = await inspectRemoteStatus(processes, profile, identity, diagnosticSsh.knownHostsPath);
        const outage = await inspectOutage(join(profileRoot(home, profile, identity), "outage.json"));
        lines.push(formatStatus({ profile: profile.id, controller, session, ...remote, outage }));
      }
      return lines.join("\n");
    },
    async doctorProfile(profileId) {
      const profiles = selectedProfiles(await loadManifest(), profileId);
      const reports = [];
      for (const profile of profiles) {
        reports.push({
          profile: profile.id,
          report: await doctor({
            inspect: (probe) => inspectProbe(probe, profile, identity, {
              home,
              sourceRoot,
              knownHostsPath: diagnosticSsh.knownHostsPath,
              mutagenCommand,
              managedSshPath: diagnosticSsh.directory,
              processes,
            }),
          }),
        });
      }
      return profileId === undefined ? { profiles: reports } : reports[0]!.report;
    },
    async logsProfile(profileId) {
      const profiles = selectedProfiles(await loadManifest(), profileId);
      const lines: string[] = [];
      for (const profile of profiles) {
        const logPath = join(profileRoot(home, profile, identity), "runner.log");
        const profileLines = await tailLogs({
          readRotation: (index) => readOptionalUtf8(index === 0 ? logPath : `${logPath}.${index}`),
        });
        lines.push(...(profileId === undefined ? profileLines.map((line) => `${profile.id} ${line}`) : profileLines));
      }
      return lines;
    },
    async repairProfile(profileId, apply) {
      const profile = selectedProfiles(await loadManifest(), profileId)[0]!;
      const root = profileRoot(home, profile, identity);
      const receiptPath = join(root, "repair-dry-run.json");
      return repair({
        identity,
        identityRoot: root,
        async inspect() {
          let entries: string[];
          try { entries = await readdir(root); }
          catch (caught) {
            if (errorCode(caught) === "ENOENT") return [];
            throw caught;
          }
          const actions: RepairAction[] = [];
          for (const entry of entries.sort()) {
            if (!entry.includes(".corrupt-")) continue;
            const target = join(root, entry);
            const metadata = await lstat(target);
            if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) continue;
            actions.push({ id: `remove-corrupt-${actions.length + 1}`, target, destructive: true });
          }
          return actions;
        },
        async readDryRun() {
          let metadata;
          try { metadata = await lstat(receiptPath); }
          catch (caught) {
            if (errorCode(caught) === "ENOENT") return undefined;
            throw caught;
          }
          if (metadata.isSymbolicLink()) throw new Error("repair receipt must not be a symlink");
          if (!metadata.isFile()) throw new Error("repair receipt must be a regular file");
          const contents = await readOptionalUtf8(receiptPath);
          if (contents === undefined) return undefined;
          try { return JSON.parse(contents) as RepairReceipt; }
          catch { return undefined; }
        },
        async writeDryRun(receipt) {
          await mkdir(root, { recursive: true, mode: 0o700 });
          try {
            const metadata = await lstat(receiptPath);
            if (metadata.isSymbolicLink()) throw new Error("repair receipt must not be a symlink");
            if (!metadata.isFile()) throw new Error("repair receipt must be a regular file");
          } catch (caught) {
            if (errorCode(caught) !== "ENOENT") throw caught;
          }
          const temporary = join(root, `.repair-dry-run.tmp-${randomUUID()}`);
          try {
            await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
            await rename(temporary, receiptPath);
          } catch (caught) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw caught;
          }
        },
        async apply(action) {
          const metadata = await lstat(action.target);
          if (metadata.isSymbolicLink()) throw new Error("refusing to repair through a symlink");
          await rm(action.target, { recursive: metadata.isDirectory(), force: false });
        },
        now: options.now ?? (() => new Date().toISOString()),
      }, profile.id, { apply });
    },
    async benchmarkProfile(profile) {
      await ensureNodeController(home);
      return runBenchmark({
        now: options.now ?? (() => new Date().toISOString()),
        async runSample(execution: BenchmarkExecution) {
          const startedAt = performance.now();
          const status = await executeProfile(profile, execution.command, execution.location);
          const finishedAt = performance.now();
          return { syncMs: 0, setupMs: 0, workloadMs: Math.max(0, finishedAt - startedAt), status };
        },
        async writeReceipt(path, contents) {
          const target = confinedPath(sourceRoot, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const canonicalDirectory = await realpath(dirname(target));
          const directoryFromRoot = relative(sourceRoot, canonicalDirectory);
          if (
            directoryFromRoot === ".." || directoryFromRoot.startsWith(`..${sep}`) ||
            isAbsolute(directoryFromRoot)
          ) throw new Error("output directory escapes source root");
          try {
            const metadata = await lstat(target);
            if (metadata.isSymbolicLink()) throw new Error("benchmark receipt must not be a symlink");
            if (!metadata.isFile()) throw new Error("benchmark receipt must be a regular file");
          } catch (caught) {
            if (errorCode(caught) !== "ENOENT") throw caught;
          }
          const temporary = join(canonicalDirectory, `.benchmark-receipt.tmp-${randomUUID()}`);
          try {
            await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
            await rename(temporary, target);
          } catch (caught) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw caught;
          }
        },
      }, profile);
    },
  };
  return dependencies;
}
