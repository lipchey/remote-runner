import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeCliDependencies, type NodeCliDependencies } from "../../../src/app/default-dependencies.js";
import { DIAGNOSTIC_PROBES } from "../../../src/diagnostics/doctor.js";
import { consumeNextPrewarmRequest, inspectPrewarmRequest } from "../../../src/prewarm/queue.js";
import { worktreeIdentity } from "../../../src/runtime/identity.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../../src/ssh/client.js";
import { compileIgnores, mutagenSessionName } from "../../../src/sync/mutagen.js";
import { validManifest } from "../config/manifest-fixture.js";

const temporaryRoots: string[] = [];
const MANIFEST_COMPILED_IGNORES = compileIgnores(["node_modules", ".git"]);

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
  return { root, sourceRoot, home, managedSshPath, knownHostsPath };
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

interface RunRecord {
  readonly event: string;
  readonly runId: string;
  readonly pid: number;
  readonly profile?: string;
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

async function runRecords(dependencies: NodeCliDependencies): Promise<RunRecord[]> {
  return ((await dependencies.logsProfile?.("verify-full")) ?? []).map((line) => JSON.parse(line) as RunRecord);
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

describe("concrete Node CLI dependencies", () => {
  it("publishes a canonical prewarm request only after confirming controller health", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    const dependencies = await createNodeCliDependencies({
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
    ).resolves.toBe("queued");
    expect(processes.requests.some(({ command }) => command === "launchctl")).toBe(true);
  });

  it("loads cwd manifest profiles for status, doctor, and bounded owned logs", async () => {
    const paths = await fixture();
    const processes = new FakeProcesses();
    const dependencies = await createNodeCliDependencies({
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
      /^verify-full controller=running prewarm=queued session=watching workspace=ready fingerprint=current outage=clear$/u,
    );
    const report = (await dependencies.doctorProfile?.("verify-full"))![0]!.report;
    expect(report.checks).toHaveLength(DIAGNOSTIC_PROBES.length);
    expect(await dependencies.logsProfile?.("verify-full")).toEqual(["older", "current"]);
    expect(processes.requests.every((request) => request.command !== "sh" && request.command !== "bash")).toBe(true);
  });

  it("reports the last prewarm's terminal outcome on the status line", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
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
    const identity = worktreeIdentity(sourceRoot);
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
          path: `${generatedRoot}/ariadne/verify-full/${identity}`,
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
      join(home, ".cache", "remote-runner", "workspaces", "ariadne", "verify-full", dependencies.identity);
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

  it("writes bounded diagnostic lifecycle records for real profile dispatch", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
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
    expect(Object.keys(unavailable[0]!)).toEqual(["at", "event", "runId", "pid", "profile", "mode", "reason"]);
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
