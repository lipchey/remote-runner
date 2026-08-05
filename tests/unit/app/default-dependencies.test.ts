import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeCliDependencies, type NodeCliDependencies } from "../../../src/app/default-dependencies.js";
import { inspectPrewarmRequest } from "../../../src/prewarm/queue.js";
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
  readonly error?: string;
  readonly durationMs?: number;
}

async function runRecords(dependencies: NodeCliDependencies): Promise<RunRecord[]> {
  return ((await dependencies.logsProfile?.("verify-full")) ?? []).map((line) => JSON.parse(line) as RunRecord);
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
    expect(report.checks).toHaveLength(17);
    expect(await dependencies.logsProfile?.("verify-full")).toEqual(["older", "current"]);
    expect(processes.requests.every((request) => request.command !== "sh" && request.command !== "bash")).toBe(true);
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

  it("keeps repair actions inside one profile identity and requires its exact dry-run receipt", async () => {
    const paths = await fixture();
    const dependencies = await createNodeCliDependencies({
      ...paths,
      launcherSource: new Uint8Array([1]),
      managedSsh: { changed: false, directory: paths.managedSshPath, knownHostsPath: paths.knownHostsPath },
      processes: new FakeProcesses(),
      now: () => "2026-07-31T12:34:56.000Z",
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
    const corruptPath = join(profileRoot, "outage.json.corrupt-evidence");
    await mkdir(profileRoot, { recursive: true });
    await writeFile(corruptPath, "retained evidence");

    const preview = (await dependencies.repairProfile?.("verify-full", false)) as {
      actions: Array<{ target: string }>;
    };
    expect(preview.actions).toEqual([expect.objectContaining({ target: corruptPath })]);
    expect(await readFile(corruptPath, "utf8")).toBe("retained evidence");

    await dependencies.repairProfile?.("verify-full", true);
    await expect(readFile(corruptPath)).rejects.toMatchObject({ code: "ENOENT" });
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

    expect(executions).toHaveLength(14);
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
      "| remote | full | warm |",
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
    expect(records.at(-1)).toMatchObject({ event: "run-finish", status: 75, provider: "remote" });
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

  it("refuses symlinked repair receipts and benchmark output directories", async () => {
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
    const outsideReceipt = join(outside, "repair.json");
    await writeFile(outsideReceipt, "sentinel");
    await symlink(outsideReceipt, join(profileRoot, "repair-dry-run.json"));

    await expect(dependencies.repairProfile?.("verify-full", false)).rejects.toThrow(/symlink/u);
    await expect(readFile(outsideReceipt, "utf8")).resolves.toBe("sentinel");

    await symlink(outside, join(paths.sourceRoot, "benchmark"));
    const profile = (await dependencies.loadManifest()).profiles[0]!;
    await expect(dependencies.benchmarkProfile?.(profile)).rejects.toThrow(/escapes source root/u);
    await expect(readFile(join(outside, "20260731T123456Z-verify-full.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
