import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import process from "node:process";

import {
  DependencyCommandError,
  ensureDependencySetup,
  packageManagerFromPackageJson,
  type HealthySetupState,
} from "../bootstrap/dependencies.js";
import { dependencyFingerprint, type EnvironmentIdentity, type GitlinkIdentity } from "../bootstrap/fingerprint.js";
import { installNode, localNodeVersion } from "../bootstrap/node.js";
import { installUv } from "../bootstrap/uv.js";
import type { Profile } from "../config/types.js";
import { NodeProcessRuntime, runStreamingProcess } from "../node/process.js";
import { ensureManagedKnownHost, mutagenSshEnvironment } from "../node/managed-ssh.js";
import { RemoteToolchainRuntime } from "../node/remote-toolchain.js";
import { acquireProfileLock, LockTimeoutError } from "../runtime/lock.js";
import { worktreeIdentity } from "../runtime/identity.js";
import type { RunPhase, RunTelemetry } from "../runtime/telemetry.js";
import { PreparationError } from "../run/prepare.js";
import { assertSafeRepositoryPath } from "../runtime/paths.js";
import { INFRASTRUCTURE_EXIT_CODE, WORKLOAD_COMMAND_REASON } from "../run/run-profile.js";
import type { RemoteExecutionResult } from "../run/run-profile.js";
import { isOutageReason, stableReason } from "../notifications/outage.js";
import { encodeSecretFrame, type SecretFrame } from "../secrets/frame.js";
import { readDotenvSecrets, runSecretProvider } from "../secrets/provider.js";
import { classifySshFailure } from "../ssh/probe.js";
import {
  runSsh,
  sshArguments,
  type BoundedProcessRequest,
  type BoundedProcessResult,
  type SshProcessRuntime,
} from "../ssh/client.js";
import { MutagenSyncLifecycle, type PausedMutagenSession } from "../sync/mutagen.js";
import { reconcileWorkspace } from "../workspace/git-workspace.js";
import {
  pruneRemoteWorkspaces,
  RemoteWorkspaceRetentionRuntime,
  type WorkspaceQuarantineResult,
  type WorkspaceRetentionCommandPort,
} from "../workspace/retention.js";
import type { ProfileExecutionServices } from "./profile-runtime.js";

export interface RemotePaths {
  readonly generatedRoot: string;
  readonly profileRoot: string;
  readonly workspace: string;
  readonly workloadLock: string;
  readonly activityMarker: string;
  readonly toolchainRoot: string;
  readonly launcher: string;
  readonly setupState: string;
}

const IDENTITY = /^[0-9a-f]{24}$/u;
const LEGACY_GENERATED_ROOT = "~/.cache/remote-runner/workspaces";

function canonicalRemotePath(value: string, label: string): void {
  if (
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/" ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} must be a canonical non-root absolute path`);
}

export function resolveRemotePaths(
  remoteHome: string,
  profile: Pick<Profile, "consumer" | "id" | "workspace">,
  identity: string,
): RemotePaths {
  canonicalRemotePath(remoteHome, "remote home");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(profile.consumer) || !/^[a-z][a-z0-9-]{0,62}$/u.test(profile.id)) {
    throw new Error("remote profile path component is invalid");
  }
  if (!IDENTITY.test(identity)) throw new Error("remote identity is invalid");
  const generatedRoot =
    profile.workspace.generatedRoot === LEGACY_GENERATED_ROOT
      ? posix.join(remoteHome, ".cache", "remote-runner", "workspaces")
      : profile.workspace.generatedRoot;
  canonicalRemotePath(generatedRoot, "generated root");
  const profileRoot = posix.join(generatedRoot, profile.consumer, profile.id);
  return {
    generatedRoot,
    profileRoot,
    workspace: posix.join(profileRoot, identity),
    workloadLock: posix.join(profileRoot, ".locks", identity),
    activityMarker: posix.join(profileRoot, ".activity", identity),
    toolchainRoot: posix.join(remoteHome, ".local", "share", "remote-runner", "toolchains"),
    launcher: posix.join(remoteHome, ".local", "share", "remote-runner", "launcher", "remote-launcher.mjs"),
    setupState: posix.join(
      remoteHome,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      profile.consumer,
      profile.id,
      identity,
      "setup.json",
    ),
  };
}

export function parseProbeOutput(
  output: string,
  minimumFreeBytes: number,
): { readonly home: string; readonly availableBytes: number } {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) {
    throw new Error("minimum free bytes must be a positive safe integer");
  }
  const records = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  if (records.length !== 2) throw new Error("remote probe returned an invalid record count");
  const [home = "", capacity = ""] = records;
  canonicalRemotePath(home, "remote home");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(capacity)) throw new Error("remote capacity is invalid");
  const availableBytes = Number(capacity);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumFreeBytes) {
    throw new Error("remote capacity is below the configured minimum");
  }
  return { home, availableBytes };
}

export function remoteChildArguments(
  node: string,
  launcher: string,
  workspace: string,
  workloadLock: string,
  pathEnvironment: string,
  profile: Pick<Profile, "workload" | "secrets">,
  command: readonly string[],
): readonly string[] {
  for (const [label, path] of [
    ["remote node", node],
    ["remote launcher", launcher],
    ["remote workspace", workspace],
    ["remote workload lock", workloadLock],
  ] as const) {
    canonicalRemotePath(path, label);
  }
  for (const path of pathEnvironment.split(":")) canonicalRemotePath(path, "remote PATH entry");
  if (command.length === 0 || command.some((argument) => argument.includes("\0"))) {
    throw new Error("remote child command is invalid");
  }
  const childEnvironment = Object.entries(profile.workload.childEnvironment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [name, value] of childEnvironment) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || value.includes("\0"))
      throw new Error("remote child environment is invalid");
  }
  return [
    "sh",
    "-ceu",
    'workspace=$1; lock=$2; shift 2; umask 077; mkdir -p -- "$(dirname -- "$lock")"; exec 9>"$lock"; flock -x 9; cd -- "$workspace"; exec "$@" 3>&2',
    "remote-runner-child",
    workspace,
    workloadLock,
    "/usr/bin/env",
    `PATH=${pathEnvironment}`,
    ...childEnvironment.map(([name, value]) => `${name}=${value}`),
    "REMOTE_RUNNER_CHILD=1",
    "REMOTE_RUNNER_PROVIDER=remote",
    node,
    launcher,
    JSON.stringify(profile.secrets.allow),
    "--",
    ...command,
  ];
}

export function remoteWorkspaceCommandArguments(
  workspace: string,
  pathEnvironment: string,
  command: readonly string[],
): readonly string[] {
  canonicalRemotePath(workspace, "remote workspace");
  for (const path of pathEnvironment.split(":")) canonicalRemotePath(path, "remote PATH entry");
  if (
    command.length === 0 ||
    command[0] === undefined ||
    command[0].length === 0 ||
    command.some((argument) => argument.includes("\0"))
  ) {
    throw new Error("remote workspace command is invalid");
  }
  return [
    "sh",
    "-ceu",
    /* Under -e a failing `cd` (workspace gone, permissions) exits with cd's own status — 1 under
       bash-as-/bin/sh, 2 under dash — which reads as the consumer's command failing and withholds
       the fallback. 125 is the conventional "the wrapper itself failed" code (env(1), timeout(1))
       and sits outside the range dependencies.ts attributes to the consumer. */
    'cd -- "$1" || exit 125; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
    "remote-runner-workspace-command",
    workspace,
    pathEnvironment,
    ...command,
  ];
}

export function remoteArtifactCheckArguments(
  workspace: string,
  pathEnvironment: string,
  artifact: string,
): readonly string[] {
  return remoteWorkspaceCommandArguments(workspace, pathEnvironment, ["test", "-f", artifact]);
}

/* The alpha-root probe for the abandoned-session sweep, where a `false` authorizes a termination, so
   absence has to be positively established rather than merely unrefuted: nothing that could hold a
   worktree is at the path, AND the directory that would contain it is readable. Every answer that
   leaves the question open — an unreadable ancestor, an I/O error, a volume that is not mounted and
   whose whole mount path is therefore missing — counts as present. The asymmetry is the point: a stale
   session left alive costs one Mutagen entry until the next run, while killing a live one breaks the
   sync under a running workload. */
export async function localWorktreeExists(root: string): Promise<boolean> {
  try {
    /* A regular file where a worktree used to be holds no worktree, and Mutagen cannot sync it as one,
       so it is treated exactly like a root that is gone. */
    if ((await stat(root)).isDirectory()) return true;
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return true;
  }
  try {
    await access(dirname(root));
    return false;
  } catch {
    return true;
  }
}

const CAPTURE_BYTES = 64 * 1024;
const LOCAL_GIT_CAPTURE_BYTES = 4 * 1024 * 1024;
/* A dependency install prints far more than the 64 KiB that bounds an ordinary control command,
   and exceeding the bound SIGKILLs the ssh mid-install — repeated on every run, because the
   healthy state is never written. */
const SETUP_CAPTURE_BYTES = 16 * 1024 * 1024;
const WORKLOAD_LOCK_BUSY_EXIT_CODE = 75;
/* A queued prewarm holds the profile lock for its whole workload, so a wait shorter than a run
   turns "someone else is already doing this" into a full duplicate run on the laptop. */
const LOCK_WAIT_MS = 15 * 60 * 1000;
const LOCK_WAIT_NOTICE_MS = 2 * 1000;
const UV_VERSION = "0.11.30";
const UV_SHA256 = {
  x86_64: "04bc7d180d6138bf6dc08387acf507a823f397a98fea55da36b0ccc7fbce3b68",
  aarch64: "8c11d90f5f66d232930cf8ae3a085c39877690d409e10878234802b028b20e2a",
} as const;
const CHILD_MARKER = new TextEncoder().encode("RR_CHILD_STARTED\n");
/* Mirrors assets/remote-launcher.mjs: the launcher exits with this before the marker when the
   workload command itself cannot be executed. Only the launcher emits it pre-marker, so a broken
   remote shell (126/127) still reads as an outage. */
const WORKLOAD_SPAWN_EXIT_CODE = 69;
const SSH_FAILURE_EXIT_CODE = 255;
/* Kept apart from `child-start`: both are the remote going away, but this one happens to a machine
   that had already accepted the workload, so it leaves side effects of unknown extent behind and is
   never answered by a local rerun. The operator needs the two told apart in the alert. */
const CONNECTION_LOST_REASON = "connection-lost";

function decode(contents: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
}

/* Prefix is one of " " (current), "+" (working copy ahead of the index — its sha IS the checked-out
   commit, which is what Mutagen replicates and therefore what we want), "-" (not initialized — the
   sha is the recorded index gitlink while the working copy is empty, so it would not change across
   `git submodule update --init`), or "U" (merge conflict — git prints an all-zero oid, so every
   conflicted state fingerprints identically). Only " " and "+" name a usable working-copy commit;
   the describe suffix mirrors `git describe --contains --all` and is absent only when git can
   resolve no describe at all, which is rare once a submodule is initialized. */
const SUBMODULE_STATUS_LINE = /^([ +\-U])([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/u;
const SUBMODULE_STATUS_DESCRIBE = / \(.*\)$/u;

function parseSubmoduleStatus(output: Uint8Array): GitlinkIdentity[] {
  const text = decode(output, "submodule status listing");
  if (text.length === 0) return [];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return lines.map((line) => {
    const match = SUBMODULE_STATUS_LINE.exec(line);
    if (match === null) throw new Error("submodule status line is malformed");
    const prefix = match[1]!;
    const oid = match[2]!;
    const rest = match[3]!;
    const describe = SUBMODULE_STATUS_DESCRIBE.exec(rest);
    const path = describe ? rest.slice(0, -describe[0].length) : rest;
    if (prefix !== " " && prefix !== "+") {
      throw new Error(`submodule ${path} has an unusable status prefix "${prefix}"`);
    }
    return { oid, path };
  });
}

function checkedGitOutput(result: Awaited<ReturnType<SshProcessRuntime["run"]>>, label: string): Uint8Array {
  if (
    result.exitCode !== 0 ||
    result.outputTruncated ||
    result.stdout.byteLength > LOCAL_GIT_CAPTURE_BYTES ||
    result.stderr.byteLength > LOCAL_GIT_CAPTURE_BYTES
  ) {
    throw new Error(`local Git inspection failed for ${label}`);
  }
  return result.stdout;
}

/* Reports the submodule's checked-out working-copy commit, not the superproject's committed
   gitlink oid: Mutagen replicates the working copy, so fingerprinting the committed oid would
   cache-hit stale bootstrap artefacts against a submodule that was checked out to a new SHA but
   not yet committed in the superproject. */
export async function listLocalGitlinks(processes: SshProcessRuntime, sourceRoot: string): Promise<GitlinkIdentity[]> {
  const result = await processes.run({
    command: "git",
    args: ["submodule", "status", "--recursive"],
    cwd: sourceRoot,
    maxOutputBytes: LOCAL_GIT_CAPTURE_BYTES,
  });
  return parseSubmoduleStatus(checkedGitOutput(result, "submodule status listing"));
}

function parseNulPaths(output: Uint8Array, label: string): string[] {
  const value = decode(output, label);
  if (value.length === 0) return [];
  if (!value.endsWith("\0")) throw new Error(`${label} returned a malformed path list`);
  return value
    .slice(0, -1)
    .split("\0")
    .map((path) => {
      const normalized = assertSafeRepositoryPath(path);
      if (normalized !== path || /[\u0000-\u001f\u007f]/u.test(path)) {
        throw new Error(`${label} returned an unsafe repository path`);
      }
      return path;
    });
}

export async function listLocalFingerprintFiles(
  processes: SshProcessRuntime,
  sourceRoot: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const pathspecs = patterns.map((pattern) => `:(glob)${pattern}`);
  const [availableResult, deletedResult] = await Promise.all([
    processes.run({
      command: "git",
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
      cwd: sourceRoot,
      maxOutputBytes: LOCAL_GIT_CAPTURE_BYTES,
    }),
    processes.run({
      command: "git",
      args: ["ls-files", "-z", "--deleted", "--", ...pathspecs],
      cwd: sourceRoot,
      maxOutputBytes: LOCAL_GIT_CAPTURE_BYTES,
    }),
  ]);
  const available = parseNulPaths(
    checkedGitOutput(availableResult, "fingerprint file listing"),
    "fingerprint file listing",
  );
  const deleted = new Set(
    parseNulPaths(checkedGitOutput(deletedResult, "fingerprint deletion listing"), "fingerprint deletion listing"),
  );
  return [...new Set(available.filter((path) => !deleted.has(path)))].sort();
}

/* The aggregate follows the services instance, so a controller connection or a concurrent run — each
   with its own instance — never lands in it. */
function timedSshProcesses(processes: NodeProcessRuntime, telemetry: RunTelemetry): NodeProcessRuntime {
  return {
    run: (request) =>
      request.command === "ssh" ? telemetry.measureSsh(() => processes.run(request)) : processes.run(request),
    isAlive: (pid) => processes.isAlive(pid),
  };
}

function timedSshStream(
  streamProcess: typeof runStreamingProcess,
  telemetry: RunTelemetry,
): typeof runStreamingProcess {
  return (request) =>
    request.command === "ssh" ? telemetry.measureSsh(() => streamProcess(request)) : streamProcess(request);
}

export interface NodeProfileServicesOptions {
  readonly home: string;
  readonly sourceRoot: string;
  readonly knownHostsPath?: string;
  readonly mutagenCommand?: string;
  readonly managedSshPath?: string;
  readonly launcherSource: Uint8Array;
  readonly processes?: NodeProcessRuntime;
  readonly streamProcess?: typeof runStreamingProcess;
  readonly stdout?: (chunk: Uint8Array) => void;
  readonly stderr?: (chunk: Uint8Array) => void;
  readonly recordFallback?: (reason: string) => Promise<void>;
  readonly recordRemoteChildStarted?: () => Promise<void>;
  readonly onLocalExecution?: () => void;
  readonly onUnavailable?: (reason: string, detail?: string) => void;
  readonly telemetry?: RunTelemetry;
}

export class NodeProfileServices implements ProfileExecutionServices {
  private readonly processes: NodeProcessRuntime;
  private readonly identity: string;
  private readonly stateRoot: string;
  private readonly lockRoot: string;
  private readonly knownHostsPath: string;
  private readonly mutagen: MutagenSyncLifecycle;
  private readonly streamProcess: typeof runStreamingProcess;
  private pausedSession: PausedMutagenSession | undefined;
  private remotePaths?: RemotePaths;
  private nodeRoot?: string;
  private uvRoot?: string;

  constructor(
    private readonly profile: Profile,
    private readonly options: NodeProfileServicesOptions,
  ) {
    canonicalRemotePath(options.home, "local home");
    if (!join(options.sourceRoot).startsWith("/")) throw new Error("source root must be absolute");
    const processes = options.processes ?? new NodeProcessRuntime();
    const streamProcess = options.streamProcess ?? runStreamingProcess;
    const telemetry = options.telemetry;
    this.processes = telemetry === undefined ? processes : timedSshProcesses(processes, telemetry);
    this.streamProcess = telemetry === undefined ? streamProcess : timedSshStream(streamProcess, telemetry);
    this.identity = worktreeIdentity(options.sourceRoot);
    this.stateRoot = join(options.home, ".local", "state", "remote-runner");
    this.lockRoot = join(this.stateRoot, "locks");
    this.knownHostsPath = options.knownHostsPath ?? join(this.stateRoot, "known_hosts", "managed");
    const mutagenCommand = options.mutagenCommand ?? "mutagen";
    this.mutagen = new MutagenSyncLifecycle(
      {
        run: (request) =>
          this.processes.run({
            ...request,
            command: request.command === "mutagen" ? mutagenCommand : request.command,
            ...(options.managedSshPath === undefined
              ? {}
              : { environment: mutagenSshEnvironment(options.managedSshPath, request.environment) }),
          }),
      },
      { now: () => performance.now() },
    );
  }

  /* Widens RemoteCommandPort's result to the bounded one, which the bootstrap callbacks need: only
     `spawned` separates a remote command that failed from an ssh client that never started, and
     that difference decides whether the consumer is blamed. Still assignable to RemoteCommandPort. */
  private remote(captureBytes = CAPTURE_BYTES): { run(args: readonly string[]): Promise<BoundedProcessResult> } {
    return {
      run: (args) =>
        runSsh(
          this.processes,
          this.profile.remote.target,
          args,
          this.profile.probes.connectTimeoutSeconds,
          this.knownHostsPath,
          captureBytes,
        ),
    };
  }

  private retentionCommands(): WorkspaceRetentionCommandPort {
    return {
      run: (args) => this.remote().run(args),
      withLock: async (args, cleanup): Promise<WorkspaceQuarantineResult> => {
        const lock = args[5];
        if (lock === undefined) throw new Error("workspace retention lock command is malformed");
        canonicalRemotePath(lock, "workspace retention lock");
        let owned = false;
        try {
          const release = new TextEncoder().encode("release\n");
          const result = await this.streamProcess({
            command: "ssh",
            args: sshArguments(
              this.profile.remote.target,
              args,
              this.profile.probes.connectTimeoutSeconds,
              this.knownHostsPath,
            ),
            marker: new TextEncoder().encode("\0REMOTE_RUNNER_RETENTION_LOCKED\0"),
            releaseAfterMarker: release,
            onMarker: async () => {
              owned = true;
              await cleanup();
            },
            stdout: () => undefined,
            stderr: this.options.stderr ?? (() => undefined),
          });
          if (!result.spawned) throw new Error("workspace retention SSH did not start");
          if (result.markerSeen) {
            if (result.exitCode !== 0) throw new Error(`workspace retention lock exited ${result.exitCode}`);
            return "removed";
          }
          if (result.exitCode === 75) return "locked";
          if (result.exitCode === 76) return "missing";
          if (result.exitCode === 77) return "unsafe";
          if (result.exitCode === 78) return "refreshed";
          throw new Error(`workspace retention lock failed with exit code ${result.exitCode}`);
        } finally {
          if (owned) {
            const removal = await this.remote().run(["rm", "-f", "--", lock]);
            if (removal.exitCode !== 0) throw new Error("workspace retention lock removal failed");
          }
        }
      },
    };
  }

  private async pruneRetention(): Promise<void> {
    const paths = this.paths();
    const policy = this.profile.workspace.retention;
    let retentionFailure: unknown;
    if (policy !== undefined) {
      const setupStateRoot = posix.dirname(posix.dirname(paths.setupState));
      const runtime = new RemoteWorkspaceRetentionRuntime(
        this.retentionCommands(),
        {
          profileRoot: paths.profileRoot,
          setupStateRoot,
          mirror: posix.join(paths.generatedRoot, this.profile.consumer, ".mirror.git"),
          privateRefPrefix: `refs/remote-runner/${this.profile.consumer}/${this.profile.id}`,
        },
        (identity) =>
          this.mutagen.terminateOwned({
            consumer: this.profile.consumer,
            profile: this.profile.id,
            identity,
            betaTarget: this.profile.remote.target,
            betaRoot: posix.join(paths.profileRoot, identity),
          }),
      );
      try {
        await pruneRemoteWorkspaces(runtime, this.identity, policy, () =>
          randomUUID().replaceAll("-", "").slice(0, 16),
        );
      } catch (caught) {
        /* Held, not propagated: the two cleanups share nothing but this call site, so neither may be
           the reason the other is skipped. Whichever failed still reaches the operator as the single
           post-workload cleanup warning. */
        retentionFailure = caught;
      }
    }
    /* Last, and outside the policy check. Outside, because a leaked session is local state that no
       retention policy governs, so a profile configuring none still has to stop accumulating them;
       last, because a sweep that throws — a stopped daemon, a listing this runner refuses to read —
       must not be what keeps the remote prune from reclaiming a checkout's worth of disk. */
    await this.mutagen.terminateAbandoned({
      consumer: this.profile.consumer,
      profile: this.profile.id,
      betaTarget: this.profile.remote.target,
      profileRoot: paths.profileRoot,
      alphaExists: localWorktreeExists,
    });
    if (retentionFailure !== undefined) throw retentionFailure;
  }

  async validate(): Promise<void> {
    await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    await ensureManagedKnownHost(this.processes, {
      target: this.profile.remote.target,
      trustedFingerprint: this.profile.remote.hostKeySha256,
      knownHostsPath: this.knownHostsPath,
      connectTimeoutSeconds: this.profile.probes.connectTimeoutSeconds,
    });
  }

  async acquireLock(): Promise<() => Promise<void>> {
    const files = {
      mkdir: async (path: string) => {
        await mkdir(path, { mode: 0o700 });
      },
      readFile: async (path: string) => new Uint8Array(await readFile(path)),
      writeFile: async (path: string, contents: Uint8Array, mode: number) => {
        await writeFile(path, contents, { flag: "wx", mode });
      },
      symlink: async (target: string, path: string) => {
        await symlink(target, path);
      },
      readlink: (path: string) => readlink(path),
      readdir: (path: string) => readdir(path),
      /* lstat, not stat: the age of a quarantined symlink is the age of the link itself, and its
         target may not exist at all. */
      modifiedAt: async (path: string) => (await lstat(path)).mtimeMs,
      rename: async (from: string, to: string) => {
        await rename(from, to);
      },
      remove: async (path: string) => {
        await rm(path, { recursive: true });
      },
    };
    const notice = setTimeout(() => {
      this.write("remote-runner: another run holds this workspace; waiting for it to finish\n");
    }, LOCK_WAIT_NOTICE_MS);
    try {
      return await acquireProfileLock(
        {
          files,
          processes: this.processes,
          clock: {
            now: () => Date.now(),
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          },
          lockDirectory: (identity) => join(this.lockRoot, identity),
          pid: process.pid,
          leaseDurationMs: 120_000,
          pollIntervalMs: 100,
          createToken: randomUUID,
        },
        this.identity,
        LOCK_WAIT_MS,
      );
    } catch (caught) {
      /* Waiting out a concurrent run is the point; falling back to a local duplicate of the very
         workload that already holds the lock is not, so the timeout is offered for another wait. */
      if (caught instanceof LockTimeoutError) throw new PreparationError("lock", true, { cause: caught });
      throw caught;
    } finally {
      clearTimeout(notice);
    }
  }

  async probe(): Promise<void> {
    const homeResult = await runSsh(
      this.processes,
      this.profile.remote.target,
      ["sh", "-ceu", 'home=$(realpath -- "${HOME:?}"); printf \'%s\\n\' "$home"', "remote-runner-home-probe"],
      this.profile.probes.connectTimeoutSeconds,
      this.knownHostsPath,
      CAPTURE_BYTES,
    );
    if (homeResult.exitCode !== 0) {
      const reason = classifySshFailure(decode(homeResult.stderr, "SSH home probe"), homeResult);
      throw new PreparationError(reason, true);
    }
    const remoteHome = decode(homeResult.stdout, "SSH home probe").replace(/\r?\n$/u, "");
    try {
      canonicalRemotePath(remoteHome, "remote home");
    } catch (caught) {
      throw new PreparationError("remote-shell", false, { cause: caught });
    }
    const paths = resolveRemotePaths(remoteHome, this.profile, this.identity);
    const capacityResult = await runSsh(
      this.processes,
      this.profile.remote.target,
      [
        "sh",
        "-ceu",
        'umask 077; root=$1; mkdir -p -- "$root"; resolved=$(realpath -- "$root"); [ "$resolved" = "$root" ] || exit 73; blocks=$(df -Pk -- "$resolved" | awk \'NR==2 {print $4}\'); case "$blocks" in *[!0-9]*|"") exit 74;; esac; printf \'%s\\n\' "$((blocks * 1024))"',
        "remote-runner-capacity-probe",
        paths.generatedRoot,
      ],
      this.profile.probes.connectTimeoutSeconds,
      this.knownHostsPath,
      CAPTURE_BYTES,
    );
    if (capacityResult.exitCode !== 0) {
      if (capacityResult.exitCode === 73) throw new PreparationError("workspace", false);
      const reason = classifySshFailure(decode(capacityResult.stderr, "SSH capacity probe"), capacityResult);
      throw new PreparationError(reason, true);
    }
    const capacity = decode(capacityResult.stdout, "SSH capacity probe").trim();
    if (!/^(?:0|[1-9][0-9]*)$/u.test(capacity)) throw new PreparationError("capacity", false);
    const availableBytes = Number(capacity);
    if (!Number.isSafeInteger(availableBytes) || availableBytes < this.profile.probes.minimumFreeBytes) {
      throw new PreparationError("capacity", false);
    }
    this.remotePaths = paths;
  }

  private paths(): RemotePaths {
    if (this.remotePaths === undefined) throw new Error("remote paths are unavailable before probe");
    return this.remotePaths;
  }

  private span<T>(phase: RunPhase, run: () => Promise<T>): Promise<T> {
    const telemetry = this.options.telemetry;
    return telemetry === undefined ? run() : telemetry.measure(phase, run);
  }

  private async touchActivity(): Promise<void> {
    const paths = this.paths();
    const marker = paths.activityMarker;
    /* The workload lock is held by the remote child for the whole run, so an unbounded flock here
       hangs the second run silently and without end. The bounded wait turns that into a retryable
       lock failure instead. The lock itself stays: it fences the marker against `git reset --hard`. */
    const result = await this.remote().run([
      "sh",
      "-ceu",
      'umask 077; marker=$1; lock=$2; mkdir -p -- "$(dirname -- "$marker")" "$(dirname -- "$lock")"; exec 9>"$lock"; flock -w 60 9 || exit 75; : >"$marker"',
      "remote-runner-touch-activity",
      marker,
      paths.workloadLock,
    ]);
    if (result.exitCode === WORKLOAD_LOCK_BUSY_EXIT_CODE) throw new PreparationError("lock", true);
    if (result.exitCode !== 0) throw new Error("remote activity marker update failed");
  }

  async pauseSync(): Promise<void> {
    const paths = this.paths();
    await this.touchActivity();
    this.pausedSession = await this.mutagen.pauseForGitReconcile({
      consumer: this.profile.consumer,
      profile: this.profile.id,
      identity: this.identity,
      canonicalAlphaRoot: await realpath(this.options.sourceRoot),
      betaTarget: this.profile.remote.target,
      betaRoot: paths.workspace,
      ignores: this.profile.sync.ignores,
    });
  }

  async reconcileWorkspace(): Promise<void> {
    const paths = this.paths();
    const result = await reconcileWorkspace(
      {
        consumer: this.profile.consumer,
        profile: this.profile.id,
        sourceRoot: this.options.sourceRoot,
        remoteTarget: this.profile.remote.target,
        generatedRoot: paths.generatedRoot,
        ...(this.profile.workspace.baseRef === undefined ? {} : { baseRef: this.profile.workspace.baseRef }),
        knownHostsPath: this.knownHostsPath,
        connectTimeoutSeconds: this.profile.probes.connectTimeoutSeconds,
      },
      this.processes,
    );
    if (result.identity !== this.identity || result.remoteRoot !== paths.workspace) {
      throw new Error("remote workspace identity changed during reconciliation");
    }
  }

  async resumeAndFlush(): Promise<void> {
    if (this.pausedSession === undefined) throw new Error("Mutagen session was not paused");
    const descriptor = this.pausedSession;
    this.pausedSession = undefined;
    const { flushDurationMs } = await this.mutagen.resumeAndFlush(descriptor);
    /* Moved out of `sync-resume`, not added beside it — that span already covers the flush's time. */
    this.options.telemetry?.add("sync-flush", flushDurationMs);
    this.options.telemetry?.add("sync-resume", -flushDurationMs);
  }

  private async writeRemoteState(path: string, state: HealthySetupState): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
    const result = await this.remote().run([
      "sh",
      "-ceu",
      'umask 077; path=$1; value=$2; mkdir -p -- "$(dirname -- "$path")"; temporary="$path.tmp.$$"; printf \'%s\' "$value" | base64 -d >"$temporary"; chmod 600 "$temporary"; mv -f -- "$temporary" "$path"',
      "remote-runner-write-state",
      path,
      encoded,
    ]);
    if (result.exitCode !== 0) throw new Error("remote setup state write failed");
  }

  private async installLauncher(path: string): Promise<void> {
    const source = this.options.launcherSource;
    const digest = createHash("sha256").update(source).digest("hex");
    const encoded = Buffer.from(source).toString("base64");
    const result = await this.remote().run([
      "sh",
      "-ceu",
      'umask 077; path=$1; expected=$2; value=$3; mkdir -p -- "$(dirname -- "$path")"; if [ -f "$path" ] && [ "$(sha256sum -- "$path" | awk \'{print $1}\')" = "$expected" ]; then exit 0; fi; temporary="$path.tmp.$$"; printf \'%s\' "$value" | base64 -d >"$temporary"; [ "$(sha256sum -- "$temporary" | awk \'{print $1}\')" = "$expected" ]; chmod 700 "$temporary"; mv -f -- "$temporary" "$path"',
      "remote-runner-install-launcher",
      path,
      digest,
      encoded,
    ]);
    if (result.exitCode !== 0) throw new Error("remote launcher installation failed");
  }

  async bootstrap(): Promise<void> {
    const paths = this.paths();
    const remote = this.remote();
    const setupRemote = this.remote(SETUP_CAPTURE_BYTES);
    const machineResult = await remote.run(["uname", "-m"]);
    if (machineResult.exitCode !== 0) throw new Error("remote architecture probe failed");
    const machine = decode(machineResult.stdout, "remote architecture").trim();
    const packageManager = packageManagerFromPackageJson(
      new Uint8Array(await readFile(join(this.options.sourceRoot, this.profile.bootstrap.packageManager))),
    );
    const toolchains = new RemoteToolchainRuntime(remote, paths.toolchainRoot);
    const node = await installNode(toolchains, {
      version: localNodeVersion(),
      machine,
      packageManager,
      toolchainRoot: paths.toolchainRoot,
    });
    const uvDigest = machine === "x86_64" || machine === "amd64" ? UV_SHA256.x86_64 : UV_SHA256.aarch64;
    const uv = await installUv(toolchains, {
      version: UV_VERSION,
      machine,
      sha256: uvDigest,
      toolchainRoot: paths.toolchainRoot,
    });
    this.nodeRoot = node.root;
    this.uvRoot = uv.root;
    await this.installLauncher(paths.launcher);
    const environment: EnvironmentIdentity = {
      node: node.version,
      packageManager,
      uv: UV_VERSION,
    };
    const discoveredFingerprintFiles = await listLocalFingerprintFiles(
      this.processes,
      this.options.sourceRoot,
      this.profile.bootstrap.fingerprint.patterns,
    );
    const fingerprintFiles = [...new Set([...this.profile.bootstrap.fingerprint.files, ...discoveredFingerprintFiles])];
    const fingerprint = await dependencyFingerprint(
      {
        readFile: async (path) => new Uint8Array(await readFile(join(this.options.sourceRoot, path))),
        listGitlinks: () => listLocalGitlinks(this.processes, this.options.sourceRoot),
        sha256: async (contents) => createHash("sha256").update(contents).digest("hex"),
      },
      { environment, files: fingerprintFiles },
    );
    const pathEnvironment = [
      posix.join(node.root, "bin"),
      uv.root,
      posix.join(paths.workspace, ".tools"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":");
    await ensureDependencySetup(
      {
        readHealthyState: async () => {
          const result = await remote.run(["cat", "--", paths.setupState]);
          if (result.exitCode !== 0) return undefined;
          try {
            return JSON.parse(decode(result.stdout, "remote setup state")) as HealthySetupState;
          } catch {
            return undefined;
          }
        },
        checkArtifact: async (artifact, workspaceRoot) => {
          const result = await remote.run(remoteArtifactCheckArguments(workspaceRoot, pathEnvironment, artifact));
          return { exitCode: result.exitCode, spawned: result.spawned };
        },
        runSetup: async (script, workspaceRoot) => {
          const result = await setupRemote.run(
            remoteWorkspaceCommandArguments(workspaceRoot, pathEnvironment, [script]),
          );
          return { exitCode: result.exitCode, spawned: result.spawned };
        },
        runEnsure: async (command, workspaceRoot) => {
          const result = await setupRemote.run(
            remoteWorkspaceCommandArguments(workspaceRoot, pathEnvironment, command),
          );
          return { exitCode: result.exitCode, spawned: result.spawned };
        },
        writeHealthyState: (state) => this.writeRemoteState(paths.setupState, state),
      },
      {
        fingerprint,
        environment,
        workspaceRoot: paths.workspace,
        setup: this.profile.bootstrap.setup,
        artifacts: this.profile.bootstrap.artifacts,
        ensure: this.profile.bootstrap.ensure,
      },
    ).catch((caught: unknown) => {
      /* The consumer's own setup command ran on the remote and exited non-zero. Reported as
         `bootstrap` it claimed the workstation was down and bought a local fallback run that fails
         the same way; its own reason raises no outage and stays remote-only. */
      if (caught instanceof DependencyCommandError) {
        throw new PreparationError("consumer-setup", false, { cause: caught });
      }
      throw caught;
    });
  }

  async collectSecrets(): Promise<Readonly<Record<string, string>>> {
    if (this.profile.secrets.dotenv !== undefined) {
      const contents = await readFile(join(this.options.sourceRoot, this.profile.secrets.dotenv), "utf8");
      return readDotenvSecrets(contents, this.profile.secrets.allow);
    }
    if (this.profile.secrets.provider === undefined) {
      throw new Error("validated profile has no secret source");
    }
    return runSecretProvider(
      {
        run: (request: BoundedProcessRequest) =>
          this.processes.run({
            ...request,
            cwd: this.options.sourceRoot,
          }),
      },
      this.profile.secrets.provider,
      this.profile.secrets.allow,
    );
  }

  async startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ): Promise<RemoteExecutionResult> {
    const telemetry = this.options.telemetry;
    const stopChildStart = telemetry?.start("child-start");
    let stopWorkload: (() => void) | undefined;
    const paths = this.paths();
    if (this.nodeRoot === undefined) throw new Error("remote Node is unavailable before bootstrap");
    if (this.uvRoot === undefined) throw new Error("remote uv is unavailable before bootstrap");
    const pathEnvironment = [
      posix.join(this.nodeRoot, "bin"),
      this.uvRoot,
      posix.join(paths.workspace, ".tools"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":");
    let frame: SecretFrame;
    try {
      frame = encodeSecretFrame(secrets, this.profile.secrets.allow);
    } catch {
      /* Collection already validated every name and each individual value (secrets/provider.ts),
         so what still fails here is chiefly the aggregate frame limit no single-value check sees.
         That is the same preparation step failing, not a child that failed to start, so it carries
         the reason the collection half already uses. */
      stopChildStart?.();
      return { kind: "not-started", reason: "secrets" };
    }
    const result = await this.streamProcess({
      command: "ssh",
      args: sshArguments(
        this.profile.remote.target,
        remoteChildArguments(
          posix.join(this.nodeRoot, "bin", "node"),
          paths.launcher,
          paths.workspace,
          paths.workloadLock,
          pathEnvironment,
          this.profile,
          command,
        ),
        this.profile.probes.connectTimeoutSeconds,
        this.knownHostsPath,
      ),
      stdin: frame.stdin,
      marker: CHILD_MARKER,
      onMarker: async () => {
        stopChildStart?.();
        stopWorkload = telemetry?.start("workload");
        await onChildStarted();
      },
      stdout:
        this.options.stdout ??
        ((chunk) => {
          process.stdout.write(chunk);
        }),
      stderr:
        this.options.stderr ??
        ((chunk) => {
          process.stderr.write(chunk);
        }),
    }).finally(() => {
      /* Also on a rejected stream, which is where the workload the spans describe really ended. */
      stopChildStart?.();
      stopWorkload?.();
    });
    if (!result.spawned || !result.markerSeen) {
      const workloadCommand = result.spawned && result.exitCode === WORKLOAD_SPAWN_EXIT_CODE;
      return { kind: "not-started", reason: workloadCommand ? WORKLOAD_COMMAND_REASON : "child-start" };
    }
    try {
      await this.span("post-activity", () => this.touchActivity());
      await this.span("retention", () => this.pruneRetention());
    } catch {
      /* Through `write`, because this line runs AFTER the marker: an inline writer that throws here
         escapes startRemote, and the run gives up with exit 75 — losing the very workload exit this
         message promises to preserve. */
      this.write("remote-runner: workspace retention cleanup failed; workload exit preserved\n");
    }
    /* `result.exitCode` is the ssh CLIENT's, and ssh reports its own failures as 255. After the
       child marker that means the connection died mid-run: the workload may have done arbitrary
       work and its real result is unknown, so presenting 255 as the workload's exit is a lie the
       consumer's CI would read as a verdict. The launcher never exits 255 of its own (64, 69, 70,
       or the workload's code), so the only ambiguity left is a workload that genuinely exits 255 —
       it is read as a dropped connection until the stream protocol carries an exit marker emitted
       by the launcher. No fallback either: the workload already started remotely, so a local rerun
       would repeat side effects that may already have landed.
       The remote is nevertheless down, and a drop one minute earlier would have alerted — so this
       one alerts too, on the same channel. Without it the only trace is exit 75, which names four
       other conditions. */
    if (result.exitCode === SSH_FAILURE_EXIT_CODE) {
      this.write("remote-runner: ssh connection dropped mid-run; the workload result is unknown\n");
      this.reportUnavailable(CONNECTION_LOST_REASON);
      try {
        await this.recordOutage(CONNECTION_LOST_REASON);
      } catch {
        /* The workload has already run; a notification that cannot be delivered may not change what
           the caller is told about it. */
      }
      return { kind: "completed", exitCode: INFRASTRUCTURE_EXIT_CODE };
    }
    return { kind: "completed", exitCode: result.exitCode };
  }

  async runLocal(command: readonly string[], prepared?: Readonly<Record<string, string>>): Promise<number> {
    /* The same allowlisted values the remote child would have carried: without them a fallback runs
       a DIFFERENT workload than the remote leg, and whether that difference reads as a failure or
       as a green depends on how each consumer's guards treat an absent value — a dependency this
       runner must not have. `prepared` is the snapshot the preparation already collected for the
       remote child, reused so the substituted run carries what the substituted-for one would have,
       and so a provider with side effects is not invoked twice; only a run that never got that far
       collects here. Values that cannot be collected fail the run closed rather than running a
       workload the remote would not have run. Spread last, matching the remote launcher, which
       merges them over an environment that already carries the markers. */
    const secrets =
      prepared ??
      (await this.collectSecrets().catch((caught: unknown) => {
        this.reportUnavailable("secrets", "the local run cannot carry the profile's secrets");
        throw caught;
      }));
    /* After the collection, not before: this callback is the only thing that stamps the run record
       with `provider: "local"`, and a record naming a leg whose workload never started is the same
       lie the run-error path refuses to tell. */
    this.options.onLocalExecution?.();
    const result = await this.streamProcess({
      command: command[0]!,
      args: command.slice(1),
      cwd: this.options.sourceRoot,
      environment: {
        ...this.profile.workload.childEnvironment,
        REMOTE_RUNNER_CHILD: "1",
        REMOTE_RUNNER_PROVIDER: "local",
        ...secrets,
      },
      marker: new TextEncoder().encode("\0REMOTE_RUNNER_UNUSED_MARKER\0"),
      onMarker: async () => undefined,
      stdout:
        this.options.stdout ??
        ((chunk) => {
          process.stdout.write(chunk);
        }),
      stderr:
        this.options.stderr ??
        ((chunk) => {
          process.stderr.write(chunk);
        }),
    });
    return result.exitCode;
  }

  async recordFallback(reason: string): Promise<void> {
    /* reason crosses into a log line and a persistence callback, so it is mapped to the closed
       notification-reason set here, at the boundary, rather than trusted from the caller. */
    this.write(`remote-runner: running locally (fallback reason=${stableReason(reason)})\n`);
    await this.recordOutage(reason);
  }

  /* Separate from recordFallback because an outage is not always a fallback: a run on a
     `fallback: fail` profile and a connection lost after the workload started both raise one with
     no local run to announce.
     Known and accepted ceiling: if the earlier `recordRemoteChildStarted` threw, profile-runtime
     swallowed it and the notification state still has an outage open under the PREVIOUS reason — so
     this call dedupes into silence, and the next healthy run sends a recovery naming that stale
     reason. Narrow (the state write itself has to fail) and noticed, not overlooked. */
  async recordOutage(reason: string): Promise<void> {
    /* The operator still sees the stderr line; only the outage channel is spared reasons that say
       nothing about the remote being reachable. */
    const stable = stableReason(reason);
    if (isOutageReason(stable)) await this.options.recordFallback?.(stable);
  }

  async recordRemoteChildStarted(): Promise<void> {
    await this.options.recordRemoteChildStarted?.();
  }

  reportUnavailable(reason: string, detail?: string): void {
    this.write(
      `remote-runner: remote unavailable reason=${reason}${detail === undefined ? "" : ` detail=${detail}`}\n`,
    );
    this.options.onUnavailable?.(reason, detail);
  }

  /* Every caller prints the operator's line BEFORE the durable half of the same report — the
     runner-log callback in reportUnavailable, recordOutage in recordFallback. A stderr writer that
     throws must not take that stored fact down with it: the console line is the losable half. */
  private write(text: string): void {
    try {
      (
        this.options.stderr ??
        ((chunk) => {
          process.stderr.write(chunk);
        })
      )(new TextEncoder().encode(text));
    } catch {
      /* there is nowhere left to report a failing report */
    }
  }
}
