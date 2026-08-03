import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeCliDependencies } from "../../../src/app/default-dependencies.js";
import { inspectPrewarmRequest } from "../../../src/prewarm/queue.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../../src/ssh/client.js";
import { validManifest } from "../config/manifest-fixture.js";

const temporaryRoots: string[] = [];

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
  };
}

class FakeProcesses {
  readonly requests: BoundedProcessRequest[] = [];
  registrationExitCode = 0;

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    this.requests.push(request);
    if (request.command === "launchctl") return result("state = running\n");
    if (request.args[0] === "sync" && request.args[1] === "list") {
      return result(`${JSON.stringify([{ name: request.args.at(-1), paused: false, status: "watching" }])}\n`);
    }
    if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-status")) {
      return result('{"workspace":"ready","fingerprint":"current"}\n');
    }
    if (request.command === "ssh" && request.args.at(-1)?.includes("remote-runner-workspace-registration")) {
      return result("", this.registrationExitCode);
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
    const report = (await dependencies.doctorProfile?.("verify-full")) as { checks: readonly unknown[] };
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
    const report = (await dependencies.doctorProfile?.("verify-full")) as {
      checks: readonly { id: string; status: string; reason?: string }[];
    };
    const serializedRequests = JSON.stringify(processes.requests);

    expect(serializedRequests).toContain(`${generatedRoot}/ariadne/verify-full/`);
    expect(serializedRequests).toContain(`${generatedRoot}/ariadne/.mirror.git`);
    expect(report.checks).toContainEqual({
      id: "remote.workspace-registration",
      status: "fail",
      reason: "workspace-registration",
      next: "ssh <remote> inspect exact Git worktree registration for <workspace>",
    });
    expect(JSON.stringify(report)).not.toContain(generatedRoot);
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
    expect(lines?.join("\n")).not.toContain("ignored-secret-like-argument");
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
