import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { arch, homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import process from "node:process";

import { runBenchmark, type BenchmarkExecution } from "../benchmark/run-benchmark.js";
import type { CliDependencies } from "../cli.js";
import { loadManifestText } from "../config/load-manifest.js";
import type { ManifestV1, Profile, RunMode } from "../config/types.js";
import {
  doctor,
  formatStatus,
  tailLogs,
  type DiagnosticProbe,
  type DiagnosticStatus,
  type DoctorProfileReport,
} from "../diagnostics/doctor.js";
import { readCorpus, summarizeCorpus } from "../diagnostics/corpus.js";
import { formatInstallVersion, readInstalledReceipt } from "../node/install-receipt.js";
import { mutagenDarwinArchitecture } from "../install/mutagen.js";
import { createNodeNotificationCallbacks } from "../node/notifications.js";
import { ensureNodeController, NodeControllerRuntime } from "../node/controller.js";
import { ensureManagedSshTransport, mutagenSshEnvironment, type ManagedSshTransport } from "../node/managed-ssh.js";
import { NodeProcessRuntime } from "../node/process.js";
import { errorCode } from "../runtime/errno.js";
import { clientNamespace, resolveClientIdentity, worktreeIdentity } from "../runtime/identity.js";
import { createJsonlLogger } from "../runtime/log.js";
import { RunTelemetry } from "../runtime/telemetry.js";
import { inspectPrewarmRequest, publishPrewarmRequest } from "../prewarm/queue.js";
import { runProfile } from "../run/run-profile.js";
import { runSsh, type SshProcessRuntime } from "../ssh/client.js";
import { inspectOwnedSession, MUTAGEN_LIST_ARGUMENTS, mutagenSessionName } from "../sync/mutagen.js";
import { createProfileRuntime } from "./profile-runtime.js";
import { NodeProfileServices } from "./pilot-services.js";

const CAPTURE_BYTES = 64 * 1024;
const LEGACY_GENERATED_ROOT = "~/.cache/remote-runner/workspaces";
/* Chosen clear of every other exit code that can reach this decision: 74 is the registration
   probe's own "worktree is still registered" signal, 75-78 belong to workspace retention, 255 is
   ssh reporting its own failure, and 0-2 are what the probed commands themselves return. */
const WORKSPACE_ABSENT_EXIT = 79;
const WORKSPACE_SCOPED_PROBES = new Set(["remote.workspace", "secrets.persistence"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface NodeCliDependencyOptions {
  readonly home?: string;
  readonly clientId?: string;
  readonly sourceRoot?: string;
  readonly mainModuleUrl?: string;
  readonly launcherSource?: Uint8Array;
  readonly managedSsh?: ManagedSshTransport;
  readonly processes?: NodeProcessRuntime;
  readonly now?: () => string;
  readonly createRunId?: () => string;
  readonly executeProfile?: (
    profile: Profile,
    command: readonly string[],
    mode: RunMode,
    hooks: {
      readonly onUnavailable: (reason: string, detail?: string) => void;
      readonly onRemoteChildStarted: () => void;
    },
  ) => Promise<number>;
}

export interface NodeCliDependencies extends CliDependencies {
  readonly identity: string;
  loadManifest(manifestPath?: string): Promise<ManifestV1>;
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
    try {
      return new Uint8Array(await readFile(candidate));
    } catch (caught) {
      if (!(
        typeof caught === "object" &&
        caught !== null &&
        "code" in caught &&
        (caught as { code?: unknown }).code === "ENOENT"
      ))
        throw caught;
    }
  }
  throw new Error("remote launcher asset is missing");
}

/* The receipt sits one directory above the main module, so this must name `main.js` and not this
   module: pointing it here would look one level too deep and report "unknown" for every install. */
export const INSTALLED_MAIN_MODULE_URL = new URL("../main.js", import.meta.url).href;

const lenientDecoder = new TextDecoder("utf-8");

function corpusRoot(home: string): string {
  return join(home, ".local", "state", "remote-runner", "profiles");
}

function profileRoot(home: string, profile: Pick<Profile, "consumer" | "id">, identity: string): string {
  return join(corpusRoot(home), profile.consumer, profile.id, identity);
}

/* Log paths sit in a user-writable tree this process does not own, and mode bits do not stop a
   same-UID replacement of a log by a FIFO (which parks a plain open forever) or by a symlink out of
   the corpus. Hence non-blocking, no-follow, and the type decided on the HANDLE rather than the path.
   ELOOP is what a refused symlink returns; like an absent log it means there is nothing to read. */
async function readLogBytes(path: string): Promise<Uint8Array | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (caught) {
    const code = errorCode(caught);
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw caught;
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readOptionalLog(path: string): Promise<string | undefined> {
  const bytes = await readLogBytes(path);
  return bytes === undefined ? undefined : decoder.decode(bytes);
}

/* Decoded leniently, unlike every other read here: a truncated tail character must cost that record
   rather than the identity's whole history. */
async function readCorpusLog(path: string): Promise<string | undefined> {
  const bytes = await readLogBytes(path);
  return bytes === undefined ? undefined : lenientDecoder.decode(bytes);
}

async function listCorpusDirectories(path: string): Promise<readonly string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (caught) {
    /* Only ENOENT means "nothing dispatched here": an unreadable corpus reported as an empty one
       reads as a clean lane. */
    if (errorCode(caught) === "ENOENT") return [];
    throw caught;
  }
}

async function installedRunnerVersion(mainModuleUrl: string): Promise<string> {
  try {
    return formatInstallVersion(await readInstalledReceipt(mainModuleUrl));
  } catch {
    /* The version annotates the answer rather than being it, so an unreadable receipt must not cost
       the operator the corpus. */
    return "unknown";
  }
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

function remoteDiagnosticPaths(
  profile: Profile,
  identity: string,
  clientId: string,
): {
  readonly generatedRoot: string;
  readonly workspace: string;
  readonly mirror: string;
} {
  const generatedRoot =
    profile.workspace.generatedRoot === LEGACY_GENERATED_ROOT
      ? ".cache/remote-runner/workspaces"
      : profile.workspace.generatedRoot;
  return {
    generatedRoot,
    workspace: posix.join(generatedRoot, profile.consumer, profile.id, "clients", clientNamespace(clientId), identity),
    mirror: posix.join(generatedRoot, profile.consumer, ".mirror.git"),
  };
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return decoder.decode(await readFile(path));
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return undefined;
    throw caught;
  }
}

function sessionStatus(output: Uint8Array, expectedName: string): "watching" | "paused" | "missing" | "unknown" {
  let sawSession = false;
  try {
    for (const line of decoder.decode(output).split(/\r?\n/u)) {
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        if (typeof value !== "object" || value === null) return "unknown";
        const session = value as { readonly name?: unknown; readonly paused?: unknown; readonly status?: unknown };
        if (session.name !== expectedName) continue;
        sawSession = true;
        if (session.paused === true) return "paused";
        if (session.paused !== false || typeof session.status !== "string") return "unknown";
        if (session.status === "watching") return "watching";
      }
    }
  } catch {
    return "unknown";
  }
  return sawSession ? "unknown" : "missing";
}

async function inspectRemoteStatus(
  processes: SshProcessRuntime,
  profile: Profile,
  identity: string,
  knownHostsPath: string,
  clientId: string,
): Promise<{
  readonly workspace: "ready" | "missing" | "dirty" | "unknown";
  readonly fingerprint: "current" | "stale" | "missing" | "unknown";
}> {
  const { workspace } = remoteDiagnosticPaths(profile, identity, clientId);
  const setupState = `.local/state/remote-runner/profiles/${profile.consumer}/${profile.id}/${identity}/setup.json`;
  const script = [
    "workspace=$1",
    'case "$workspace" in /*) ;; *) workspace=$HOME/$workspace;; esac',
    "setup=$HOME/$2",
    'if [ ! -d "$workspace" ]; then workspace_status=missing; elif [ -n "$(git -C "$workspace" status --porcelain 2>/dev/null)" ]; then workspace_status=dirty; else workspace_status=ready; fi',
    'if [ -f "$setup" ]; then fingerprint_status=current; else fingerprint_status=missing; fi',
    'printf \'{"workspace":"%s","fingerprint":"%s"}\\n\' "$workspace_status" "$fingerprint_status"',
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
      workspace:
        workspaceStatus === "ready" || workspaceStatus === "missing" || workspaceStatus === "dirty"
          ? workspaceStatus
          : "unknown",
      fingerprint:
        fingerprintStatus === "current" || fingerprintStatus === "stale" || fingerprintStatus === "missing"
          ? fingerprintStatus
          : "unknown",
    };
  } catch {
    return { workspace: "unknown", fingerprint: "unknown" };
  }
}

async function inspectOutage(path: string): Promise<"clear" | "active" | "pending" | "unknown"> {
  const contents = await readOptionalUtf8(path);
  if (contents === undefined) return "clear";
  try {
    const parsed = JSON.parse(contents) as { readonly outageActive?: unknown; readonly queue?: unknown };
    if (typeof parsed.outageActive !== "boolean" || !Array.isArray(parsed.queue)) return "unknown";
    if (parsed.queue.length > 0) return "pending";
    return parsed.outageActive ? "active" : "clear";
  } catch {
    return "unknown";
  }
}

async function resolveRemoteWorkspace(
  options: {
    readonly knownHostsPath: string;
    readonly processes: NodeProcessRuntime;
  },
  profile: Profile,
  relativeWorkspace: string,
): Promise<string | undefined> {
  const result = await runSsh(
    options.processes,
    profile.remote.target,
    ["sh", "-ceu", 'printf %s "$HOME/$1"', "remote-runner-home", relativeWorkspace],
    profile.probes.connectTimeoutSeconds,
    options.knownHostsPath,
    CAPTURE_BYTES,
  );
  if (result.exitCode !== 0 || result.outputTruncated) return undefined;
  const resolved = decoder.decode(result.stdout).trim();
  return posix.isAbsolute(resolved) ? resolved : undefined;
}

async function inspectProbe(
  probe: DiagnosticProbe,
  profile: Profile,
  identity: string,
  options: {
    readonly home: string;
    readonly clientId: string;
    readonly sourceRoot: string;
    readonly knownHostsPath: string;
    readonly mutagenCommand: string;
    readonly managedSshPath: string;
    readonly processes: NodeProcessRuntime;
  },
): Promise<{ readonly status: DiagnosticStatus; readonly detail?: string }> {
  if (probe.id === "controller.health") {
    const state = await new NodeControllerRuntime(options.home, options.processes).inspect();
    return { status: state.loaded && state.running && state.compatible ? "ok" : "fail" };
  }

  let command: string;
  let args: readonly string[];
  let environment: Readonly<Record<string, string>> | undefined;
  const remotePaths = remoteDiagnosticPaths(profile, identity, options.clientId);
  if (probe.id === "network.dns") {
    command = "dscacheutil";
    args = ["-q", "host", "-a", "name", hostFromTarget(profile.remote.target)];
  } else if (probe.id === "ssh.host-key") {
    command = "ssh-keygen";
    args = ["-F", hostFromTarget(profile.remote.target), "-f", options.knownHostsPath];
  } else if (probe.id === "runtime.lock") {
    command = "ls";
    args = ["-ld", join(options.home, ".local", "state", "remote-runner", "locks")];
  } else if (probe.id === "sync.session") {
    /* Exit code 0 only proves a session with the owned name exists; the run additionally requires
       matching endpoints, mode and a conflict-free connection, so the probe checks those too. */
    const listing = await options.processes.run({
      command: options.mutagenCommand,
      args: [...MUTAGEN_LIST_ARGUMENTS],
      environment: mutagenSshEnvironment(options.managedSshPath),
      maxOutputBytes: CAPTURE_BYTES,
    });
    if (listing.exitCode !== 0) return { status: "fail", detail: "Mutagen session list failed" };
    /* A truncated listing parses into a shorter set of sessions, which would read as "the owned
       session is missing" — the one verdict this probe must never invent. */
    if (listing.outputTruncated) return { status: "fail", detail: "Mutagen session list was truncated" };
    /* The run compares the endpoint the remote `$HOME` resolves to, so a home-relative manifest root
       is resolved here the same way; an unresolvable one leaves the endpoint unverified. */
    const betaRoot = posix.isAbsolute(remotePaths.workspace)
      ? remotePaths.workspace
      : await resolveRemoteWorkspace(options, profile, remotePaths.workspace);
    return inspectOwnedSession(listing.stdout, {
      consumer: profile.consumer,
      profile: profile.id,
      identity,
      canonicalAlphaRoot: options.sourceRoot,
      betaTarget: profile.remote.target,
      ...(betaRoot === undefined ? {} : { betaRoot }),
      ignores: profile.sync.ignores,
    });
  } else {
    const remoteArguments =
      probe.id === "remote.capacity"
        ? [
            "sh",
            "-ceu",
            'path=$1; case "$path" in /*) ;; *) path=$HOME/$path;; esac; exec df -Pk "$path"',
            "remote-runner-capacity",
            remotePaths.generatedRoot,
          ]
        : probe.id === "remote.bootstrap"
          ? [
              "sh",
              "-ceu",
              'set -- "$HOME"/.local/share/remote-runner/toolchains/node-v*/bin; [ -x "$1/node" ] && [ -x "$1/pnpm" ]',
            ]
          : probe.id === "remote.workspace"
            ? [
                "sh",
                "-ceu",
                `path=$1; case "$path" in /*) ;; *) path=$HOME/$path;; esac; [ -e "$path" ] || exit ${String(WORKSPACE_ABSENT_EXIT)}; exec git -C "$path" status --short --branch`,
                "remote-runner-workspace",
                remotePaths.workspace,
              ]
            : probe.id === "remote.workspace-registration"
              ? [
                  "sh",
                  "-ceu",
                  'workspace=$1; mirror=$2; case "$workspace" in /*) ;; *) workspace=$HOME/$workspace;; esac; case "$mirror" in /*) ;; *) mirror=$HOME/$mirror;; esac; [ ! -d "$workspace" ] || exit 0; [ -d "$mirror" ] || exit 0; if ! listing=$(git --git-dir="$mirror" worktree list --porcelain); then exit 0; fi; if printf \'%s\\n\' "$listing" | grep -Fqx -- "worktree $workspace"; then exit 74; fi',
                  "remote-runner-workspace-registration",
                  remotePaths.workspace,
                  remotePaths.mirror,
                ]
              : probe.id === "secrets.persistence"
                ? [
                    "sh",
                    "-ceu",
                    `path=$1; case "$path" in /*) ;; *) path=$HOME/$path;; esac; [ -e "$path" ] || exit ${String(WORKSPACE_ABSENT_EXIT)}; if found=$(find "$path" -maxdepth 1 -name .env -print); then [ -z "$found" ]; else exit 1; fi`,
                    "remote-runner-secrets",
                    remotePaths.workspace,
                  ]
                : ["true"];
    const result = await runSsh(
      options.processes,
      profile.remote.target,
      remoteArguments,
      probe.id === "network.timeout"
        ? Math.min(2, profile.probes.connectTimeoutSeconds)
        : profile.probes.connectTimeoutSeconds,
      options.knownHostsPath,
      CAPTURE_BYTES,
    );
    /* A workspace is a cache, so its absence is the normal state of a source checkout that has never
       run remotely — and then neither its Git state nor a secret inside it is knowable. Both probes
       used to fold that into `fail`, which for `secrets.persistence` printed reason `secrets`: an
       operator (and the author of this comment) reads that as "a plaintext .env is sitting on the
       remote" and starts hunting a leak that a missing directory cannot hold. The guard tests for
       existence, not for a directory: a non-directory sitting at the workspace path is a broken
       workspace, and `remote.workspace` must keep failing on it rather than call it unprovisioned. */
    if (result.exitCode === WORKSPACE_ABSENT_EXIT && WORKSPACE_SCOPED_PROBES.has(probe.id)) {
      return { status: "warn", detail: "remote workspace is not provisioned" };
    }
    return { status: result.exitCode === 0 ? "ok" : "fail" };
  }
  const result = await options.processes.run({
    command,
    args,
    ...(environment === undefined ? {} : { environment }),
    maxOutputBytes: CAPTURE_BYTES,
  });
  return { status: result.exitCode === 0 ? "ok" : "fail" };
}

export async function createNodeCliDependencies(options: NodeCliDependencyOptions = {}): Promise<NodeCliDependencies> {
  const home = options.home ?? homedir();
  const sourceRoot = await realpath(options.sourceRoot ?? process.cwd());
  const clientId = options.clientId ?? resolveClientIdentity(home);
  const identity = worktreeIdentity(sourceRoot, clientId);
  const processes = options.processes ?? new NodeProcessRuntime();
  const mutagenCommand = installedMutagenPath(home);
  const diagnosticSsh = options.managedSsh ?? {
    changed: false,
    directory: join(home, ".local", "share", "remote-runner", "ssh"),
    knownHostsPath: join(home, ".local", "state", "remote-runner", "known_hosts", "managed"),
  };

  const loadManifest = async (manifestPath = ".remote-runner.yaml"): Promise<ManifestV1> =>
    loadManifestText(await readFile(resolve(sourceRoot, manifestPath), "utf8"));

  let resourcesPromise:
    Promise<{ readonly managedSsh: ManagedSshTransport; readonly launcherSource: Uint8Array }> | undefined;
  const executionResources = () =>
    (resourcesPromise ??= (async () => {
      const managedSsh = options.managedSsh ?? (await ensureManagedSshTransport(home));
      const launcherSource = options.launcherSource ?? (await readLauncherSource());
      if (managedSsh.changed) {
        const stopped = await processes.run({
          command: mutagenCommand,
          args: ["daemon", "stop"],
          environment: mutagenSshEnvironment(managedSsh.directory),
          maxOutputBytes: CAPTURE_BYTES,
        });
        /* A Mutagen that is not installed has no daemon to stop, and the transport update it would
           have picked up is equally moot. ENOENT specifically, not `!spawned`: EMFILE and ENOMEM
           also fail the spawn, and there a live daemon keeps serving the ssh settings this update
           just replaced — the exact damage the throw exists to prevent. */
        if (stopped.spawnErrorCode !== "ENOENT" && stopped.exitCode !== 0) {
          throw new Error("unable to restart Mutagen after managed SSH transport update");
        }
      }
      return { managedSsh, launcherSource };
    })());

  const executeWorkload = async (
    profile: Profile,
    command: readonly string[],
    mode: RunMode,
    onUnavailable: (reason: string, detail?: string) => void,
    onRemoteChildStarted: () => void,
    telemetry: RunTelemetry,
  ): Promise<{
    readonly status: number;
    readonly provider: "remote" | "local";
    readonly remoteChildStarted: boolean;
  }> => {
    /* Local to this call's own async activation, unlike the closure-shared variables they replace:
       overlapping executeProfile calls each get their own binding, so one run's fallback to local
       can never bleed into a concurrently running remote run's record. */
    let provider: "remote" | "local" = "remote";
    let remoteChildStarted = false;
    const markRemoteChildStarted = (): void => {
      remoteChildStarted = true;
      onRemoteChildStarted();
    };
    const injected = options.executeProfile;
    if (injected !== undefined) {
      const status = await injected(profile, command, mode, {
        onUnavailable,
        onRemoteChildStarted: markRemoteChildStarted,
      });
      return { status, provider, remoteChildStarted };
    }
    const resources = await executionResources();
    const notifications = createNodeNotificationCallbacks({
      statePath: join(profileRoot(home, profile, identity), "outage.json"),
      configPath: join(home, ".claude", ".telegram-ask.conf"),
      context: { consumer: profile.consumer, profile: profile.id, remoteLabel: profile.remote.label },
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
    const services = new NodeProfileServices(profile, {
      home,
      clientId,
      sourceRoot,
      launcherSource: resources.launcherSource,
      mutagenCommand,
      managedSshPath: resources.managedSsh.directory,
      knownHostsPath: resources.managedSsh.knownHostsPath,
      processes,
      recordFallback: notifications.recordFallback,
      /* Marked before the notification, whose throw the caller swallows: a run already executing
         remotely may not report that it never started. */
      recordRemoteChildStarted: async () => {
        markRemoteChildStarted();
        await notifications.recordRemoteChildStarted();
      },
      onLocalExecution: () => {
        provider = "local";
      },
      onUnavailable,
      telemetry,
    });
    const status = await runProfile(createProfileRuntime(services, telemetry), profile, command, mode);
    return { status, provider, remoteChildStarted };
  };

  const executeProfile = async (
    profile: Profile,
    command: readonly string[],
    mode: RunMode,
    controllerEnsureMs?: number,
  ): Promise<number> => {
    const root = profileRoot(home, profile, identity);
    const logger = createJsonlLogger(
      {
        appendFile: (path, contents, mode) => appendFile(path, contents, { mode }),
        stat,
        rename,
        remove: (path) => rm(path, { force: true }),
      },
      join(root, "runner.log"),
    );
    const writeLog = async (record: unknown): Promise<void> => {
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await logger.write(record);
      } catch {
        // Diagnostics must never block or alter workload selection.
      }
    };
    const now = options.now ?? (() => new Date().toISOString());
    /* A prewarm and a manual run interleave their records in this one file, so every record of a
       run carries the same runId and the writer's pid; the operator detail stays on the paired
       run-unavailable record, which only that runId finds. */
    const runId = (options.createRunId ?? (() => randomUUID().replaceAll("-", "").slice(0, 16)))();
    /* Monotonic: a wall clock corrected backwards mid-run would otherwise report a negative run. */
    const startedMs = performance.now();
    const telemetry = new RunTelemetry();
    /* Stays outside `phases`: it precedes `startedMs`, so folding it in would over-explain the phase-sum duration. */
    const measurements = (): Record<string, unknown> => ({
      ...telemetry.snapshot(),
      ...(controllerEnsureMs === undefined ? {} : { controllerEnsureMs }),
    });
    /* The unavailable callback fires mid-run: chaining it keeps its record ahead of the terminal
       one without the workload ever waiting on a diagnostic write. */
    let unavailable: Promise<void> = Promise.resolve();
    /* The last reason reported, not a verdict on the status: emitted even when the run succeeded,
       so a fallback that ran locally still names what pushed it there. */
    let unavailableReason: string | undefined;
    await writeLog({
      at: now(),
      event: "run-start",
      runId,
      pid: process.pid,
      profile: profile.id,
      mode,
    });
    try {
      const { status, provider, remoteChildStarted } = await executeWorkload(
        profile,
        command,
        mode,
        (reason, detail) => {
          unavailableReason = reason;
          unavailable = unavailable.then(() =>
            writeLog({
              at: now(),
              event: "run-unavailable",
              runId,
              pid: process.pid,
              profile: profile.id,
              mode,
              reason,
              ...(detail === undefined ? {} : { detail }),
            }),
          );
        },
        /* Without this, a preparation that failed, retried and recovered leaves its reason for the
           workload's own exit 75 to inherit. */
        () => {
          unavailableReason = undefined;
        },
        telemetry,
      );
      await unavailable;
      await writeLog({
        at: now(),
        event: "run-finish",
        runId,
        pid: process.pid,
        profile: profile.id,
        mode,
        status,
        provider,
        /* Not derivable from `provider`: a run that failed in preparation still reports the remote
           provider. Only the start marker says the workload reached the remote. */
        remoteChildStarted,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        durationMs: Math.round(performance.now() - startedMs),
        ...measurements(),
      });
      return status;
    } catch (caught) {
      await unavailable;
      await writeLog({
        at: now(),
        event: "run-error",
        runId,
        pid: process.pid,
        profile: profile.id,
        mode,
        error: caught instanceof Error ? caught.name : "UnknownError",
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        durationMs: Math.round(performance.now() - startedMs),
        ...measurements(),
        /* Deliberately no provider field: a throw reaches here only from resource setup, before
           either path ran (runProfile absorbs execution failures into a status code), so any
           value would name a path that was never attempted. */
      });
      throw caught;
    }
  };

  const dependencies: NodeCliDependencies = {
    identity,
    environment: process.env,
    loadManifest,
    readFile: async (path) => readFile(path),
    ensureController: () => ensureNodeController(home),
    runProfile: (profile, command, mode, controllerEnsureMs) =>
      executeProfile(profile, command, mode ?? profile.mode, controllerEnsureMs),
    async enqueuePrewarm(profile, manifestPath) {
      await ensureNodeController(home);
      const controller = await new NodeControllerRuntime(home, processes).inspect();
      if (!controller.loaded || !controller.running || !controller.compatible) {
        throw new Error("remote-runner controller is unavailable for prewarm");
      }
      const absoluteManifest = await realpath(resolve(sourceRoot, manifestPath));
      const fromSource = relative(sourceRoot, absoluteManifest);
      if (fromSource === "" || fromSource === ".." || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource)) {
        throw new Error("prewarm manifest escapes the source root");
      }
      return publishPrewarmRequest(home, {
        schemaVersion: 1,
        consumer: profile.consumer,
        profile: profile.id,
        identity,
        sourceRoot,
        manifestPath: absoluteManifest,
      });
    },
    async statusProfile(profileId, manifestPath) {
      const profiles = selectedProfiles(await loadManifest(manifestPath), profileId);
      const controllerState = await new NodeControllerRuntime(home, processes).inspect();
      const controller = !controllerState.compatible ? "incompatible" : controllerState.running ? "running" : "stopped";
      const lines: string[] = [];
      for (const profile of profiles) {
        const expectedSession = mutagenSessionName(profile.consumer, profile.id, identity);
        const sessionResult = await processes.run({
          command: mutagenCommand,
          args: [...MUTAGEN_LIST_ARGUMENTS, expectedSession],
          environment: mutagenSshEnvironment(diagnosticSsh.directory),
          maxOutputBytes: CAPTURE_BYTES,
        });
        const session = sessionResult.exitCode === 0 ? sessionStatus(sessionResult.stdout, expectedSession) : "unknown";
        const remote = await inspectRemoteStatus(processes, profile, identity, diagnosticSsh.knownHostsPath, clientId);
        const outage = await inspectOutage(join(profileRoot(home, profile, identity), "outage.json"));
        const prewarm = await inspectPrewarmRequest(home, {
          consumer: profile.consumer,
          profile: profile.id,
          identity,
        });
        lines.push(
          formatStatus({
            profile: profile.id,
            controller,
            prewarm: prewarm.state,
            ...(prewarm.queue === undefined ? {} : { prewarmQueue: prewarm.queue }),
            session,
            ...remote,
            outage,
          }),
        );
      }
      return lines.join("\n");
    },
    async doctorProfile(profileId, manifestPath) {
      const profiles = selectedProfiles(await loadManifest(manifestPath), profileId);
      const reports: DoctorProfileReport[] = [];
      for (const profile of profiles) {
        reports.push({
          profile: profile.id,
          report: await doctor({
            inspect: (probe) =>
              inspectProbe(probe, profile, identity, {
                home,
                clientId,
                sourceRoot,
                knownHostsPath: diagnosticSsh.knownHostsPath,
                mutagenCommand,
                managedSshPath: diagnosticSsh.directory,
                processes,
              }),
          }),
        });
      }
      return reports;
    },
    async logsProfile(profileId, manifestPath) {
      const profiles = selectedProfiles(await loadManifest(manifestPath), profileId);
      const lines: string[] = [];
      for (const profile of profiles) {
        const logPath = join(profileRoot(home, profile, identity), "runner.log");
        const profileLines = await tailLogs({
          readRotation: (index) => readOptionalLog(index === 0 ? logPath : `${logPath}.${index}`),
        });
        lines.push(...(profileId === undefined ? profileLines.map((line) => `${profile.id} ${line}`) : profileLines));
      }
      return lines;
    },
    async readLogCorpus(corpusOptions) {
      const source = corpusRoot(home);
      const read = await readCorpus({ listDirectories: listCorpusDirectories, readLog: readCorpusLog }, source);
      return {
        provenance: {
          source,
          files: read.files,
          unparsed: read.unparsed,
          runner: await installedRunnerVersion(options.mainModuleUrl ?? INSTALLED_MAIN_MODULE_URL),
        },
        summary: summarizeCorpus(read.records, corpusOptions),
      };
    },
    async benchmarkProfile(profile) {
      await ensureNodeController(home);
      return runBenchmark(
        {
          now: options.now ?? (() => new Date().toISOString()),
          async runSample(execution: BenchmarkExecution) {
            const startedAt = performance.now();
            const status = await executeProfile(profile, execution.command, execution.location);
            const finishedAt = performance.now();
            return { elapsedMs: Math.max(0, finishedAt - startedAt), status };
          },
          async writeReceipt(path, contents) {
            const target = confinedPath(sourceRoot, path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const canonicalDirectory = await realpath(dirname(target));
            const directoryFromRoot = relative(sourceRoot, canonicalDirectory);
            if (directoryFromRoot === ".." || directoryFromRoot.startsWith(`..${sep}`) || isAbsolute(directoryFromRoot))
              throw new Error("output directory escapes source root");
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
        },
        profile,
      );
    },
  };
  return dependencies;
}
