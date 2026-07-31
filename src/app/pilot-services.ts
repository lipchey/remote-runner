import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import process from "node:process";

import { ensureDependencySetup, packageManagerFromPackageJson, type HealthySetupState } from "../bootstrap/dependencies.js";
import { dependencyFingerprint, type EnvironmentIdentity, type GitlinkIdentity } from "../bootstrap/fingerprint.js";
import { installNode, localNodeVersion } from "../bootstrap/node.js";
import { installUv } from "../bootstrap/uv.js";
import type { Profile } from "../config/types.js";
import { NodeProcessRuntime, runStreamingProcess } from "../node/process.js";
import { ensureManagedKnownHost, mutagenSshEnvironment } from "../node/managed-ssh.js";
import { RemoteToolchainRuntime, type RemoteCommandPort } from "../node/remote-toolchain.js";
import { acquireProfileLock } from "../runtime/lock.js";
import { worktreeIdentity } from "../runtime/identity.js";
import { PreparationError } from "../run/prepare.js";
import type { RemoteExecutionResult } from "../run/run-profile.js";
import { encodeSecretFrame } from "../secrets/frame.js";
import { runSecretProvider } from "../secrets/provider.js";
import { classifySshFailure } from "../ssh/probe.js";
import {
  runSsh,
  sshArguments,
  type BoundedProcessRequest,
  type SshProcessRuntime,
} from "../ssh/client.js";
import { MutagenSyncLifecycle, type PausedMutagenSession } from "../sync/mutagen.js";
import { reconcileWorkspace } from "../workspace/git-workspace.js";
import type { ProfileExecutionServices } from "./profile-runtime.js";

export interface RemotePaths {
  readonly generatedRoot: string;
  readonly workspace: string;
  readonly toolchainRoot: string;
  readonly launcher: string;
  readonly setupState: string;
}

const IDENTITY = /^[0-9a-f]{24}$/u;

function canonicalRemotePath(value: string, label: string): void {
  if (
    !posix.isAbsolute(value) || posix.normalize(value) !== value || value === "/" ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${label} must be a canonical non-root absolute path`);
}

export function resolveRemotePaths(
  remoteHome: string,
  profile: Pick<Profile, "consumer" | "id">,
  identity: string,
): RemotePaths {
  canonicalRemotePath(remoteHome, "remote home");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(profile.consumer) || !/^[a-z][a-z0-9-]{0,62}$/u.test(profile.id)) {
    throw new Error("remote profile path component is invalid");
  }
  if (!IDENTITY.test(identity)) throw new Error("remote identity is invalid");
  const generatedRoot = posix.join(remoteHome, ".cache", "remote-runner", "workspaces");
  return {
    generatedRoot,
    workspace: posix.join(generatedRoot, profile.consumer, profile.id, identity),
    toolchainRoot: posix.join(remoteHome, ".local", "share", "remote-runner", "toolchains"),
    launcher: posix.join(remoteHome, ".local", "share", "remote-runner", "launcher", "remote-launcher.mjs"),
    setupState: posix.join(remoteHome, ".local", "state", "remote-runner", "profiles", profile.consumer, profile.id, identity, "setup.json"),
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
  pathEnvironment: string,
  profile: Pick<Profile, "workload" | "secrets">,
  command: readonly string[],
): readonly string[] {
  for (const [label, path] of [["remote node", node], ["remote launcher", launcher], ["remote workspace", workspace]] as const) {
    canonicalRemotePath(path, label);
  }
  for (const path of pathEnvironment.split(":")) canonicalRemotePath(path, "remote PATH entry");
  if (command.length === 0 || command.some((argument) => argument.includes("\0"))) {
    throw new Error("remote child command is invalid");
  }
  const childEnvironment = Object.entries(profile.workload.childEnvironment).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of childEnvironment) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || value.includes("\0")) throw new Error("remote child environment is invalid");
  }
  return [
    "sh",
    "-ceu",
    'cd -- "$1"; shift; exec "$@" 3>&2',
    "remote-runner-child",
    workspace,
    "/usr/bin/env",
    `PATH=${pathEnvironment}`,
    ...childEnvironment.map(([name, value]) => `${name}=${value}`),
    node,
    launcher,
    JSON.stringify(profile.secrets.allow),
    "--",
    ...command,
  ];
}

const CAPTURE_BYTES = 64 * 1024;
const LOCAL_GIT_CAPTURE_BYTES = 4 * 1024 * 1024;
const UV_VERSION = "0.11.30";
const UV_SHA256 = {
  x86_64: "04bc7d180d6138bf6dc08387acf507a823f397a98fea55da36b0ccc7fbce3b68",
  aarch64: "8c11d90f5f66d232930cf8ae3a085c39877690d409e10878234802b028b20e2a",
} as const;
const GITLEAKS_VERSION = "8.30.1";
const CHILD_MARKER = new TextEncoder().encode("RR_CHILD_STARTED\n");

function decode(contents: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(contents); }
  catch { throw new Error(`${label} returned invalid UTF-8`); }
}

function parseGitlinks(output: Uint8Array): GitlinkIdentity[] {
  const result: GitlinkIdentity[] = [];
  for (const line of decode(output, "gitlink listing").split("\n")) {
    if (line.length === 0) continue;
    const match = /^160000 ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(.+)$/u.exec(line);
    if (match) result.push({ oid: match[1]!, path: match[2]! });
  }
  return result;
}

export async function listLocalGitlinks(
  processes: SshProcessRuntime,
  sourceRoot: string,
): Promise<GitlinkIdentity[]> {
  const result = await processes.run({
    command: "git",
    args: ["ls-files", "--stage"],
    cwd: sourceRoot,
    maxOutputBytes: LOCAL_GIT_CAPTURE_BYTES,
  });
  if (
    result.exitCode !== 0 || result.outputTruncated ||
    result.stdout.byteLength > LOCAL_GIT_CAPTURE_BYTES ||
    result.stderr.byteLength > LOCAL_GIT_CAPTURE_BYTES
  ) {
    throw new Error("local Git inspection failed");
  }
  return parseGitlinks(result.stdout);
}

export interface NodeProfileServicesOptions {
  readonly home: string;
  readonly sourceRoot: string;
  readonly knownHostsPath?: string;
  readonly mutagenCommand?: string;
  readonly managedSshPath?: string;
  readonly launcherSource: Uint8Array;
  readonly processes?: NodeProcessRuntime;
  readonly stdout?: (chunk: Uint8Array) => void;
  readonly stderr?: (chunk: Uint8Array) => void;
  readonly recordFallback?: (reason: string) => Promise<void>;
  readonly recordRemoteChildStarted?: () => Promise<void>;
}

export class NodeProfileServices implements ProfileExecutionServices {
  private readonly processes: NodeProcessRuntime;
  private readonly identity: string;
  private readonly stateRoot: string;
  private readonly lockRoot: string;
  private readonly knownHostsPath: string;
  private readonly mutagen: MutagenSyncLifecycle;
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
    this.processes = options.processes ?? new NodeProcessRuntime();
    this.identity = worktreeIdentity(options.sourceRoot);
    this.stateRoot = join(options.home, ".local", "state", "remote-runner");
    this.lockRoot = join(this.stateRoot, "locks");
    this.knownHostsPath = options.knownHostsPath ?? join(this.stateRoot, "known_hosts", "managed");
    const mutagenCommand = options.mutagenCommand ?? "mutagen";
    this.mutagen = new MutagenSyncLifecycle({
      run: (request) => this.processes.run({
        ...request,
        command: request.command === "mutagen" ? mutagenCommand : request.command,
        ...(options.managedSshPath === undefined
          ? {}
          : { environment: mutagenSshEnvironment(options.managedSshPath, request.environment) }),
      }),
    }, { now: () => performance.now() });
  }

  private remote(): RemoteCommandPort {
    return {
      run: (args) => runSsh(
        this.processes,
        this.profile.remote.target,
        args,
        this.profile.probes.connectTimeoutSeconds,
        this.knownHostsPath,
        CAPTURE_BYTES,
      ),
    };
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
      mkdir: async (path: string) => { await mkdir(path, { mode: 0o700 }); },
      readFile: async (path: string) => new Uint8Array(await readFile(path)),
      writeFile: async (path: string, contents: Uint8Array, mode: number) => { await writeFile(path, contents, { flag: "wx", mode }); },
      symlink: async (target: string, path: string) => { await symlink(target, path); },
      rename: async (from: string, to: string) => { await rename(from, to); },
      remove: async (path: string) => { await rm(path, { recursive: true }); },
    };
    return acquireProfileLock({
      files,
      processes: this.processes,
      clock: { now: () => Date.now(), sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) },
      lockDirectory: (identity) => join(this.lockRoot, identity),
      pid: process.pid,
      leaseDurationMs: 120_000,
      pollIntervalMs: 100,
      createToken: randomUUID,
    }, this.identity, 30_000);
  }

  async probe(): Promise<void> {
    const result = await runSsh(
      this.processes,
      this.profile.remote.target,
      [
        "sh", "-ceu",
        'home=${HOME:?}; blocks=$(df -Pk -- "$home" | awk \'NR==2 {print $4}\'); case "$blocks" in *[!0-9]*|"") exit 74;; esac; printf \'%s\\n%s\\n\' "$home" "$((blocks * 1024))"',
        "remote-runner-probe",
      ],
      this.profile.probes.connectTimeoutSeconds,
      this.knownHostsPath,
      CAPTURE_BYTES,
    );
    if (result.exitCode !== 0) {
      const reason = classifySshFailure(decode(result.stderr, "SSH probe"), result.exitCode);
      throw new PreparationError(reason, true);
    }
    let parsed: { home: string; availableBytes: number };
    try { parsed = parseProbeOutput(decode(result.stdout, "SSH probe"), this.profile.probes.minimumFreeBytes); }
    catch (caught) { throw new PreparationError("capacity", false, { cause: caught }); }
    this.remotePaths = resolveRemotePaths(parsed.home, this.profile, this.identity);
  }

  private paths(): RemotePaths {
    if (this.remotePaths === undefined) throw new Error("remote paths are unavailable before probe");
    return this.remotePaths;
  }

  async pauseSync(): Promise<void> {
    const paths = this.paths();
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
    const result = await reconcileWorkspace({
      consumer: this.profile.consumer,
      profile: this.profile.id,
      sourceRoot: this.options.sourceRoot,
      remoteTarget: this.profile.remote.target,
      generatedRoot: paths.generatedRoot,
      ...(this.profile.workspace.baseRef === undefined ? {} : { baseRef: this.profile.workspace.baseRef }),
      knownHostsPath: this.knownHostsPath,
      connectTimeoutSeconds: this.profile.probes.connectTimeoutSeconds,
    }, this.processes);
    if (result.identity !== this.identity || result.remoteRoot !== paths.workspace) {
      throw new Error("remote workspace identity changed during reconciliation");
    }
  }

  async resumeAndFlush(): Promise<void> {
    if (this.pausedSession === undefined) throw new Error("Mutagen session was not paused");
    const descriptor = this.pausedSession;
    this.pausedSession = undefined;
    await this.mutagen.resumeAndFlush(descriptor);
  }

  private async writeRemoteState(path: string, state: HealthySetupState): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
    const result = await this.remote().run([
      "sh", "-ceu",
      'umask 077; path=$1; value=$2; mkdir -p -- "$(dirname -- "$path")"; temporary="$path.tmp.$$"; printf \'%s\' "$value" | base64 -d >"$temporary"; chmod 600 "$temporary"; mv -f -- "$temporary" "$path"',
      "remote-runner-write-state", path, encoded,
    ]);
    if (result.exitCode !== 0) throw new Error("remote setup state write failed");
  }

  private async installLauncher(path: string): Promise<void> {
    const source = this.options.launcherSource;
    const digest = createHash("sha256").update(source).digest("hex");
    const encoded = Buffer.from(source).toString("base64");
    const result = await this.remote().run([
      "sh", "-ceu",
      'umask 077; path=$1; expected=$2; value=$3; mkdir -p -- "$(dirname -- "$path")"; if [ -f "$path" ] && [ "$(sha256sum -- "$path" | awk \'{print $1}\')" = "$expected" ]; then exit 0; fi; temporary="$path.tmp.$$"; printf \'%s\' "$value" | base64 -d >"$temporary"; [ "$(sha256sum -- "$temporary" | awk \'{print $1}\')" = "$expected" ]; chmod 700 "$temporary"; mv -f -- "$temporary" "$path"',
      "remote-runner-install-launcher", path, digest, encoded,
    ]);
    if (result.exitCode !== 0) throw new Error("remote launcher installation failed");
  }

  async bootstrap(): Promise<void> {
    const paths = this.paths();
    const remote = this.remote();
    const machineResult = await remote.run(["uname", "-m"]);
    if (machineResult.exitCode !== 0) throw new Error("remote architecture probe failed");
    const machine = decode(machineResult.stdout, "remote architecture").trim();
    const packageManager = packageManagerFromPackageJson(
      new Uint8Array(await readFile(join(this.options.sourceRoot, this.profile.bootstrap.packageManager))),
    );
    const toolchains = new RemoteToolchainRuntime(remote, paths.toolchainRoot);
    const node = await installNode(toolchains, {
      version: localNodeVersion(), machine, packageManager, toolchainRoot: paths.toolchainRoot,
    });
    const uvDigest = machine === "x86_64" || machine === "amd64" ? UV_SHA256.x86_64 : UV_SHA256.aarch64;
    const uv = await installUv(toolchains, {
      version: UV_VERSION, machine, sha256: uvDigest, toolchainRoot: paths.toolchainRoot,
    });
    this.nodeRoot = node.root;
    this.uvRoot = uv.root;
    await this.installLauncher(paths.launcher);
    const environment: EnvironmentIdentity = {
      node: node.version,
      packageManager,
      uv: UV_VERSION,
      gitleaks: `${GITLEAKS_VERSION}-linux-${machine}`,
    };
    const fingerprint = await dependencyFingerprint({
      readFile: async (path) => new Uint8Array(await readFile(join(this.options.sourceRoot, path))),
      listGitlinks: () => listLocalGitlinks(this.processes, this.options.sourceRoot),
      sha256: async (contents) => createHash("sha256").update(contents).digest("hex"),
    }, { environment, files: this.profile.bootstrap.fingerprint });
    const pathEnvironment = [posix.join(node.root, "bin"), uv.root, posix.join(paths.workspace, ".tools"), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    await ensureDependencySetup({
      readHealthyState: async () => {
        const result = await remote.run(["cat", "--", paths.setupState]);
        if (result.exitCode !== 0) return undefined;
        try { return JSON.parse(decode(result.stdout, "remote setup state")) as HealthySetupState; }
        catch { return undefined; }
      },
      runSetup: async (script, workspaceRoot) => {
        const result = await remote.run([
          "sh", "-ceu",
          'cd -- "$1"; export PATH=$2; export REMOTE_RUNNER_CHILD=1; exec "$3"',
          "remote-runner-setup", workspaceRoot, pathEnvironment, script,
        ]);
        return { exitCode: result.exitCode };
      },
      writeHealthyState: (state) => this.writeRemoteState(paths.setupState, state),
    }, {
      fingerprint, environment, workspaceRoot: paths.workspace, setup: this.profile.bootstrap.setup,
    });
  }

  async collectSecrets(): Promise<Readonly<Record<string, string>>> {
    return runSecretProvider({
      run: (request: BoundedProcessRequest) => this.processes.run({
        ...request,
        cwd: this.options.sourceRoot,
      }),
    }, this.profile.secrets.provider, this.profile.secrets.allow);
  }

  async startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ): Promise<RemoteExecutionResult> {
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
    const frame = encodeSecretFrame(secrets, this.profile.secrets.allow);
    const result = await runStreamingProcess({
      command: "ssh",
      args: sshArguments(
        this.profile.remote.target,
        remoteChildArguments(
          posix.join(this.nodeRoot, "bin", "node"),
          paths.launcher,
          paths.workspace,
          pathEnvironment,
          this.profile,
          command,
        ),
        this.profile.probes.connectTimeoutSeconds,
        this.knownHostsPath,
      ),
      stdin: frame.stdin,
      marker: CHILD_MARKER,
      onMarker: onChildStarted,
      stdout: this.options.stdout ?? ((chunk) => { process.stdout.write(chunk); }),
      stderr: this.options.stderr ?? ((chunk) => { process.stderr.write(chunk); }),
    });
    if (!result.spawned || !result.markerSeen) return { kind: "not-started", reason: "child-start" };
    return { kind: "completed", exitCode: result.exitCode };
  }

  async runLocal(command: readonly string[]): Promise<number> {
    const result = await runStreamingProcess({
      command: command[0]!, args: command.slice(1), cwd: this.options.sourceRoot,
      marker: new TextEncoder().encode("\0REMOTE_RUNNER_UNUSED_MARKER\0"),
      onMarker: async () => undefined,
      stdout: this.options.stdout ?? ((chunk) => { process.stdout.write(chunk); }),
      stderr: this.options.stderr ?? ((chunk) => { process.stderr.write(chunk); }),
    });
    return result.exitCode;
  }

  async recordFallback(reason: string): Promise<void> {
    await this.options.recordFallback?.(reason);
  }

  async recordRemoteChildStarted(): Promise<void> {
    await this.options.recordRemoteChildStarted?.();
  }

  reportUnavailable(reason: string): void {
    const line = new TextEncoder().encode(`remote-runner: remote unavailable reason=${reason}\n`);
    (this.options.stderr ?? ((chunk) => { process.stderr.write(chunk); }))(line);
  }
}
