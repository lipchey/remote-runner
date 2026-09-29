import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNodeCliDependencies,
  INSTALLED_MAIN_MODULE_URL,
  type NodeCliDependencies,
} from "../../../src/app/default-dependencies.js";
import { DIAGNOSTIC_PROBES } from "../../../src/diagnostics/doctor.js";
import { formatInstallReceipt } from "../../../src/node/install-receipt.js";
import type { FallbackCallbacks } from "../../../src/node/notifications.js";
import { consumeNextPrewarmRequest, inspectPrewarmRequest } from "../../../src/prewarm/queue.js";
import { worktreeIdentity } from "../../../src/runtime/identity.js";
import { runProfileLeg } from "../../../src/run/run-profile.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../../src/ssh/client.js";
import { compileIgnores, mutagenSessionName } from "../../../src/sync/mutagen.js";
import { validManifest } from "../config/manifest-fixture.js";

const temporaryRoots: string[] = [];
const MANIFEST_COMPILED_IGNORES = compileIgnores(["node_modules", ".git"]);
const profileBlock = validManifest.slice(validManifest.indexOf("  - id:"));

function remoteFallbackManifest(fallbackPolicy: "local" | "fail" = "local"): string {
  const fallback = validManifest
    .replace("fallback: local", `fallback: ${fallbackPolicy}`)
    .replace(
      'workload: { command: ["./scripts/verify", "--full"], childEnvironment:',
      'workload: { command: ["./scripts/fallback"], childEnvironment:',
    );
  const primary = profileBlock
    .replace("id: verify-full", "id: verify-full-pop-os")
    .replace("fallback: local", "fallback: verify-full")
    .replace("label: pop-os, target: admin@pop-os", "label: ariadne-runner, target: admin@primary")
    .replace(
      'workload: { command: ["./scripts/verify", "--full"], childEnvironment:',
      'workload: { command: ["./scripts/primary"], childEnvironment:',
    );
  return `${fallback}${primary}`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(manifest = validManifest) {
  const root = await mkdtemp(join(tmpdir(), "remote-runner-defaults-"));
  temporaryRoots.push(root);
  const sourceRoot = join(root, "source");
  const home = join(root, "home");
  const managedSshPath = join(home, ".local", "share", "remote-runner", "ssh");
  const knownHostsPath = join(home, ".local", "state", "remote-runner", "known_hosts", "managed");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, ".remote-runner.yaml"), manifest);
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@11.9.0" }));
  await writeFile(join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return { root, sourceRoot, home, managedSshPath, knownHostsPath };
}

function finishLine(at: string, bootstrapMs: number): string {
  return JSON.stringify({
    event: "run-finish",
    at,
    runId: "r1",
    provider: "remote",
    status: 0,
    durationMs: 1000,
    phases: { bootstrap: bootstrapMs },
  });
}

function result(stdout = "", exitCode = 0): BoundedProcessResult {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    outputTruncated: false,
    spawned: true,
  };
}

const resolveHostKey = new TextEncoder().encode("resolve-host-key");
const resolveHostPin = `SHA256:${createHash("sha256").update(resolveHostKey).digest("base64").replace(/=+$/u, "")}`;

function resolveManifest(fallbackPolicy: "local" | "fail" = "local"): string {
  return remoteFallbackManifest(fallbackPolicy).replaceAll("SHA256:trusted", resolveHostPin);
}

async function seedResolveKnownHosts(paths: { readonly knownHostsPath: string }): Promise<void> {
  await mkdir(dirname(paths.knownHostsPath), { recursive: true });
  const key = Buffer.from(resolveHostKey).toString("base64");
  await writeFile(paths.knownHostsPath, `primary ssh-ed25519 ${key}\npop-os ssh-ed25519 ${key}\n`, { mode: 0o600 });
}

type ResolveProbeOutcome = "reachable" | "reachability" | "remote" | "security" | "local";

interface RunRecord {
  readonly event: string;
  readonly runId: string;
  readonly pid: number;
  readonly profile?: string;
  readonly requested?: string;
  readonly selected?: string;
  readonly to?: string;
  readonly mode?: string;
  readonly status?: number;
  readonly provider?: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly unavailableReason?: string;
  readonly remoteChildStarted?: boolean;
  readonly error?: string;
  readonly durationMs?: number;
  readonly phases?: Readonly<Record<string, number>>;
  readonly ssh?: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
  readonly controllerEnsureMs?: number;
}

async function runRecords(dependencies: NodeCliDependencies, profile = "verify-full"): Promise<RunRecord[]> {
  return ((await dependencies.logsProfile?.(profile)) ?? []).map((line) => JSON.parse(line) as RunRecord);
}

function fallbackState(patch: Partial<FallbackCallbacks> = {}): FallbackCallbacks {
  return {
    selectPrimary: async () => true,
    observeUnreachable: async () => undefined,
    observeReachable: async () => undefined,
    observeRefused: async () => undefined,
    observePrimaryChildStarted: async () => undefined,
    ...patch,
  };
}

interface WorkloadHooks {
  readonly onUnavailable: (reason: string, detail?: string) => void;
  readonly onRemoteChildStarted: () => void;
}

/* Replaces the reporters only: each case still drives the real callback pair and the real JSONL
   writer under test. */
async function withInjectedWorkload(workload: (hooks: WorkloadHooks) => Promise<number>) {
  const paths = await fixture();
  const dependencies = await createNodeCliDependencies({
    clientId: "test-client",
    ...paths,
    launcherSource: new Uint8Array([1]),
    managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
    processes: new FakeProcesses(),
    now: () => "2026-07-31T12:34:56.000Z",
    executeProfile: async (_profile, _command, _mode, hooks) => workload(hooks),
  });
  return { dependencies, profile: (await dependencies.loadManifest()).profiles[0]! };
}

class FakeProcesses {
  readonly requests: BoundedProcessRequest[] = [];
  registrationExitCode = 0;
  secretsProbeExitCode = 0;
  workspaceProbeExitCode = 0;
  sessionListing = "[]";

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    this.requests.push(request);
    if (request.command === "launchctl") return result("state = running\n");
    if (request.args[0] === "sync" && request.args[1] === "list") {
      /* The probe lists every session; the status snapshot asks for one by name. */
      if (request.args.length === 4) return result(`${this.sessionListing}\n`);
      return result(`${JSON.stringify([{ name: request.args.at(-1), paused: false, status: "watching" }])}\n`);
    }
    if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-status")) {
      return result('{"workspace":"ready","fingerprint":"current"}\n');
    }
    if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-workspace-registration")) {
      return result("", this.registrationExitCode);
    }
    if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-secrets")) {
      return result("", this.secretsProbeExitCode);
    }
    /* The manifest's own secret provider, which both legs now run: the local one collects before it
       spawns anything, so a fake that answers it with the default empty stdout fails every local
       run with malformed JSON. */
    if (request.command === "node" && request.args.at(-1)?.endsWith("remote-runner-env.mjs")) {
      return result('{"NEON_DEV_DATABASE_URL":"ephemeral-canary"}');
    }
    /* Keyed on the probe's own command, not on `remote-runner-workspace`: that name is a prefix of
       the registration probe's `$0`, and both arrive as one encoded remote command string. */
    if (request.command === "ssh" && request.args.at(-1)?.includes("status --short --branch")) {
      return result("", this.workspaceProbeExitCode);
    }
    return result();
  }

  async isAlive() {
    return false;
  }
}

class ResolveProcesses extends FakeProcesses {
  constructor(private readonly outcomes: Readonly<Record<string, ResolveProbeOutcome>>) {
    super();
  }

  override async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    if (request.command !== "ssh") return super.run(request);
    const target = request.args.find((part) => part === "admin@primary" || part === "admin@pop-os");
    const outcome = target === undefined ? undefined : this.outcomes[target];
    if (request.args.at(-1)?.includes("remote-runner-home-probe")) {
      if (outcome === "reachable") return result("/home/admin\n");
      if (outcome === "local") return { ...result("", 127), spawned: false, spawnErrorCode: "ENOENT" };
      if (outcome === "security") {
        return { ...result("", 255), stderr: new TextEncoder().encode("Permission denied (publickey).") };
      }
      if (outcome === "remote") return result("", 1);
      return { ...result("", 255), stderr: new TextEncoder().encode("Connection refused") };
    }
    if (request.args.at(-1)?.includes("remote-runner-capacity-probe")) return result("999999999999\n");
    return super.run(request);
  }
}

async function resolveHarness(
  outcomes: Readonly<Record<string, ResolveProbeOutcome>>,
  manifest = resolveManifest(),
  state = fallbackState(),
) {
  const paths = await fixture(manifest);
  await seedResolveKnownHosts(paths);
  const processes = new ResolveProcesses(outcomes);
  const dependencies = await createNodeCliDependencies({
    ...paths,
    clientId: "test-client",
    managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
    processes,
    now: () => "2026-09-29T10:00:00.000Z",
    fallbackState: state,
  });
  return { dependencies, manifest: await dependencies.loadManifest(), paths, processes };
}

describe("concrete Node CLI dependencies", () => {
  it("publishes a canonical prewarm request only after confirming controller health", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: {
        changed: false,
        directory: paths.managedSshPath,
        knownHostsPath: paths.knownHostsPath,
      },
      processes,
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.enqueuePrewarm?.(profile, ".remote-runner.yaml")).resolves.toBe("published");
    await expect(
      inspectPrewarmRequest(paths.home, {
        consumer: profile.consumer,
        profile: profile.id,
        identity: dependencies.identity,
      }),
    ).resolves.toMatchObject({ state: "queued" });
    expect(processes.requests.some(({ command }) => command === "launchctl")).toBe(true);
  });

  it("loads cwd manifest profiles for status, doctor, and bounded owned logs", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });
    const identity = dependencies.identity;
    const profileRoot = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      "ariadne",
      "verify-full",
      identity,
    );
    await mkdir(profileRoot, { recursive: true });
    await writeFile(join(profileRoot, "runner.log.1"), "older\n");
    await writeFile(join(profileRoot, "runner.log"), "current\n");
    const profile = (await dependencies.loadManifest()).profiles[0]!;
    await dependencies.enqueuePrewarm?.(profile, ".remote-runner.yaml");

    await expect(dependencies.statusProfile?.("verify-full")).resolves.toMatch(
      /^verify-full controller=running prewarm=queued\(0\/1,\d+m\d{2}s\) session=watching workspace=ready fingerprint=current outage=clear$/u,
    );
    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;
    expect(report.checks).toHaveLength(DIAGNOSTIC_PROBES.length);
    expect(await dependencies.logsProfile?.("verify-full")).toEqual(["older", "current"]);
    expect(processes.requests.every((request) => request.command !== "sh" && request.command !== "bash")).toBe(true);
  });

  it("reports the last prewarm's terminal outcome on the status line", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;
    await dependencies.enqueuePrewarm?.(profile, ".remote-runner.yaml");
    await expect(consumeNextPrewarmRequest(paths.home, async () => 1)).resolves.toBe("processed");

    await expect(dependencies.statusProfile?.("verify-full")).resolves.toMatch(
      /^verify-full controller=running prewarm=failed\(1\)@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z session=watching /u,
    );
  });

  it("lets no probe report a status it did not earn from a command", async () => {
    const paths = await fixture();
    const failing = new FakeProcesses();
    /* A probe that returns a constant still feeds the doctor exit code, so `ok` from a machine where
       every command fails is a check that never ran — the shape three removed probes had. */
    failing.run = async (request: BoundedProcessRequest) => {
      failing.requests.push(request);
      return result("", 1);
    };
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: failing,
    });

    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;
    expect(report.checks).toHaveLength(DIAGNOSTIC_PROBES.length);
    expect(report.checks.filter((check) => check.status === "ok")).toEqual([]);
  });

  it("uses an absolute generated root and reports an exact stale worktree registration", async () => {
    const generatedRoot = "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces";
    const paths = await fixture(validManifest.replace('"~/.cache/remote-runner/workspaces"', `"${generatedRoot}"`));
    const processes = new FakeProcesses();
    processes.registrationExitCode = 74;
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });

    await dependencies.statusProfile?.("verify-full");
    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;
    const serializedRequests = JSON.stringify(processes.requests);

    expect(serializedRequests).toContain(`${generatedRoot}/ariadne/verify-full/`);
    expect(serializedRequests).toContain(`${generatedRoot}/ariadne/.mirror.git`);
    const registrationRequest = processes.requests.find((request) =>
      request.args.at(-1)?.includes("remote-runner-workspace-registration"),
    );
    expect(registrationRequest?.args.at(-1)).toContain(
      'if ! listing=$(git --git-dir="$mirror" worktree list --porcelain)',
    );
    expect(report.checks).toContainEqual({
      id: "remote.workspace-registration",
      status: "fail",
      reason: "workspace-registration",
      next: "ssh <remote> inspect exact Git worktree registration for <workspace>",
    });
    expect(JSON.stringify(report)).not.toContain(generatedRoot);
  });

  it.each([
    ["fails on a session the run would reject", { mode: "two-way-safe" }, "fail", "Mutagen session mode mismatch"],
    [
      "warns while the live session excludes the pre-drift set",
      { ignore: { paths: [".git"] } },
      "warn",
      "Mutagen session ignores drifted; the next run recreates it",
    ],
  ])("%s, naming the mismatch", async (_case, patch, status, detail) => {
    const generatedRoot = "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces";
    const paths = await fixture(validManifest.replace('"~/.cache/remote-runner/workspaces"', `"${generatedRoot}"`));
    const sourceRoot = await realpath(paths.sourceRoot);
    const identity = worktreeIdentity(sourceRoot, "test-client");
    const processes = new FakeProcesses();
    processes.sessionListing = JSON.stringify([
      {
        identifier: "sync_AbCdEf1234567890",
        name: mutagenSessionName("ariadne", "verify-full", identity),
        alpha: { protocol: "local", path: sourceRoot },
        beta: {
          protocol: "ssh",
          user: "admin",
          host: "pop-os",
          path: `${generatedRoot}/ariadne/verify-full/clients/d5fe82513196ca977d816609/${identity}`,
        },
        mode: "one-way-replica",
        ignore: { paths: MANIFEST_COMPILED_IGNORES },
        paused: false,
        status: "watching",
        conflicts: [],
        excludedConflicts: 0,
        ...patch,
      },
    ]);
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });

    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;

    expect(report.checks).toContainEqual({
      id: "sync.session",
      status,
      reason: "sync",
      detail,
      next: "mutagen sync list <session>",
    });
  });

  it.each([
    ["ok", 0],
    ["fail", 1],
  ])("reports secrets.persistence as %s from the presence test's exit code", async (status, secretsProbeExitCode) => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    processes.secretsProbeExitCode = secretsProbeExitCode;
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });

    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;

    expect(report.checks).toContainEqual(
      status === "ok"
        ? { id: "secrets.persistence", status: "ok", next: expect.stringContaining("if found=$(find") }
        : {
            id: "secrets.persistence",
            status: "fail",
            reason: "secrets",
            next: expect.stringContaining("if found=$(find"),
          },
    );
    const secretsRequest = processes.requests.find((request) => request.args.at(-1)?.includes("remote-runner-secrets"));
    expect(secretsRequest?.args.at(-1)).toContain(
      'if found=$(find "$path" -maxdepth 1 -name .env -print); then [ -z "$found" ]; else exit 1; fi',
    );
  });

  it("warns without a failing reason when the remote workspace was never provisioned", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    /* What both probes' own `[ -d "$path" ] || exit 79` guard returns for a source checkout that has
       never run remotely — the state the primary Ariadne checkout is permanently in. */
    processes.secretsProbeExitCode = 79;
    processes.workspaceProbeExitCode = 79;
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });

    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;

    expect(report.checks).toContainEqual({
      id: "secrets.persistence",
      status: "warn",
      reason: "secrets",
      detail: "remote workspace is not provisioned",
      next: expect.stringContaining("if found=$(find"),
    });
    expect(report.checks).toContainEqual({
      id: "remote.workspace",
      status: "warn",
      reason: "workspace",
      detail: "remote workspace is not provisioned",
      next: expect.stringContaining("git -C <workspace> status"),
    });
    /* The absent workspace is what `remote-runner doctor` exits 1 on today, on every checkout that
       only ever dispatches runs from its worktrees. */
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    const workspaceRequest = processes.requests.find((request) =>
      request.args.at(-1)?.includes("status --short --branch"),
    );
    expect(workspaceRequest?.args.at(-1)).toContain('[ -e "$path" ] || exit 79');
  });

  it("derives 79 from the generated probes only for an absent workspace", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });
    await dependencies.doctorProfile?.("verify-full");
    const probe = (token: string): string => {
      const encoded = processes.requests.find((request) => request.args.at(-1)?.includes(token))?.args.at(-1);
      if (encoded === undefined) throw new Error(`no generated probe command contains ${token}`);
      return encoded;
    };
    /* The exit codes this suite injects everywhere else are only real if the generated scripts
       produce them, so these two run for real: the encoded remote command, under the same POSIX
       shell the remote uses, against a $HOME whose workspace is absent, broken, or clean. */
    const workspaceProbe = probe("status --short --branch");
    const secretsProbe = probe("remote-runner-secrets");
    const exitCode = (command: string, home: string): number | null =>
      spawnSync("/bin/sh", ["-c", command], { env: { HOME: home, PATH: process.env.PATH ?? "" } }).status;
    const workspacePath = (home: string): string =>
      join(
        home,
        ".cache",
        "remote-runner",
        "workspaces",
        "ariadne",
        "verify-full",
        "clients",
        "d5fe82513196ca977d816609",
        dependencies.identity,
      );
    const probeHome = async (): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), "remote-runner-probe-home-"));
      temporaryRoots.push(root);
      return root;
    };

    const absent = await probeHome();
    expect(exitCode(workspaceProbe, absent)).toBe(79);
    expect(exitCode(secretsProbe, absent)).toBe(79);

    const broken = await probeHome();
    await mkdir(dirname(workspacePath(broken)), { recursive: true });
    await writeFile(workspacePath(broken), "");
    expect(exitCode(workspaceProbe, broken)).not.toBe(79);
    expect(exitCode(workspaceProbe, broken)).not.toBe(0);

    const provisioned = await probeHome();
    await mkdir(workspacePath(provisioned), { recursive: true });
    expect(exitCode(secretsProbe, provisioned)).toBe(0);
    await writeFile(join(workspacePath(provisioned), ".env"), "SECRET=1\n");
    expect(exitCode(secretsProbe, provisioned)).not.toBe(0);
    expect(exitCode(secretsProbe, provisioned)).not.toBe(79);
  });

  it("executes every validated benchmark argv locally and remotely and writes both receipts", async () => {
    const paths = await fixture();
    const executions: Array<{ mode: string; command: readonly string[] }> = [];
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      async executeProfile(_profile, command, mode) {
        executions.push({ mode, command: [...command] });
        return 0;
      },
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    const report = (await dependencies.benchmarkProfile?.(profile)) as { receiptPaths: readonly string[] };

    expect(executions).toHaveLength(8);
    expect(new Set(executions.map(({ mode }) => mode))).toEqual(new Set(["local", "remote"]));
    expect(executions.every(({ command }) => command.join("\0") === "./scripts/verify\0--full")).toBe(true);
    expect(report.receiptPaths).toEqual([
      "benchmark/20260731T123456Z-verify-full.json",
      "benchmark/20260731T123456Z-verify-full.md",
    ]);
    await expect(readFile(join(paths.sourceRoot, report.receiptPaths[0]!), "utf8")).resolves.toContain(
      '"profile": "verify-full"',
    );
    await expect(readFile(join(paths.sourceRoot, report.receiptPaths[1]!), "utf8")).resolves.toContain(
      "| remote | full |",
    );
  });

  it("reads every identity under the state root, rotations included", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const corpusRoot = join(paths.home, ".local", "state", "remote-runner", "profiles");
    const first = join(corpusRoot, "ariadne", "verify-full", "aaa");
    const second = join(corpusRoot, "ariadne", "telegram-live", "bbb");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, "runner.log.1"), `${finishLine("2026-08-01T00:00:00Z", 2000)}\n`);
    await writeFile(join(first, "runner.log"), `${finishLine("2026-08-02T00:00:00Z", 9000)}\n`);
    await writeFile(join(second, "runner.log"), `${finishLine("2026-08-03T00:00:00Z", 1500)}\n`);

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.source).toBe(corpusRoot);
    expect(report.provenance.files).toBe(3);
    expect(report.provenance.unparsed).toBe(0);
    expect(report.summary.identities).toBe(2);
    expect(report.summary.profiles).toEqual(["ariadne/telegram-live", "ariadne/verify-full"]);
    expect(report.summary.bootstrap.measuredMs).toEqual([1500, 2000, 9000]);
  });

  it("reports an unreadable state root instead of an empty corpus", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const consumerRoot = join(paths.home, ".local", "state", "remote-runner", "profiles", "ariadne");
    await mkdir(join(consumerRoot, "verify-full"), { recursive: true });
    /* Only ENOENT may be read as "nothing dispatched here": any other failure reported as an empty
       corpus reads as a clean lane. */
    await chmod(consumerRoot, 0o000);
    try {
      await expect(dependencies.readLogCorpus!({})).rejects.toThrow(/EACCES/u);
    } finally {
      await chmod(consumerRoot, 0o700);
    }
  });

  /* The receipt sits one directory ABOVE the main module, so resolving it from this module's own URL
     would look one level too deep and degrade every real invocation to "unknown" — a version report
     no gate would catch. */
  it("resolves the install receipt from the layout the installer writes", async () => {
    const paths = await fixture();
    const appRoot = join(paths.root, "app");
    await mkdir(join(appRoot, "src"), { recursive: true });
    await writeFile(
      join(appRoot, ".remote-runner-receipt.json"),
      formatInstallReceipt({ schemaVersion: 1, version: "9.9.9", appIdentity: "f71f95d0a1b2c3d4e5f60718" }),
    );
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      mainModuleUrl: pathToFileURL(join(appRoot, "src", "main.js")).href,
    });

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.runner).toContain("9.9.9");
    expect(INSTALLED_MAIN_MODULE_URL).toMatch(/\/main\.js$/u);
    expect(INSTALLED_MAIN_MODULE_URL).not.toContain("default-dependencies");
  });

  /* A same-UID replacement of a log by a FIFO is enough to park a blocking open forever, and mode
     bits do not stop one: the read has to decide on the handle, not the path. */
  it("skips a log replaced by a FIFO instead of blocking on it", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const identityRoot = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      "ariadne",
      "verify-full",
      "aaa",
    );
    await mkdir(identityRoot, { recursive: true });
    await writeFile(join(identityRoot, "runner.log.1"), `${finishLine("2026-08-01T00:00:00Z", 2000)}\n`);
    expect(spawnSync("mkfifo", [join(identityRoot, "runner.log")]).status).toBe(0);

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.files).toBe(1);
    expect(report.summary.records).toBe(1);
  });

  /* Same threat as the FIFO, different primitive: a symlink where a log belongs would otherwise pull
     a file from outside the corpus into the report, since `open` resolves it before the handle is
     stat'd. */
  it("refuses to follow a symlink standing in for a log", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const identityRoot = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      "ariadne",
      "verify-full",
      "aaa",
    );
    await mkdir(identityRoot, { recursive: true });
    await writeFile(join(identityRoot, "runner.log.1"), `${finishLine("2026-08-01T00:00:00Z", 2000)}\n`);
    const outside = join(paths.root, "elsewhere.log");
    await writeFile(outside, `${finishLine("2026-08-02T00:00:00Z", 9000)}\n`);
    await symlink(outside, join(identityRoot, "runner.log"));

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.files).toBe(1);
    expect(report.summary.bootstrap.measuredMs).toEqual([2000]);
  });

  /* A crash can leave the tail of a log half-written. A fatal decode throws the whole file away, so
     one truncated record would cost every other record that identity ever wrote. */
  it("loses only the truncated record when a log ends mid-multibyte character", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const identityRoot = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      "ariadne",
      "verify-full",
      "aaa",
    );
    await mkdir(identityRoot, { recursive: true });
    const tail = Buffer.from(
      JSON.stringify({ event: "run-unavailable", at: "2026-08-02T00:00:00Z", reason: "черга" }),
      "utf8",
    );
    await writeFile(
      join(identityRoot, "runner.log"),
      Buffer.concat([
        Buffer.from(`${finishLine("2026-08-01T00:00:00Z", 2000)}\n`, "utf8"),
        tail.subarray(0, tail.indexOf(0xd1) + 1),
      ]),
    );

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.unparsed).toBe(1);
    expect(report.summary.records).toBe(1);
  });

  it("degrades the runner version to unknown rather than losing the corpus", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      mainModuleUrl: pathToFileURL(join(paths.root, "absent", "src", "main.js")).href,
    });

    const report = await dependencies.readLogCorpus!({});

    expect(report.provenance.runner).toBe("unknown");
    expect(report.provenance.files).toBe(0);
  });

  it("writes bounded diagnostic lifecycle records for real profile dispatch", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      executeProfile: async () => 23,
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored-secret-like-argument"], "remote")).resolves.toBe(23);

    const lines = await dependencies.logsProfile?.("verify-full");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toContain('"event":"run-start"');
    expect(lines?.[1]).toContain('"event":"run-finish"');
    expect(lines?.[1]).toContain('"provider":"remote"');
    expect(lines?.join("\n")).not.toContain("ignored-secret-like-argument");
  });

  it("correlates one run's records with a run id, the writer pid, and a measured duration", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      executeProfile: async () => 23,
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(23);
    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(23);

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-finish", "run-start", "run-finish"]);
    expect(records[0]!.runId).toMatch(/^[0-9a-f]{16}$/u);
    expect(records[1]!.runId).toBe(records[0]!.runId);
    expect(records[2]!.runId).not.toBe(records[0]!.runId);
    expect(records.map(({ pid }) => pid)).toEqual([process.pid, process.pid, process.pid, process.pid]);
    expect(records[0]!.durationMs).toBeUndefined();
    for (const finished of [records[1]!, records[3]!]) {
      expect(Number.isInteger(finished.durationMs)).toBe(true);
      expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("stamps a failed run's error record with the same correlation fields and its duration", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      createRunId: () => "00112233445566aa",
      executeProfile: async () => {
        throw new Error("resource setup failed");
      },
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).rejects.toThrow("resource setup failed");

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-error"]);
    expect(records[1]).toMatchObject({ runId: "00112233445566aa", pid: process.pid, error: "Error" });
    expect(Number.isInteger(records[1]!.durationMs)).toBe(true);
  });

  it("records the preparation reason that left the remote unavailable", async () => {
    const hostKey = new TextEncoder().encode("pop-os-host-key");
    const paths = await fixture(
      validManifest.replace(
        'hostKeySha256: "SHA256:trusted"',
        `hostKeySha256: "SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}"`,
      ),
    );
    await mkdir(dirname(paths.knownHostsPath), { recursive: true });
    await writeFile(paths.knownHostsPath, `pop-os ssh-ed25519 ${Buffer.from(hostKey).toString("base64")}\n`, {
      mode: 0o600,
    });
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      createRunId: () => "00112233445566bb",
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(75);

    const records = await runRecords(dependencies);
    const unavailable = records.filter(({ event }) => event === "run-unavailable");
    expect(records[0]!.event).toBe("run-start");
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect(unavailable[0]).toMatchObject({
      runId: "00112233445566bb",
      pid: process.pid,
      profile: "verify-full",
      mode: "remote",
    });
    expect(unavailable[0]!.reason).toBe("remote-shell");
    /* Exact keys: a fabricated or dropped `detail` field is the failure this record shape hides. */
    expect(Object.keys(unavailable[0]!)).toEqual([
      "at",
      "event",
      "runId",
      "pid",
      "profile",
      "requested",
      "selected",
      "mode",
      "reason",
    ]);
    expect(records.at(-1)).toMatchObject({
      event: "run-finish",
      status: 75,
      provider: "remote",
      unavailableReason: "remote-shell",
      remoteChildStarted: false,
    });
  });

  it("names the reported reason on the terminal record of a run that exits 75", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async (hooks) => {
      hooks.onUnavailable("secrets", "provider exited 1");
      return 75;
    });

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(75);

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-unavailable", "run-finish"]);
    expect(records[1]).toMatchObject({ reason: "secrets", detail: "provider exited 1" });
    expect(records[2]).toMatchObject({ status: 75, unavailableReason: "secrets", remoteChildStarted: false });
    /* The unbounded operator text stays on the paired record alone. */
    expect(records[2]!.detail).toBeUndefined();
  });

  it("omits the reason from a run that exits 75 without reporting one", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async () => 75);

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(75);

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-finish"]);
    expect(records[1]).toMatchObject({ status: 75 });
    expect(Object.keys(records[1]!)).not.toContain("unavailableReason");
  });

  it("leaves a green remote run's terminal record without a reason", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async (hooks) => {
      hooks.onRemoteChildStarted();
      return 0;
    });

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(0);

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-finish"]);
    expect(records[1]).toMatchObject({ status: 0, provider: "remote", remoteChildStarted: true });
    expect(Object.keys(records[1]!)).not.toContain("unavailableReason");
  });

  it("keeps the last of several reasons reported by one run", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async (hooks) => {
      hooks.onUnavailable("sync");
      hooks.onUnavailable("transport");
      return 75;
    });

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(75);

    const records = await runRecords(dependencies);
    expect(records.filter(({ event }) => event === "run-unavailable").map(({ reason }) => reason)).toEqual([
      "sync",
      "transport",
    ]);
    expect(records.at(-1)).toMatchObject({ unavailableReason: "transport" });
  });

  /* The workload's own exit 75 must not inherit the reason of a preparation that recovered. */
  it("drops a reported reason once the remote child starts", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async (hooks) => {
      hooks.onUnavailable("sync");
      hooks.onRemoteChildStarted();
      return 75;
    });

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(75);

    const records = await runRecords(dependencies);
    expect(records.filter(({ event }) => event === "run-unavailable")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ status: 75, remoteChildStarted: true });
    expect(Object.keys(records.at(-1)!)).not.toContain("unavailableReason");
  });

  it("names the reported reason on the error record of a run that threw", async () => {
    const { dependencies, profile } = await withInjectedWorkload(async (hooks) => {
      hooks.onUnavailable("controller");
      throw new Error("resource setup failed");
    });

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).rejects.toThrow("resource setup failed");

    expect((await runRecords(dependencies)).at(-1)).toMatchObject({
      event: "run-error",
      unavailableReason: "controller",
    });
  });

  it("carries the fallback reason on a locally successful run", async () => {
    const hostKey = new TextEncoder().encode("pop-os-host-key");
    const paths = await fixture(
      validManifest.replace(
        'hostKeySha256: "SHA256:trusted"',
        `hostKeySha256: "SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}"`,
      ),
    );
    await mkdir(dirname(paths.knownHostsPath), { recursive: true });
    await writeFile(paths.knownHostsPath, `pop-os ssh-ed25519 ${Buffer.from(hostKey).toString("base64")}\n`, {
      mode: 0o600,
    });
    /* A non-zero home probe classifies as a RETRYABLE remote-shell failure, the one shape that
       spends the profile's local fallback instead of failing closed on 75. */
    class UnreachableHomeProcesses extends FakeProcesses {
      async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
        const actual = await super.run(request);
        if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-home-probe")) {
          return result("", 1);
        }
        return actual;
      }
    }
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new UnreachableHomeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, [process.execPath, "-e", ""], "auto")).resolves.toBe(0);

    expect((await runRecords(dependencies)).at(-1)).toMatchObject({
      event: "run-finish",
      status: 0,
      provider: "local",
      remoteChildStarted: false,
      unavailableReason: "remote-shell",
    });
  });

  it("marks a genuinely local run-finish record with provider local", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, [process.execPath, "-e", ""], "local")).resolves.toBe(0);

    const lines = await dependencies.logsProfile?.("verify-full");
    expect(lines?.[1]).toContain('"event":"run-finish"');
    expect(lines?.[1]).toContain('"provider":"local"');
  });

  /* A machine with no Mutagen (ENOENT) has no daemon to restart, and the transport update it would
     have picked up is moot. Everything else leaves the run talking to ssh settings it has already
     replaced: a daemon that IS there and refuses to stop, and equally an EMFILE/ENOMEM spawn
     failure — the fd or memory pressure stops the `stop`, not Mutagen's absence, and the live
     daemon keeps serving the old transport. `spawned` alone cannot tell those two apart. */
  it.each([
    ["ENOENT", "resolves"],
    ["EMFILE", "throws"],
    [undefined, "throws"],
  ] as const)(
    "with a Mutagen daemon-stop failure at spawnErrorCode=%s, the run %s",
    async (spawnErrorCode, _outcome) => {
      const paths = await fixture();
      class StopFailingProcesses extends FakeProcesses {
        async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
          if (request.args[0] === "daemon" && request.args[1] === "stop") {
            return {
              exitCode: 1,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
              outputTruncated: false,
              spawned: spawnErrorCode === undefined,
              ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
            };
          }
          return super.run(request);
        }
      }
      const dependencies = await createNodeCliDependencies({
        clientId: "test-client",
        ...paths,
        launcherSource: new Uint8Array([1]),
        managedSsh: { changed: true, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
        processes: new StopFailingProcesses(),
        now: () => "2026-07-31T12:34:56.000Z",
      });
      const profile = (await dependencies.loadManifest()).profiles[0]!;
      const run = dependencies.runProfile!(profile, [process.execPath, "-e", ""], "local");

      if (spawnErrorCode === "ENOENT") await expect(run).resolves.toBe(0);
      else await expect(run).rejects.toThrow("unable to restart Mutagen");
    },
  );

  it("keeps each run's provider execution-local when a local run and a stalled remote attempt overlap", async () => {
    /* ensureManagedKnownHost skips its ssh-keyscan round trip once the target is on file under
       the PINNED key, so the remote attempt's first (and only, before it fails) ssh call is the
       home probe below — the one point we gate. */
    const hostKey = new TextEncoder().encode("pop-os-host-key");
    const paths = await fixture(
      validManifest.replace(
        'hostKeySha256: "SHA256:trusted"',
        `hostKeySha256: "SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}"`,
      ),
    );
    await mkdir(dirname(paths.knownHostsPath), { recursive: true });
    await writeFile(paths.knownHostsPath, `pop-os ssh-ed25519 ${Buffer.from(hostKey).toString("base64")}\n`, {
      mode: 0o600,
    });

    let releaseRemoteProbe: () => void = () => undefined;
    const remoteProbeGate = new Promise<void>((resolve) => {
      releaseRemoteProbe = resolve;
    });
    class GatedProcesses extends FakeProcesses {
      async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
        if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-home-probe")) {
          await remoteProbeGate;
        }
        return super.run(request);
      }
    }
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new GatedProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    /* Started but deliberately not awaited yet: it blocks on the gate above, so the local run
       below runs — and finishes, including its own run-finish log line — while this is still
       pending, then release lets it resume and fail (no known home) without falling back. */
    const remoteRun = dependencies.runProfile!(profile, ["ignored"], "remote");
    await expect(dependencies.runProfile!(profile, [process.execPath, "-e", ""], "local")).resolves.toBe(0);
    releaseRemoteProbe();
    await expect(remoteRun).resolves.toBe(75);

    const lines = (await dependencies.logsProfile?.("verify-full")) ?? [];
    const finishes = lines.filter((line) => line.includes('"event":"run-finish"'));
    expect(finishes).toHaveLength(2);
    expect(finishes[0]).toContain('"provider":"local"');
    expect(finishes[1]).toContain('"provider":"remote"');
  });

  it("refuses a symlinked benchmark output directory", async () => {
    const paths = await fixture();
    const outside = join(paths.root, "outside");
    await mkdir(outside);
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      executeProfile: async () => 0,
    });
    await symlink(outside, join(paths.sourceRoot, "benchmark"));
    const profile = (await dependencies.loadManifest()).profiles[0]!;
    await expect(dependencies.benchmarkProfile?.(profile)).rejects.toThrow(/escapes source root/u);
    await expect(readFile(join(outside, "20260731T123456Z-verify-full.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("attributes a real dispatch's phases and ssh connections in the terminal record", async () => {
    const hostKey = new TextEncoder().encode("pop-os-host-key");
    const paths = await fixture(
      validManifest.replace(
        'hostKeySha256: "SHA256:trusted"',
        `hostKeySha256: "SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/u, "")}"`,
      ),
    );
    await mkdir(dirname(paths.knownHostsPath), { recursive: true });
    await writeFile(paths.knownHostsPath, `pop-os ssh-ed25519 ${Buffer.from(hostKey).toString("base64")}\n`, {
      mode: 0o600,
    });
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote", 812)).resolves.toBe(75);

    const finish = (await runRecords(dependencies)).at(-1)!;
    expect(finish.event).toBe("run-finish");
    /* Preparation stops at the probe, so later phases are absent, not a zero that would read as
       instant work. */
    expect(Object.keys(finish.phases ?? {})).toEqual(["validate", "lock", "probe"]);
    expect(Object.values(finish.phases ?? {}).every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
    expect(finish.ssh?.count).toBeGreaterThanOrEqual(1);
    expect(finish.ssh?.maxMs).toBeLessThanOrEqual(finish.ssh!.totalMs);
    /* Outside `phases`: the repair precedes the run, so its cost can't join the sum that explains
       `durationMs`. */
    expect(finish.controllerEnsureMs).toBe(812);
    expect(finish.phases).not.toHaveProperty("controllerEnsureMs");
  });

  it("carries the controller measurement and empty spans on a run that never reached the remote", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      executeProfile: async () => {
        throw new Error("resource setup failed");
      },
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote", 640)).rejects.toThrow(
      "resource setup failed",
    );

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-error"]);
    expect(records[1]).toMatchObject({ controllerEnsureMs: 640, phases: {}, ssh: { count: 0, totalMs: 0, maxMs: 0 } });
    expect(records[0]!.controllerEnsureMs).toBeUndefined();
  });

  it("keeps reading a runner log written before the phase fields existed", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      clientId: "test-client",
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
      executeProfile: async () => 0,
    });
    const profileRoot = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "profiles",
      "ariadne",
      "verify-full",
      dependencies.identity,
    );
    await mkdir(profileRoot, { recursive: true });
    const legacy = {
      at: "2026-07-30T00:00:00.000Z",
      event: "run-finish",
      runId: "00112233445566cc",
      pid: 1,
      profile: "verify-full",
      mode: "remote",
      status: 0,
      provider: "remote",
      durationMs: 12,
    };
    await writeFile(join(profileRoot, "runner.log"), `${JSON.stringify(legacy)}\n`);
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await expect(dependencies.runProfile!(profile, ["ignored"], "remote")).resolves.toBe(0);

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-finish", "run-start", "run-finish"]);
    expect(records[0]).toEqual(legacy);
    expect(records.at(-1)).toMatchObject({ phases: {}, ssh: { count: 0, totalMs: 0, maxMs: 0 } });
    expect(records.at(-1)!.controllerEnsureMs).toBeUndefined();
  });
});

it.each(["statusProfile", "doctorProfile", "logsProfile"] as const)(
  "%s reads the selected private manifest",
  async (method) => {
    const paths = await fixture();
    await writeFile(
      join(paths.sourceRoot, ".remote-runner.local.yaml"),
      validManifest.replaceAll("verify-full", "alternate"),
    );
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      processes: new FakeProcesses(),
    });
    await expect(dependencies[method]!("alternate", ".remote-runner.local.yaml")).resolves.toBeDefined();
  },
);

describe("remote fallback orchestration", () => {
  it("status reads v2 outage state only for a remote-fallback profile", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;
    const statePath = join(
      paths.home,
      ".local",
      "state",
      "remote-runner",
      "fallback",
      primary.consumer,
      primary.id,
      "state.json",
    );
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        consumer: primary.consumer,
        primary: primary.id,
        topology: {
          target: primary.remote.target,
          hostKeySha256: primary.remote.hostKeySha256,
          fallback: fallback.id,
          fallbackTarget: fallback.remote.target,
        },
        outage: { reason: "transport", since: "2026-09-29T10:00:00.000Z" },
        refusal: null,
        negative: { checkedAt: "2026-09-29T10:00:00.000Z", ttlMs: 60_000 },
        lease: null,
        lastRecoveryAt: null,
        backoffTtlMs: 120_000,
        queue: [],
      }),
    );

    await expect(dependencies.statusProfile!(primary.id)).resolves.toContain(
      "outage=active fallback=active(verify-full)",
    );

    const plainPaths = await fixture();
    const plain = await createNodeCliDependencies({
      ...plainPaths,
      clientId: "test-client",
      managedSsh: {
        changed: false,
        directory: plainPaths.managedSshPath,
        knownHostsPath: plainPaths.knownHostsPath,
      },
      processes: new FakeProcesses(),
    });
    await expect(plain.statusProfile!("verify-full")).resolves.toBe(
      "verify-full controller=running prewarm=idle session=watching workspace=ready fingerprint=current outage=clear",
    );
  });

  it("runs the fallback profile when the primary is unreachable", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const legs: string[] = [];
    const observed: string[] = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      createRunId: () => "0011223344556601",
      executeLeg: async (profile) => {
        legs.push(profile.id);
        return profile.id === "verify-full-pop-os"
          ? { kind: "failover", reason: "transport" }
          : { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState({
        observeUnreachable: async (reason) => {
          observed.push(reason);
        },
      }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.runProfile!(primary, undefined, "auto", undefined, fallback)).resolves.toBe(0);

    expect(legs).toEqual(["verify-full-pop-os", "verify-full"]);
    expect(observed).toEqual(["transport"]);
  });

  it("double unreachable under auto ends on the fallback's local leg", async () => {
    const paths = await fixture(remoteFallbackManifest());
    let localRuns = 0;
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (profile, command, mode) => {
        if (profile.id === "verify-full-pop-os") return { kind: "failover", reason: "transport" };
        return runProfileLeg(
          {
            prepareRemote: async () => ({
              ok: false,
              reason: "transport",
              retryable: false,
              failureClass: "reachability",
            }),
            startRemote: async () => {
              throw new Error("unreachable");
            },
            runLocal: async () => {
              localRuns += 1;
              return 0;
            },
            failClosed: async () => undefined,
          },
          profile,
          command,
          mode,
        );
      },
      fallbackState: fallbackState(),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.runProfile!(primary, undefined, "auto", undefined, fallback)).resolves.toBe(0);
    expect(localRuns).toBe(1);
  });

  it("double unreachable under --mode remote fails closed with 75", async () => {
    const paths = await fixture(remoteFallbackManifest());
    let localRuns = 0;
    let failClosed = 0;
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (profile, command, mode) => {
        if (profile.id === "verify-full-pop-os") return { kind: "failover", reason: "transport" };
        return runProfileLeg(
          {
            prepareRemote: async () => ({
              ok: false,
              reason: "transport",
              retryable: false,
              failureClass: "reachability",
            }),
            startRemote: async () => {
              throw new Error("unreachable");
            },
            runLocal: async () => {
              localRuns += 1;
              return 0;
            },
            failClosed: async () => {
              failClosed += 1;
            },
          },
          profile,
          command,
          mode,
        );
      },
      fallbackState: fallbackState(),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.runProfile!(primary, undefined, "remote", undefined, fallback)).resolves.toBe(75);
    expect({ localRuns, failClosed }).toEqual({ localRuns: 0, failClosed: 1 });
  });

  it("a fresh negative entry skips the primary without probing it", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const legs: string[] = [];
    const commands: Array<readonly string[]> = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      createRunId: () => "0011223344556603",
      executeLeg: async (profile, command) => {
        legs.push(profile.id);
        commands.push([...command]);
        return { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState({ selectPrimary: async () => false }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.runProfile!(primary, undefined, "auto", undefined, fallback)).resolves.toBe(0);
    expect(legs).toEqual(["verify-full"]);
    expect(commands).toEqual([["./scripts/fallback"]]);
    expect(await runRecords(dependencies, fallback.id)).toEqual([
      expect.objectContaining({
        event: "run-start",
        runId: "0011223344556603",
        requested: primary.id,
        selected: fallback.id,
      }),
      expect.objectContaining({
        event: "run-finish",
        runId: "0011223344556603",
        requested: primary.id,
        selected: fallback.id,
      }),
    ]);
  });

  it("a fallback child start is not recovery", async () => {
    const paths = await fixture(remoteFallbackManifest());
    let recoveries = 0;
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (_profile, _command, _mode, hooks) => {
        await hooks.onRemoteChildStarted();
        return { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState({
        selectPrimary: async () => false,
        observePrimaryChildStarted: async () => {
          recoveries += 1;
        },
      }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await dependencies.runProfile!(primary, undefined, "auto", undefined, fallback);
    expect(recoveries).toBe(0);
  });

  it("a primary child start is recovery", async () => {
    const paths = await fixture(remoteFallbackManifest());
    let recoveries = 0;
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (_profile, _command, _mode, hooks) => {
        await hooks.onRemoteChildStarted();
        return { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState({
        observePrimaryChildStarted: async () => {
          recoveries += 1;
        },
      }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await dependencies.runProfile!(primary, undefined, "auto", undefined, fallback);
    expect(recoveries).toBe(1);
  });

  it("a security failure on the primary does not run the fallback", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const legs: string[] = [];
    const refusals: unknown[] = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (profile, _command, _mode, hooks) => {
        legs.push(profile.id);
        await hooks.recordRefusal?.("security", "host-key");
        return { kind: "exit", status: 75 };
      },
      fallbackState: fallbackState({
        observeRefused: async (...refusal) => {
          refusals.push(refusal);
        },
      }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.runProfile!(primary, undefined, "auto", undefined, fallback)).resolves.toBe(75);
    expect(legs).toEqual(["verify-full-pop-os"]);
    expect(refusals).toEqual([["security", "host-key"]]);
  });

  it("records requested and selected on every record", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const commands: Array<readonly string[]> = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      now: () => "2026-07-31T12:34:56.000Z",
      createRunId: () => "0011223344556602",
      executeLeg: async (profile, command, _mode, hooks) => {
        commands.push([...command]);
        if (profile.id === "verify-full-pop-os") {
          hooks.onUnavailable("transport");
          return { kind: "failover", reason: "transport" };
        }
        return { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState(),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await dependencies.runProfile!(primary, undefined, "auto", undefined, fallback);

    const primaryRecords = await runRecords(dependencies, primary.id);
    const fallbackRecords = await runRecords(dependencies, fallback.id);
    expect(primaryRecords.map(({ event }) => event)).toEqual(["run-start", "run-unavailable", "run-failover"]);
    expect(fallbackRecords.map(({ event }) => event)).toEqual(["run-start", "run-finish"]);
    expect(primaryRecords.every(({ requested, selected }) => requested === primary.id && selected === primary.id)).toBe(
      true,
    );
    expect(
      fallbackRecords.every(({ requested, selected }) => requested === primary.id && selected === fallback.id),
    ).toBe(true);
    expect([...primaryRecords, ...fallbackRecords].every(({ runId }) => runId === "0011223344556602")).toBe(true);
    expect(primaryRecords.at(-1)).toMatchObject({ to: fallback.id, reason: "transport" });
    expect(commands).toEqual([["./scripts/primary"], ["./scripts/fallback"]]);
  });

  it("carries one explicit command override through both legs", async () => {
    const paths = await fixture(remoteFallbackManifest());
    const commands: Array<readonly string[]> = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async (profile, command) => {
        commands.push([...command]);
        return profile.id === "verify-full-pop-os"
          ? { kind: "failover", reason: "transport" }
          : { kind: "exit", status: 0 };
      },
      fallbackState: fallbackState(),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await dependencies.runProfile!(primary, ["./explicit", "--flag"], "auto", undefined, fallback);
    expect(commands).toEqual([
      ["./explicit", "--flag"],
      ["./explicit", "--flag"],
    ]);
  });

  it("a plain profile keeps today's records plus requested equals selected", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      executeLeg: async () => ({ kind: "exit", status: 0 }),
    });
    const profile = (await dependencies.loadManifest()).profiles[0]!;

    await dependencies.runProfile!(profile, undefined, "auto");

    const records = await runRecords(dependencies);
    expect(records.map(({ event }) => event)).toEqual(["run-start", "run-finish"]);
    expect(records.every(({ requested, selected }) => requested === profile.id && selected === profile.id)).toBe(true);
  });

  it("benchmarking an unreachable remote-fallback profile returns 75 without running fallback or writing v2 state", async () => {
    const paths = await fixture(resolveManifest());
    await seedResolveKnownHosts(paths);
    class BenchmarkProcesses extends ResolveProcesses {
      primaryRequests = 0;
      fallbackRequests = 0;

      override async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
        if (request.args.some((part) => part.includes("admin@primary"))) this.primaryRequests += 1;
        if (request.args.some((part) => part.includes("admin@pop-os"))) this.fallbackRequests += 1;
        return super.run(request);
      }
    }
    const processes = new BenchmarkProcesses({ "admin@primary": "reachability" });
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      now: () => "2026-07-31T12:34:56.000Z",
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });
    const profile = (await dependencies.loadManifest()).profiles.find(({ id }) => id === "verify-full-pop-os")!;

    const report = (await dependencies.benchmarkProfile!(profile)) as {
      rows: Array<{ location: string; status: number }>;
    };
    const remote = report.rows.find(({ location }) => location === "remote");

    expect(remote?.status).toBe(75);
    expect(processes.primaryRequests).toBeGreaterThan(0);
    expect(processes.fallbackRequests).toBe(0);
    await expect(
      readFile(
        join(paths.home, ".local", "state", "remote-runner", "fallback", profile.consumer, profile.id, "state.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolve reports fallback active for an explicit local leg", async () => {
    const manifestText = validManifest.replaceAll("SHA256:trusted", resolveHostPin);
    const { dependencies, manifest } = await resolveHarness({ "admin@pop-os": "reachable" }, manifestText);
    const profile = manifest.profiles[0]!;

    await expect(dependencies.resolveProfile!(profile, undefined, "local")).resolves.toMatchObject({
      outcome: "selected",
      answer: { selected: profile.id, remoteLabel: null, fallbackActive: true, reason: "mode-local" },
    });
  });

  it.each(["security", "remote", "local"] as const)(
    "resolve selects a plain profile's local leg after a %s failure under auto",
    async (failureClass) => {
      const manifestText = validManifest.replaceAll("SHA256:trusted", resolveHostPin);
      const { dependencies, manifest } = await resolveHarness({ "admin@pop-os": failureClass }, manifestText);
      const profile = manifest.profiles[0]!;

      await expect(dependencies.resolveProfile!(profile, undefined, "auto")).resolves.toMatchObject({
        outcome: "selected",
        answer: { selected: profile.id, remoteLabel: null, fallbackActive: true },
      });
    },
  );

  it.each(["security", "remote", "local"] as const)(
    "resolve selects the fallback profile's local leg after a %s failure under auto",
    async (failureClass) => {
      const { dependencies, manifest } = await resolveHarness(
        { "admin@primary": "reachable", "admin@pop-os": failureClass },
        resolveManifest(),
        fallbackState({ selectPrimary: async () => false }),
      );
      const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
      const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

      await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
        outcome: "selected",
        answer: { selected: fallback.id, remoteLabel: null, fallbackActive: true },
      });
    },
  );

  it("resolve answers the reachable primary without Mutagen or a profile lock", async () => {
    let reachable = 0;
    const { dependencies, manifest, paths, processes } = await resolveHarness(
      { "admin@primary": "reachable", "admin@pop-os": "reachable" },
      resolveManifest(),
      fallbackState({
        observeReachable: async () => {
          reachable += 1;
        },
      }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toEqual({
      outcome: "selected",
      answer: {
        requested: primary.id,
        selected: primary.id,
        remoteLabel: primary.remote.label,
        fallbackActive: false,
        reason: null,
        checkedAt: "2026-09-29T10:00:00.000Z",
      },
    });
    expect(reachable).toBe(1);
    expect(processes.requests.some(({ command }) => command.includes("mutagen"))).toBe(false);
    await expect(
      realpath(join(paths.home, ".local", "state", "remote-runner", "locks", dependencies.identity)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolve stops the Mutagen daemon when managed SSH transport changed", async () => {
    const paths = await fixture(resolveManifest());
    await seedResolveKnownHosts(paths);
    const order: string[] = [];
    class ChangedTransportProcesses extends ResolveProcesses {
      override async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
        if (request.args[0] === "daemon" && request.args[1] === "stop") order.push("daemon-stop");
        if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-home-probe")) {
          order.push("home-probe");
        }
        return super.run(request);
      }
    }
    const processes = new ChangedTransportProcesses({ "admin@primary": "reachable" });
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      managedSsh: { changed: true, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes,
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
      outcome: "selected",
      answer: { selected: primary.id },
    });
    expect(order.slice(0, 2)).toEqual(["daemon-stop", "home-probe"]);
  });

  it("resolve answers the fallback and records an unreachable primary", async () => {
    const unreachable: string[] = [];
    const { dependencies, manifest } = await resolveHarness(
      { "admin@primary": "reachability", "admin@pop-os": "reachable" },
      resolveManifest(),
      fallbackState({ observeUnreachable: async (reason) => void unreachable.push(reason) }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toEqual({
      outcome: "selected",
      answer: expect.objectContaining({
        requested: primary.id,
        selected: fallback.id,
        remoteLabel: primary.remote.label,
        fallbackActive: true,
        reason: "transport",
      }),
    });
    expect(unreachable).toEqual(["transport"]);
  });

  it("resolve uses a cached negative entry without probing the primary", async () => {
    const { dependencies, manifest, processes } = await resolveHarness(
      { "admin@primary": "reachable", "admin@pop-os": "reachable" },
      resolveManifest(),
      fallbackState({
        selectPrimary: async () => false,
        selectPrimaryDecision: async () => ({
          usePrimary: false,
          reason: "dns",
          checkedAt: "2026-09-29T09:59:00.000Z",
        }),
      }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
      outcome: "selected",
      answer: {
        selected: fallback.id,
        fallbackActive: true,
        reason: "dns",
        checkedAt: "2026-09-29T09:59:00.000Z",
      },
    });
    expect(
      processes.requests.some(
        ({ command, args }) => command === "ssh" && args.some((part) => part === primary.remote.target),
      ),
    ).toBe(false);
  });

  it("resolve selects the local chain end under auto when both remotes are unreachable", async () => {
    const { dependencies, manifest } = await resolveHarness({
      "admin@primary": "reachability",
      "admin@pop-os": "reachability",
    });
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
      outcome: "selected",
      answer: {
        requested: primary.id,
        selected: fallback.id,
        remoteLabel: null,
        fallbackActive: true,
        reason: "transport",
      },
    });
  });

  it("resolve returns nothing reachable under remote mode", async () => {
    const { dependencies, manifest } = await resolveHarness({
      "admin@primary": "reachability",
      "admin@pop-os": "reachability",
    });
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "remote")).resolves.toMatchObject({
      outcome: "unreachable",
      answer: { requested: primary.id, selected: null, remoteLabel: null, fallbackActive: true },
    });
  });

  it("resolve returns a security refusal and records it on the primary", async () => {
    const paths = await fixture(resolveManifest());
    const staleKey = Buffer.from("stale-host-key").toString("base64");
    class StalePinProcesses extends ResolveProcesses {
      override async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
        if (request.command === "ssh-keyscan") return result(`primary ssh-ed25519 ${staleKey}\n`);
        return super.run(request);
      }
    }
    const refusals: unknown[] = [];
    const dependencies = await createNodeCliDependencies({
      ...paths,
      clientId: "test-client",
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new StalePinProcesses({ "admin@primary": "reachable", "admin@pop-os": "reachable" }),
      now: () => "2026-09-29T10:00:00.000Z",
      fallbackState: fallbackState({
        observeRefused: async (...refusal) => {
          refusals.push(refusal);
        },
      }),
    });
    const manifest = await dependencies.loadManifest();
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
      outcome: "security",
      answer: { selected: null, reason: "host-key" },
    });
    expect(refusals).toEqual([["security", "host-key"]]);
  });

  it("resolve throws on a local primary fault", async () => {
    const { dependencies, manifest } = await resolveHarness({
      "admin@primary": "local",
      "admin@pop-os": "reachable",
    });
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).rejects.toMatchObject({
      failureClass: "local",
    });
  });

  it("resolve maps a remote primary refusal to unreachable", async () => {
    const refusals: unknown[] = [];
    const { dependencies, manifest } = await resolveHarness(
      { "admin@primary": "remote", "admin@pop-os": "reachable" },
      resolveManifest(),
      fallbackState({
        observeRefused: async (...refusal) => {
          refusals.push(refusal);
        },
      }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "auto")).resolves.toMatchObject({
      outcome: "unreachable",
      answer: { selected: null, reason: "remote-shell" },
    });
    expect(refusals).toEqual([["remote", "remote-shell"]]);
  });

  it.each([
    ["security", "security"],
    ["remote", "unreachable"],
  ] as const)("resolve maps a %s fault on the fallback to %s", async (failureClass, outcome) => {
    const { dependencies, manifest } = await resolveHarness(
      { "admin@primary": "reachable", "admin@pop-os": failureClass },
      resolveManifest(),
      fallbackState({ selectPrimary: async () => false }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "remote")).resolves.toMatchObject({
      outcome,
      answer: { selected: null },
    });
  });

  it("resolve throws on a local fault on the fallback", async () => {
    const { dependencies, manifest } = await resolveHarness(
      { "admin@primary": "reachable", "admin@pop-os": "local" },
      resolveManifest(),
      fallbackState({ selectPrimary: async () => false }),
    );
    const primary = manifest.profiles.find(({ id }) => id === "verify-full-pop-os")!;
    const fallback = manifest.profiles.find(({ id }) => id === "verify-full")!;

    await expect(dependencies.resolveProfile!(primary, fallback, "remote")).rejects.toMatchObject({
      failureClass: "local",
    });
  });

  it.each([
    ["security", "security"],
    ["remote", "unreachable"],
  ] as const)("resolve maps a %s fault on a plain profile to %s", async (failureClass, outcome) => {
    const manifestText = validManifest.replaceAll("SHA256:trusted", resolveHostPin);
    const { dependencies, manifest } = await resolveHarness({ "admin@pop-os": failureClass }, manifestText);
    const profile = manifest.profiles[0]!;

    await expect(dependencies.resolveProfile!(profile, undefined, "remote")).resolves.toMatchObject({
      outcome,
      answer: { selected: null },
    });
  });

  it("resolve throws on a local fault on a plain profile", async () => {
    const manifestText = validManifest.replaceAll("SHA256:trusted", resolveHostPin);
    const { dependencies, manifest } = await resolveHarness({ "admin@pop-os": "local" }, manifestText);

    await expect(dependencies.resolveProfile!(manifest.profiles[0]!, undefined, "remote")).rejects.toMatchObject({
      failureClass: "local",
    });
  });
});
