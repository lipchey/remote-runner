import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LOCK_WAIT_MS,
  LOCK_WAIT_NOTICE_MS,
  NodeProfileServices,
  POST_WORKLOAD_LOCK_WAIT_MS,
  WORKLOAD_LOCK_WAIT_MS,
  listLocalFingerprintFiles,
  listLocalGitlinks,
  localWorktreeExists,
  parseProbeOutput,
  remoteArtifactCheckArguments,
  remoteChildArguments,
  remoteWorkspaceCommandArguments,
  resolveRemotePaths,
} from "../../../src/app/pilot-services.js";
import { loadManifestText } from "../../../src/config/load-manifest.js";
import type { Profile } from "../../../src/config/types.js";
import type { NodeProcessRuntime, StreamingProcessRequest } from "../../../src/node/process.js";
import { pathIdentity, worktreeIdentity } from "../../../src/runtime/identity.js";
import { RunTelemetry } from "../../../src/runtime/telemetry.js";
import { prepareRemote } from "../../../src/run/prepare.js";
import { REMOTE_BUSY_EXIT_CODE, type BoundedProcessRequest } from "../../../src/ssh/client.js";
import { validManifest } from "../config/manifest-fixture.js";

const profile = loadManifestText(validManifest).profiles[0]!;
const dataAiProfile = loadManifestText(
  validManifest.replace(
    'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
    'workspace: { generatedRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces" }',
  ),
).profiles[0]!;
const retainedDataAiProfile = loadManifestText(
  validManifest.replace(
    'workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }',
    'workspace: { generatedRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces", retention: { keep: 1, graceMinutes: 60 } }',
  ),
).profiles[0]!;

const ensureProfile = loadManifestText(
  validManifest.replace(
    'setup: ["./scripts/ds-bootstrap.sh"]',
    'setup: ["./scripts/ds-bootstrap.sh"], ensure: [["node", "scripts/pnpm-state.mjs"]]',
  ),
).profiles[0]!;

/* The local leg collects secrets before it spawns anything, so every local-run case needs a source
   that really answers. The fixture's own provider script does not exist in this repository. */
const LOCAL_SECRET = "ephemeral-canary";
const answeringProvider = [
  process.execPath,
  "-e",
  `process.stdout.write(JSON.stringify({ NEON_DEV_DATABASE_URL: ${JSON.stringify(LOCAL_SECRET)} }))`,
];
function withSecretProvider(source: Profile, provider: string[] = answeringProvider): Profile {
  return {
    ...source,
    bootstrap: { ...source.bootstrap, setup: [], artifacts: [], ensure: [] },
    secrets: { ...source.secrets, provider },
  };
}

interface ProcessOutcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly spawned?: boolean;
  readonly spawnErrorCode?: string;
}

function fakeProcesses(...outcomes: ProcessOutcome[]): NodeProcessRuntime {
  return {
    async run() {
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error("unexpected process call");
      return {
        exitCode: outcome.exitCode ?? 0,
        stdout: new TextEncoder().encode(outcome.stdout ?? ""),
        stderr: new TextEncoder().encode(outcome.stderr ?? ""),
        outputTruncated: false,
        spawned: outcome.spawned ?? true,
        ...(outcome.spawnErrorCode === undefined ? {} : { spawnErrorCode: outcome.spawnErrorCode }),
      };
    },
    async isAlive() {
      return false;
    },
  } as NodeProcessRuntime;
}

async function prepareProbeFailure(outcome: ProcessOutcome) {
  const services = new NodeProfileServices(profile, {
    clientId: "test-client",
    home: "/tmp/remote-runner-test-home",
    sourceRoot: process.cwd(),
    launcherSource: new Uint8Array(),
    processes: fakeProcesses(outcome),
  });
  services.validate = async () => undefined;
  services.acquireLock = async () => async () => undefined;
  return prepareRemote(services);
}

describe("pilot service boundaries", () => {
  it("classifies missing ssh as a local transport failure", async () => {
    expect(await prepareProbeFailure({ exitCode: 127, spawned: false, spawnErrorCode: "ENOENT" })).toMatchObject({
      ok: false,
      reason: "transport",
      failureClass: "local",
    });
  });

  it("classifies an un-enrolled unreachable primary as reachability", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-keyscan-"));
    try {
      const services = new NodeProfileServices(profile, {
        clientId: "test-client",
        home,
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array(),
        processes: fakeProcesses({ exitCode: 1 }),
      });

      expect(await prepareRemote(services)).toMatchObject({
        ok: false,
        reason: "transport",
        failureClass: "reachability",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("classifies DNS failure as reachability", async () => {
    expect(
      await prepareProbeFailure({
        exitCode: 255,
        stderr: "ssh: Could not resolve hostname pop-os: nodename nor servname provided",
      }),
    ).toMatchObject({ ok: false, reason: "dns", failureClass: "reachability" });
  });

  it("classifies authentication failure as security", async () => {
    expect(
      await prepareProbeFailure({ exitCode: 255, stderr: "admin@pop-os: Permission denied (publickey)." }),
    ).toMatchObject({ ok: false, reason: "authentication", failureClass: "security" });
  });

  it("classifies a stale host-key pin as security", async () => {
    expect(
      await prepareProbeFailure({ exitCode: 255, stderr: "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" }),
    ).toMatchObject({ ok: false, reason: "host-key", failureClass: "security" });
  });

  it("classifies a Mutagen endpoint mismatch as security", async () => {
    const identity = worktreeIdentity(process.cwd(), "test-client");
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      processes: fakeProcesses(
        {},
        {
          stdout: JSON.stringify([
            {
              identifier: `sync_${identity}`,
              name: `remote-runner-${profile.consumer}-${profile.id}-${identity}`,
              alpha: { protocol: "local", path: await realpath(process.cwd()) },
              beta: { url: "admin@other:/srv/other" },
              mode: "one-way-replica",
              ignore: { paths: [] },
              paused: true,
            },
          ]),
        },
      ),
    });
    services.validate = async () => undefined;
    services.acquireLock = async () => async () => undefined;
    services.probe = async () => undefined;
    services.touchActivity = async () => undefined;
    Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", profile, identity, "test-client") });

    expect(await prepareRemote(services)).toMatchObject({ ok: false, reason: "sync", failureClass: "security" });
  });

  it.each([0, 7])(
    "prepares local dependencies before announcing or starting work (setup exit %s)",
    async (setupExit) => {
      const root = await mkdtemp(join(tmpdir(), "local-service-"));
      try {
        execFileSync("git", ["init", "--quiet", root]);
        await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.9.0" }));
        await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        await writeFile(join(root, "setup.sh"), `#!/bin/sh\nprintf ready > artifact\nexit ${setupExit}\n`, {
          mode: 0o700,
        });
        const configured = withSecretProvider(profile);
        const calls: string[] = [];
        const services = new NodeProfileServices(
          {
            ...configured,
            bootstrap: {
              ...configured.bootstrap,
              setup: ["./setup.sh"],
              artifacts: ["artifact"],
              ensure: [[process.execPath, "-e", "require('node:fs').appendFileSync('ensured', 'yes')"]],
            },
          },
          {
            clientId: "test-client",
            home: join(root, "home"),
            sourceRoot: root,
            launcherSource: new Uint8Array(),
            onLocalExecution: () => calls.push("local"),
            onUnavailable: (reason) => calls.push(reason),
            stdout: () => calls.push("workload"),
            stderr: () => undefined,
          },
        );
        const run = () =>
          services.runLocal([
            process.execPath,
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('ensured'))",
          ]);
        if (setupExit === 0) {
          expect(await run()).toBe(0);
          expect(await run()).toBe(0);
          expect(calls).toEqual(["local", "workload", "local", "workload"]);
        } else {
          await expect(run()).rejects.toThrow();
          expect(calls).toEqual(["consumer-setup"]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("applies the manifest child environment to a local workload", async () => {
    const chunks: Uint8Array[] = [];
    const services = new NodeProfileServices(
      withSecretProvider({
        ...profile,
        workload: {
          ...profile.workload,
          childEnvironment: {
            ...profile.workload.childEnvironment,
            LOCAL_FALLBACK_CANARY: "manifest",
          },
        },
      }),
      {
        clientId: "test-client",
        home: "/tmp/remote-runner-test-home",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array(),
        stdout: (chunk) => chunks.push(chunk),
        stderr: () => undefined,
      },
    );

    const exitCode = await services.runLocal([
      process.execPath,
      "-e",
      'process.stdout.write([process.env.LOCAL_FALLBACK_CANARY, process.env.REMOTE_RUNNER_CHILD, process.env.REMOTE_RUNNER_PROVIDER].join("|"))',
    ]);

    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("manifest|1|local");
  });

  it("sets local child profile markers after inherited environment values", async () => {
    const chunks: Uint8Array[] = [];
    const inherited = process.env.REMOTE_RUNNER_REMOTE_LABEL;
    process.env.REMOTE_RUNNER_REMOTE_LABEL = "inherited";
    try {
      const services = new NodeProfileServices(withSecretProvider(profile), {
        clientId: "test-client",
        home: "/tmp/remote-runner-test-home",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array(),
        stdout: (chunk) => chunks.push(chunk),
        stderr: () => undefined,
      });

      await services.runLocal([
        process.execPath,
        "-e",
        "process.stdout.write(`${process.env.REMOTE_RUNNER_SELECTED_PROFILE}|${process.env.REMOTE_RUNNER_REMOTE_LABEL}`)",
      ]);

      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("verify-full|");
    } finally {
      if (inherited === undefined) delete process.env.REMOTE_RUNNER_REMOTE_LABEL;
      else process.env.REMOTE_RUNNER_REMOTE_LABEL = inherited;
    }
  });

  it("carries the allowlisted secrets into the local child, as the remote launcher does", async () => {
    const chunks: Uint8Array[] = [];
    const services = new NodeProfileServices(withSecretProvider(profile), {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stdout: (chunk) => chunks.push(chunk),
      stderr: () => undefined,
    });

    const exitCode = await services.runLocal([
      process.execPath,
      "-e",
      "process.stdout.write(String(process.env.NEON_DEV_DATABASE_URL))",
    ]);

    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe(LOCAL_SECRET);
  });

  it("prefers the snapshot prepared for the remote child over a second collection", async () => {
    const chunks: Uint8Array[] = [];
    /* A provider that would answer differently: proving the snapshot is used, not merely that some
       value arrives, needs the two sources to disagree. */
    const services = new NodeProfileServices(
      withSecretProvider(profile, [
        process.execPath,
        "-e",
        'process.stdout.write(JSON.stringify({ NEON_DEV_DATABASE_URL: "collected-again" }))',
      ]),
      {
        clientId: "test-client",
        home: "/tmp/remote-runner-test-home",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array(),
        stdout: (chunk) => chunks.push(chunk),
        stderr: () => undefined,
      },
    );

    const exitCode = await services.runLocal(
      [process.execPath, "-e", "process.stdout.write(String(process.env.NEON_DEV_DATABASE_URL))"],
      { NEON_DEV_DATABASE_URL: "prepared-snapshot" },
    );

    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("prepared-snapshot");
  });

  it("lets a secret override the provider markers, exactly as the remote launcher does", async () => {
    const chunks: Uint8Array[] = [];
    const overriding = withSecretProvider(profile, [
      process.execPath,
      "-e",
      'process.stdout.write(JSON.stringify({ REMOTE_RUNNER_PROVIDER: "from-secret" }))',
    ]);
    const services = new NodeProfileServices(
      { ...overriding, secrets: { ...overriding.secrets, allow: ["REMOTE_RUNNER_PROVIDER"] } },
      {
        clientId: "test-client",
        home: "/tmp/remote-runner-test-home",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array(),
        stdout: (chunk) => chunks.push(chunk),
        stderr: () => undefined,
      },
    );

    await services.runLocal([
      process.execPath,
      "-e",
      "process.stdout.write(String(process.env.REMOTE_RUNNER_PROVIDER))",
    ]);

    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("from-secret");
  });

  it("refuses to run the workload locally when the secrets it would carry cannot be collected", async () => {
    const chunks: Uint8Array[] = [];
    const lines: string[] = [];
    const observed: string[] = [];
    let markedLocal = false;
    const services = new NodeProfileServices(withSecretProvider(profile, [process.execPath, "-e", "process.exit(3)"]), {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stdout: (chunk) => chunks.push(chunk),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      onUnavailable: (reason) => observed.push(reason),
      onLocalExecution: () => {
        markedLocal = true;
      },
    });

    await expect(services.runLocal([process.execPath, "-e", 'process.stdout.write("workload ran")'])).rejects.toThrow(
      "secret provider failed with exit code 3",
    );

    expect(chunks).toEqual([]);
    expect(observed).toEqual(["secrets"]);
    expect(lines.join("")).toContain("reason=secrets");
    /* The callback that stamps the run record with `provider: "local"` must not fire for a leg
       whose workload never started. */
    expect(markedLocal).toBe(false);
  });

  it("notifies onLocalExecution before running a local workload", async () => {
    let notified = false;
    const services = new NodeProfileServices(withSecretProvider(profile), {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stdout: () => undefined,
      stderr: () => undefined,
      onLocalExecution: () => {
        notified = true;
      },
    });

    await services.runLocal([process.execPath, "-e", ""]);

    expect(notified).toBe(true);
  });

  it("announces the local fallback reason to the operator before recording it", async () => {
    const lines: string[] = [];
    let recorded: string | undefined;
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      recordFallback: async (reason) => {
        recorded = reason;
      },
    });

    await services.recordFallback("child-start");

    expect(lines).toEqual(["remote-runner: running locally (fallback reason=child-start)\n"]);
    expect(recorded).toBe("child-start");
  });

  it("forwards the unavailable reason and its optional detail to the run log observer", () => {
    const lines: string[] = [];
    const observed: (readonly [string, string | undefined])[] = [];
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      onUnavailable: (reason, detail) => observed.push([reason, detail]),
    });

    services.reportUnavailable("sync", "Mutagen session list returned malformed JSON");
    services.reportUnavailable("bootstrap");

    expect(observed).toEqual([
      ["sync", "Mutagen session list returned malformed JSON"],
      ["bootstrap", undefined],
    ]);
    expect(lines.join("")).toContain("Mutagen session list returned malformed JSON");
  });

  it("maps a hostile fallback reason to the closed set before logging or forwarding it", async () => {
    const lines: string[] = [];
    let recorded: string | undefined;
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      recordFallback: async (reason) => {
        recorded = reason;
      },
    });

    await services.recordFallback("evil\x1b[31m\ninjected");

    expect(lines).toEqual(["remote-runner: running locally (fallback reason=unknown)\n"]);
    expect(recorded).toBe("unknown");
  });

  it("resolves every generated target below the canonical remote home", () => {
    const paths = resolveRemotePaths("/home/admin", profile, "0123456789abcdef01234567", "test-client");

    expect(paths.generatedRoot).toBe("/home/admin/.cache/remote-runner/workspaces");
    expect(paths.workspace).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
    );
    expect(paths.workloadLock).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/.locks/0123456789abcdef01234567",
    );
    expect(paths.activityMarker).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/.activity/0123456789abcdef01234567",
    );
    expect(Object.values(paths).every((path) => path.startsWith("/home/admin/"))).toBe(true);
    expect(() => resolveRemotePaths("/", profile, "0123456789abcdef01234567", "test-client")).toThrow();
  });

  it("preserves a canonical absolute generated root outside the remote home", () => {
    const paths = resolveRemotePaths("/home/admin", dataAiProfile, "0123456789abcdef01234567", "test-client");

    expect(paths.generatedRoot).toBe("/mnt/DataAI/home/admin/.cache/remote-runner/workspaces");
    expect(paths.workspace).toBe(
      "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
    );
    expect(paths.toolchainRoot).toBe("/home/admin/.local/share/remote-runner/toolchains");
  });

  it("parses one remote home and byte-capacity record without accepting extra output", () => {
    expect(parseProbeOutput("/home/admin\n12345678901\n", 10_000_000_000)).toEqual({
      home: "/home/admin",
      availableBytes: 12_345_678_901,
    });
    expect(() => parseProbeOutput("/home/admin\n123\nsecret-canary\n", 1)).toThrow();
  });

  it("probes capacity on the resolved generated-root filesystem", async () => {
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        const encoded = request.args.at(-1) ?? "";
        const stdout = encoded.includes("remote-runner-home-probe")
          ? "/home/admin\n"
          : encoded.includes("remote-runner-capacity-probe")
            ? "12345678901\n"
            : "/home/admin\n12345678901\n";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(dataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      processes,
    });

    await services.probe();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.args.at(-1)).toContain("/mnt/DataAI/home/admin/.cache/remote-runner/workspaces");
    expect(requests[1]?.args.at(-1)).toContain("df -Pk");
  });

  it("touches the external activity marker before Mutagen reconciliation begins", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
    });

    await services.touchActivity();
    await services.pauseSync();

    expect(requests[0]?.command).toBe("ssh");
    expect(JSON.stringify(requests[0]?.args)).toContain("remote-runner-touch-activity");
    /* `flock -w` counts seconds and the budget is milliseconds; the unconverted constant is a
       250-hour wait that still reads as a valid script. */
    expect(WORKLOAD_LOCK_WAIT_MS % 1000).toBe(0);
    expect(WORKLOAD_LOCK_WAIT_MS).toBeLessThan(LOCK_WAIT_MS);
    expect(JSON.stringify(requests[0]?.args)).toContain(
      `flock -w ${WORKLOAD_LOCK_WAIT_MS / 1000} 9 || exit ${REMOTE_BUSY_EXIT_CODE}`,
    );
    expect(JSON.stringify(requests[0]?.args)).toContain(`${current}`);
    expect(requests.slice(1).map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
      "daemon start",
      "sync list",
      "sync create",
    ]);
  });

  function servicesWithExitCode(exitCode: number): NodeProfileServices {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const processes = {
      async run() {
        return {
          exitCode,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
    });
    return services;
  }

  it("fails a busy workload lock closed rather than spending the same budget twice", async () => {
    await expect(servicesWithExitCode(REMOTE_BUSY_EXIT_CODE).touchActivity()).rejects.toMatchObject({
      reason: "lock",
      retryable: false,
    });
  });

  /* A truncated capture whose command exited 0 is reported as 75 by the bounded process runtime, so
     reading 75 as contention fails an unrelated run closed. */
  it("does not read the truncation exit code as workload contention", async () => {
    await expect(servicesWithExitCode(75).touchActivity()).rejects.toThrow("remote activity marker update failed");
    expect(REMOTE_BUSY_EXIT_CODE).not.toBe(75);
  });

  it("tells the operator that another run of the workspace is still finishing", async () => {
    vi.useFakeTimers();
    try {
      const current = worktreeIdentity(process.cwd(), "test-client");
      const written: string[] = [];
      let release!: () => void;
      const busy = new Promise<void>((resolve) => {
        release = resolve;
      });
      const processes = {
        async run() {
          await busy;
          return {
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
        async isAlive() {
          return false;
        },
      } as NodeProcessRuntime;
      const services = new NodeProfileServices(retainedDataAiProfile, {
        clientId: "test-client",
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
        stderr: (chunk) => written.push(new TextDecoder().decode(chunk)),
      });
      Object.assign(services, {
        remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
      });

      const pending = services.touchActivity();
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_NOTICE_MS);
      expect(written.join("")).toContain("another run of this workspace is still finishing");

      release();
      await pending;
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_NOTICE_MS * 2);
      expect(written).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives dependency setup a capture bound that a package install fits into", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        const argv = JSON.stringify(request.args);
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(argv.includes("uname") ? "x86_64\n" : ""),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(ensureProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current, "test-client") });

    await services.bootstrap();

    const setup = requests.find(({ args }) => JSON.stringify(args).includes("ds-bootstrap.sh"));
    expect(setup?.maxOutputBytes).toBe(16 * 1024 * 1024);
    const ensure = requests.find(({ args }) => JSON.stringify(args).includes("pnpm-state.mjs"));
    expect(ensure?.maxOutputBytes).toBe(16 * 1024 * 1024);
    const control = requests.find(({ args }) => JSON.stringify(args).includes("remote-runner-install-launcher"));
    expect(control?.maxOutputBytes).toBe(64 * 1024);
    expect(requests.some(({ args }) => JSON.stringify(args).includes("nodejs.org"))).toBe(false);
  });

  /* A setup script that RAN and exited non-zero is the consumer's error: a local fallback would
     reproduce it exactly, so it must not spend one nor claim the workstation is unreachable. */
  it.each([3, 124])(
    "classifies a consumer setup script that exits %i away from a remote outage",
    async (setupExitCode) => {
      const current = worktreeIdentity(process.cwd(), "test-client");
      const outages: string[] = [];
      const processes = {
        async run(request: BoundedProcessRequest) {
          const argv = JSON.stringify(request.args);
          return {
            exitCode: argv.includes("ds-bootstrap.sh") ? setupExitCode : 0,
            stdout: new TextEncoder().encode(argv.includes("uname") ? "x86_64\n" : ""),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
        async isAlive() {
          return false;
        },
      } as NodeProcessRuntime;
      const services = new NodeProfileServices(ensureProfile, {
        clientId: "test-client",
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
        recordFallback: async (reason) => {
          outages.push(reason);
        },
      });
      Object.assign(services, {
        remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current, "test-client"),
      });

      await expect(services.bootstrap()).rejects.toMatchObject({
        name: "PreparationError",
        reason: "consumer-setup",
        retryable: false,
      });
      expect(outages).toEqual([]);
    },
  );

  /* 126/127 come from the remote shell, but the script they refuse to exec lives inside the synced
     workspace: undelivered by Mutagen, or delivered without its exec bit, while the local checkout
     still has it. Attributing that to the consumer withholds the fallback run that would have
     worked — the same reason the artifact postcondition refuses to attribute its own absence. */
  it.each([126, 127])(
    "keeps a setup script the remote shell would not exec (exit %i) a bootstrap failure",
    async (setupExitCode) => {
      const current = worktreeIdentity(process.cwd(), "test-client");
      const processes = {
        async run(request: BoundedProcessRequest) {
          const argv = JSON.stringify(request.args);
          return {
            exitCode: argv.includes("ds-bootstrap.sh") ? setupExitCode : 0,
            stdout: new TextEncoder().encode(argv.includes("uname") ? "x86_64\n" : ""),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
        async isAlive() {
          return false;
        },
      } as NodeProcessRuntime;
      const services = new NodeProfileServices(ensureProfile, {
        clientId: "test-client",
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
      });
      Object.assign(services, {
        remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current, "test-client"),
      });

      const caught = await services.bootstrap().catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toMatchObject({ reason: "consumer-setup" });
    },
  );

  /* The same codes from an ssh client that never ran say nothing about the consumer's script:
     read as theirs they withhold the fallback and silence the alert for an unreachable machine. */
  it.each([1, 124])(
    "keeps a setup command that never reached the remote (exit %i) a bootstrap failure",
    async (setupExitCode) => {
      const current = worktreeIdentity(process.cwd(), "test-client");
      const processes = {
        async run(request: BoundedProcessRequest) {
          const argv = JSON.stringify(request.args);
          const failing = argv.includes("ds-bootstrap.sh");
          return {
            exitCode: failing ? setupExitCode : 0,
            stdout: new TextEncoder().encode(argv.includes("uname") ? "x86_64\n" : ""),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: !failing,
          };
        },
        async isAlive() {
          return false;
        },
      } as NodeProcessRuntime;
      const services = new NodeProfileServices(ensureProfile, {
        clientId: "test-client",
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
      });
      Object.assign(services, {
        remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current, "test-client"),
      });

      const caught = await services.bootstrap().catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toMatchObject({ reason: "consumer-setup" });
    },
  );

  it("keeps a busy lock off the outage channel while still telling the operator", async () => {
    const lines: string[] = [];
    let recorded: string | undefined;
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      recordFallback: async (reason) => {
        recorded = reason;
      },
    });

    await services.recordFallback("lock");

    expect(lines).toEqual(["remote-runner: running locally (fallback reason=lock)\n"]);
    expect(recorded).toBeUndefined();
  });

  /* The fail-closed give-up path announces every reason it collected, so this predicate is the only
     thing keeping the consumer's own broken setup script off the outage channel. */
  it("refuses a local reason on the outage channel without claiming a local run", async () => {
    const lines: string[] = [];
    const recorded: string[] = [];
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      recordFallback: async (reason) => {
        recorded.push(reason);
      },
    });

    await services.recordOutage("consumer-setup");
    await services.recordOutage("transport");

    expect(lines).toEqual([]);
    /* Collected, not overwritten: a single last-value variable stays green when the refused reason
       is emitted first and the accepted one lands on top of it. */
    expect(recorded).toEqual(["transport"]);
  });

  it("builds fixed child argv without putting secret values into it", () => {
    const args = remoteChildArguments(
      "/remote/node/bin/node",
      "/remote/launcher.mjs",
      "/remote/workspace",
      "/remote/profile/.locks/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      profile,
      ["./scripts/verify", "--full"],
    );
    const serialized = JSON.stringify(args);

    expect(args.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    expect(serialized).toContain("NEON_DEV_DATABASE_URL");
    expect(serialized).toContain("REMOTE_RUNNER_CHILD");
    expect(args).toContain("REMOTE_RUNNER_PROVIDER=remote");
    expect(args).toContain("REMOTE_RUNNER_SELECTED_PROFILE=verify-full");
    expect(args).toContain("REMOTE_RUNNER_REMOTE_LABEL=pop-os");
    expect(args.indexOf("REMOTE_RUNNER_SELECTED_PROFILE=verify-full")).toBeGreaterThan(
      args.indexOf("REMOTE_RUNNER_PROVIDER=remote"),
    );
    expect(args.indexOf("REMOTE_RUNNER_REMOTE_LABEL=pop-os")).toBeGreaterThan(args.indexOf("REMOTE_RUNNER_CHILD=1"));
    expect(args).toContain("PATH=/remote/node/bin:/remote/uv:/usr/bin:/bin");
    expect(args).toContain("/remote/profile/.locks/0123456789abcdef01234567");
    expect(args[2]).toContain("flock -x 9");
    expect(args[2]).toContain("exec 9>");
    expect(serialized).not.toContain("secret-canary");
    expect(serialized).not.toContain("postgres://");
  });

  it("builds fixed workspace ensure argv without shell-interpolating the command", () => {
    const command = ["node", "scripts/pnpm-state.mjs", "argument with spaces", ""];
    const args = remoteWorkspaceCommandArguments(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      command,
    );

    expect(args).toEqual([
      "sh",
      "-ceu",
      'cd -- "$1" || exit 125; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
      "remote-runner-workspace-command",
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      ...command,
    ]);
    expect(args[2]).not.toContain("pnpm-state");
  });

  it("builds fixed artifact-check argv without shell-interpolating the path", () => {
    const artifact = "vendor/dev-standards/runner/dist/verify-runner.mjs";
    const args = remoteArtifactCheckArguments(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      artifact,
    );

    expect(args).toEqual([
      "sh",
      "-ceu",
      'cd -- "$1" || exit 125; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
      "remote-runner-workspace-command",
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/clients/d5fe82513196ca977d816609/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      "test",
      "-f",
      artifact,
    ]);
    expect(args[2]).not.toContain(artifact);
  });

  it("touches activity and prunes after a marker-seen nonzero workload without changing its exit", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const stale = "ffffffffffffffffffffffff";
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        const serialized = JSON.stringify(request.args);
        const stdout = serialized.includes("remote-runner-retention-list")
          ? `${2_000_000_000}\0d\0${current}\0${2_000_000_000}\0d\0${stale}\0${1}\0`
          : "";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    let streamCalls = 0;
    const streamProcess = async (request: StreamingProcessRequest) => {
      streamCalls += 1;
      await request.onMarker();
      return { exitCode: streamCalls === 1 ? 23 : 0, signal: null, markerSeen: true, spawned: true };
    };
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client");
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      processes,
      streamProcess,
    });
    Object.assign(services, {
      remotePaths: paths,
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    const result = await services.startRemote(
      ["./scripts/verify", "--full"],
      { NEON_DEV_DATABASE_URL: "secret-canary" },
      async () => undefined,
    );

    expect(result).toEqual({ kind: "completed", exitCode: 23 });
    expect(streamCalls).toBe(2);
    const serializedRequests = requests.map((request) => JSON.stringify(request.args));
    expect(serializedRequests.filter((value) => value.includes("activity")).length).toBeGreaterThanOrEqual(1);
    /* The queue budget belongs to the preparation wait. Spending it here would hold this run's exit
       code back for as long as the next run of the same worktree holds the lock. */
    for (const value of serializedRequests.filter((argv) => argv.includes("remote-runner-touch-activity"))) {
      expect(value).toContain(`flock -w ${POST_WORKLOAD_LOCK_WAIT_MS / 1000} 9`);
    }
    expect(serializedRequests.some((value) => value.includes("remote-runner-retention-list"))).toBe(true);
    /* An identity lock file must outlive its holder: unlinking it drops the inode a concurrent
       holder is locked on, and the next arrival then locks a fresh one and runs alongside it. */
    expect(serializedRequests.filter((value) => /rm -[a-z]* -- \S*\/\.locks\//u.test(value))).toEqual([]);
  });

  /* Collection bounds each secret; only the frame bounds their total, so this is the one secrets
     failure that first becomes visible at child start. Reported as the step that failed rather than
     as a child that failed to start — and reported at all, where a throw here used to exit 75 with
     nothing on stderr, in the runner log or on the outage channel. */
  it("gives up with the secrets reason when the collected values cannot fit one frame", async () => {
    const manySecrets = loadManifestText(
      validManifest.replace("allow: [NEON_DEV_DATABASE_URL]", "allow: [FIRST_SECRET, SECOND_SECRET, THIRD_SECRET]"),
    ).profiles[0]!;
    const services = new NodeProfileServices(manySecrets, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      streamProcess: async () => {
        throw new Error("the frame must fail before anything is spawned");
      },
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths(
        "/home/admin",
        manySecrets,
        worktreeIdentity(process.cwd(), "test-client"),
        "test-client",
      ),
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });
    const value = "x".repeat(50 * 1024);

    const result = await services.startRemote(
      ["./verify"],
      { FIRST_SECRET: value, SECOND_SECRET: value, THIRD_SECRET: value },
      async () => undefined,
    );

    expect(result).toEqual({ kind: "not-started", reason: "secrets" });
  });

  /* The stderr line is the losable half of a report; the durable record behind it is not. A writer
     that threw used to take that record down with it, leaving the give-up with no trace at all.
     Both callers print before their durable half, so both are pinned here. */
  it("still forwards the durable record when the operator's stderr writer throws", async () => {
    const observed: string[] = [];
    const fallbacks: string[] = [];
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      stderr: () => {
        throw new Error("stderr is closed");
      },
      onUnavailable: (reason) => observed.push(reason),
      recordFallback: async (reason) => {
        fallbacks.push(reason);
      },
    });

    services.reportUnavailable("child-start");
    await services.recordFallback("child-start");

    expect(observed).toEqual(["child-start"]);
    expect(fallbacks).toEqual(["child-start"]);
  });

  /* The cleanup warning is written after the marker, so an inline writer that throws escapes
     startRemote and the run gives up with 75 — losing the finished workload's exit code, the one
     thing the warning says it is preserving. */
  it("keeps the workload exit when retention cleanup and the stderr writer both fail", async () => {
    const processes = {
      async run() {
        throw new Error("the workspace is unreachable after the run");
      },
      async isAlive() {
        return false;
      },
    } as unknown as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      processes,
      streamProcess: async (request: StreamingProcessRequest) => {
        await request.onMarker();
        return { exitCode: 23, signal: null, markerSeen: true, spawned: true };
      },
      stderr: () => {
        throw new Error("stderr is closed");
      },
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths(
        "/home/admin",
        retainedDataAiProfile,
        worktreeIdentity(process.cwd(), "test-client"),
        "test-client",
      ),
      nodeRoot: "/remote/node",
      uvRoot: "/remote/uv",
    });

    const result = await services.startRemote(
      ["./scripts/verify", "--full"],
      { NEON_DEV_DATABASE_URL: "secret-canary" },
      async () => undefined,
    );

    expect(result).toEqual({ kind: "completed", exitCode: 23 });
  });

  it("reaps the Mutagen session of a deleted worktree after a workload, with no retention policy", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const sandbox = await mkdtemp(join(tmpdir(), "remote-runner-sweep-"));
    const barrier = join(sandbox, "barrier");
    await mkdir(join(barrier, "worktree"), { recursive: true });
    const alphaRoots = [await realpath(process.cwd()), join(sandbox, "deleted-worktree"), join(barrier, "worktree")];
    const gone = pathIdentity(alphaRoots[1]!, "test-client");
    const paths = resolveRemotePaths("/home/admin", profile, current, "test-client");
    const listing = JSON.stringify(
      alphaRoots.map((alpha) => {
        const identity = pathIdentity(alpha, "test-client");
        return {
          identifier: `sync_${identity}`,
          name: `remote-runner-${profile.consumer}-${profile.id}-${identity}`,
          alpha: { protocol: "local", path: alpha },
          beta: { url: `${profile.remote.target}:${paths.profileRoot}/${identity}` },
          mode: "one-way-replica",
          ignore: { paths: [] },
          paused: false,
          status: "watching",
        };
      }),
    );
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        const sessionList = request.command === "mutagen" && request.args[1] === "list";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(sessionList ? listing : ""),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      streamProcess: async (request: StreamingProcessRequest) => {
        await request.onMarker();
        return { exitCode: 0, signal: null, markerSeen: true, spawned: true };
      },
    });
    Object.assign(services, {
      remotePaths: paths,
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    try {
      /* An alpha root nobody can look at is the fail-closed case: `access` answers EACCES, not
         ENOENT, and a live worktree behind a temporarily unreadable parent must survive the sweep. */
      await chmod(barrier, 0o000);
      const result = await services.startRemote(["./scripts/verify", "--full"], {}, async () => undefined);

      expect(result).toEqual({ kind: "completed", exitCode: 0 });
      expect(requests.filter(({ command }) => command === "mutagen").map(({ args }) => args)).toEqual([
        ["sync", "list", "--template", "{{ json . }}"],
        ["sync", "terminate", `sync_${gone}`],
      ]);
    } finally {
      await chmod(barrier, 0o700);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("establishes a local worktree root as gone only when its own container answers", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "remote-runner-root-"));
    const barrier = join(sandbox, "barrier");
    await mkdir(join(barrier, "worktree"), { recursive: true });
    await writeFile(join(sandbox, "file-not-worktree"), "");

    try {
      await chmod(barrier, 0o000);

      await expect(localWorktreeExists(sandbox)).resolves.toBe(true);
      await expect(localWorktreeExists(join(sandbox, "deleted"))).resolves.toBe(false);
      /* No worktree can live at a regular file, so the session that syncs it is abandoned too. */
      await expect(localWorktreeExists(join(sandbox, "file-not-worktree"))).resolves.toBe(false);
      await expect(localWorktreeExists(join(sandbox, "file-not-worktree", "under-a-file"))).resolves.toBe(false);
      /* Unreadable container and vanished container: the same ENOENT/EACCES a run would see for a
         worktree on an unmounted volume, and neither establishes a deletion. */
      await expect(localWorktreeExists(join(barrier, "worktree"))).resolves.toBe(true);
      await expect(localWorktreeExists(join(sandbox, "gone-volume", "worktree"))).resolves.toBe(true);
    } finally {
      await chmod(barrier, 0o700);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("sweeps abandoned sessions even when the remote prune fails, and still reports the failure", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const sandbox = await mkdtemp(join(tmpdir(), "remote-runner-both-"));
    const gone = pathIdentity(join(sandbox, "deleted-worktree"), "test-client");
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client");
    const listing = JSON.stringify([
      {
        identifier: `sync_${gone}`,
        name: `remote-runner-${retainedDataAiProfile.consumer}-${retainedDataAiProfile.id}-${gone}`,
        alpha: { protocol: "local", path: join(sandbox, "deleted-worktree") },
        beta: { url: `${retainedDataAiProfile.remote.target}:${paths.profileRoot}/${gone}` },
        mode: "one-way-replica",
        ignore: { paths: [] },
        paused: false,
        status: "watching",
      },
    ]);
    const warnings: Uint8Array[] = [];
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        if (request.command === "mutagen") {
          const sessionList = request.args[1] === "list";
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(sessionList ? listing : ""),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        }
        /* Only the retention prune fails: the post-workload activity marker has to succeed, or the
           cleanup block never reaches either half. */
        const retentionList = JSON.stringify(request.args).includes("remote-runner-retention-list");
        return {
          exitCode: retentionList ? 1 : 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      stderr: (chunk) => warnings.push(chunk),
      streamProcess: async (request: StreamingProcessRequest) => {
        await request.onMarker();
        return { exitCode: 23, signal: null, markerSeen: true, spawned: true };
      },
    });
    Object.assign(services, {
      remotePaths: paths,
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    try {
      const result = await services.startRemote(["./scripts/verify", "--full"], {}, async () => undefined);

      expect(result).toEqual({ kind: "completed", exitCode: 23 });
      expect(requests.filter(({ command }) => command === "mutagen").map(({ args }) => args.at(-1))).toEqual([
        "{{ json . }}",
        `sync_${gone}`,
      ]);
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("preserves the workload exit and emits one bounded warning when cleanup fails", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const warnings: Uint8Array[] = [];
    const processes = {
      async run() {
        return {
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client");
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      stderr: (chunk) => warnings.push(chunk),
      streamProcess: async (request) => {
        await request.onMarker();
        return { exitCode: 23, signal: null, markerSeen: true, spawned: true };
      },
    });
    Object.assign(services, {
      remotePaths: paths,
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    const result = await services.startRemote(
      ["./scripts/verify", "--full"],
      { NEON_DEV_DATABASE_URL: "secret-canary" },
      async () => undefined,
    );

    expect(result).toEqual({ kind: "completed", exitCode: 23 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.byteLength).toBeLessThan(256);
    expect(new TextDecoder().decode(warnings[0])).not.toContain("secret-canary");
  });

  it("refuses to present ssh's own 255 as the workload's exit once the child has started", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const lines: string[] = [];
    const outages: string[] = [];
    const unavailable: string[] = [];
    const processes = {
      async run() {
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      stderr: (chunk) => lines.push(new TextDecoder().decode(chunk)),
      recordFallback: async (reason) => {
        outages.push(reason);
      },
      onUnavailable: (reason) => unavailable.push(reason),
      streamProcess: async (request) => {
        await request.onMarker();
        return { exitCode: 255, signal: null, markerSeen: true, spawned: true };
      },
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    const result = await services.startRemote(["./scripts/verify"], {}, async () => undefined);

    /* `completed` is what withholds the local fallback: the workload already ran remotely, so
       runProfile must never be offered the chance to run it a second time here. */
    expect(result).toEqual({ kind: "completed", exitCode: 75 });
    expect(lines.join("")).toContain("connection dropped mid-run");
    expect(outages).toEqual(["connection-lost"]);
    expect(unavailable).toEqual(["connection-lost"]);
  });

  /* The notification is a side channel; the workload already ran, so nothing it reports may reach
     the caller as a different verdict about that run. */
  it("keeps the mid-run drop's exit code when the outage notification fails", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    const processes = {
      async run() {
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      stderr: () => undefined,
      recordFallback: async () => {
        throw new Error("notification state failed");
      },
      streamProcess: async (request) => {
        await request.onMarker();
        return { exitCode: 255, signal: null, markerSeen: true, spawned: true };
      },
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    await expect(services.startRemote(["./scripts/verify"], {}, async () => undefined)).resolves.toEqual({
      kind: "completed",
      exitCode: 75,
    });
  });

  it.each([
    [255, "connection-lost"],
    [143, "connection-lost"],
    [0, "connection-lost"],
    [75, "account-busy"],
    [69, "workload-command"],
  ])("does not touch activity or run retention when the child marker is absent (exit %i)", async (exitCode, reason) => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    let processCalls = 0;
    const outages: string[] = [];
    const processes = {
      async run() {
        processCalls += 1;
        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client");
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      recordFallback: async (raised) => {
        outages.push(raised);
      },
      streamProcess: async (request) => {
        if (exitCode === 75) {
          request.stderr(new TextEncoder().encode("RR_ACCOUNT_"));
          request.stderr(new TextEncoder().encode("BUSY\n"));
        }
        return { exitCode, signal: null, markerSeen: false, spawned: true };
      },
      stderr: () => undefined,
    });
    Object.assign(services, {
      remotePaths: paths,
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    expect(
      await services.startRemote(
        ["./scripts/verify", "--full"],
        { NEON_DEV_DATABASE_URL: "secret-canary" },
        async () => undefined,
      ),
    ).toEqual({ kind: "not-started", reason });
    expect(processCalls).toBe(0);
    /* A drop BEFORE the marker still belongs to the caller above: it decides between `child-start`
       and `workload-command`, and only one of the two may alert. Raising here would double-report
       the first and invent an outage for the second. */
    expect(outages).toEqual([]);
  });

  it("fingerprints the submodule working-copy checkout in one bounded submodule status call", async () => {
    const workingCopyOid = "b".repeat(40);
    const nestedOid = "c".repeat(40);
    const requests: BoundedProcessRequest[] = [];
    const result = await listLocalGitlinks(
      {
        async run(request) {
          requests.push(request);
          const lines = [
            `+${workingCopyOid} vendor/dev-standards (heads/main)`,
            ` ${nestedOid} packages/nested/submodule`,
          ];
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(`${lines.join("\n")}\n`),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
      },
      "/worktree",
    );

    expect(requests).toEqual([
      {
        command: "git",
        args: ["submodule", "status", "--recursive"],
        cwd: "/worktree",
        maxOutputBytes: 4 * 1024 * 1024,
      },
    ]);
    expect(result).toEqual([
      { oid: workingCopyOid, path: "vendor/dev-standards" },
      { oid: nestedOid, path: "packages/nested/submodule" },
    ]);
  });

  it("fails closed on a malformed submodule status line and returns none for no submodules", async () => {
    const run = (stdout: string) =>
      listLocalGitlinks(
        {
          async run() {
            return {
              exitCode: 0,
              stdout: new TextEncoder().encode(stdout),
              stderr: new Uint8Array(),
              outputTruncated: false,
              spawned: true,
            };
          },
        },
        "/worktree",
      );

    await expect(run("not a submodule status line\n")).rejects.toThrow(/malformed/u);
    await expect(run("")).resolves.toEqual([]);
  });

  it("fails closed on an uninitialized or conflicted submodule status prefix", async () => {
    const run = (stdout: string) =>
      listLocalGitlinks(
        {
          async run() {
            return {
              exitCode: 0,
              stdout: new TextEncoder().encode(stdout),
              stderr: new Uint8Array(),
              outputTruncated: false,
              spawned: true,
            };
          },
        },
        "/worktree",
      );

    await expect(run(`-${"a".repeat(40)} vendor/dev-standards\n`)).rejects.toThrow(/unusable status prefix "-"/u);
    await expect(run(`U${"0".repeat(40)} vendor/dev-standards\n`)).rejects.toThrow(/unusable status prefix "U"/u);
  });

  it("discovers tracked and non-ignored untracked fingerprint files while subtracting deletions", async () => {
    const requests: Array<{ readonly args?: readonly string[]; readonly maxOutputBytes: number }> = [];
    const encoder = new TextEncoder();
    const result = await listLocalFingerprintFiles(
      {
        async run(request) {
          requests.push(request);
          const deleted = request.args?.includes("--deleted") ?? false;
          return {
            exitCode: 0,
            stdout: encoder.encode(
              deleted
                ? "packages/removed/package.json\0"
                : [
                    "packages/new/package.json",
                    "apps/api/package.json",
                    "packages/removed/package.json",
                    "packages/new/package.json",
                    "",
                  ].join("\0"),
            ),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
      },
      "/worktree",
      ["**/package.json", "**/uv.lock"],
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.args).toEqual([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(glob)**/package.json",
      ":(glob)**/uv.lock",
    ]);
    expect(requests[1]?.args).toContain("--deleted");
    expect(requests.map(({ maxOutputBytes }) => maxOutputBytes)).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(result).toEqual(["apps/api/package.json", "packages/new/package.json"]);
  });

  it("fails closed on malformed or truncated fingerprint discovery", async () => {
    const result = (stdout: Uint8Array, outputTruncated = false) => ({
      exitCode: 0,
      stdout,
      stderr: new Uint8Array(),
      outputTruncated,
      spawned: true,
    });
    await expect(
      listLocalFingerprintFiles(
        {
          async run() {
            return result(new Uint8Array([0xff, 0]));
          },
        },
        "/worktree",
        ["**/package.json"],
      ),
    ).rejects.toThrow(/UTF-8/u);
    await expect(
      listLocalFingerprintFiles(
        {
          async run() {
            return result(new Uint8Array(), true);
          },
        },
        "/worktree",
        ["**/package.json"],
      ),
    ).rejects.toThrow(/Git inspection/u);
  });

  it("splits a dispatch into child-start, workload and post-workload spans and counts only ssh", async () => {
    const current = worktreeIdentity(process.cwd(), "test-client");
    let elapsed = 0;
    const telemetry = new RunTelemetry(() => elapsed);
    const requests: BoundedProcessRequest[] = [];
    const processes = {
      async run(request: BoundedProcessRequest) {
        requests.push(request);
        elapsed += 5;
        const serialized = JSON.stringify(request.args);
        const stdout = serialized.includes("remote-runner-retention-list")
          ? `${2_000_000_000}\0d\0${current}\0${1}\0`
          : "";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          outputTruncated: false,
          spawned: true,
        };
      },
      async isAlive() {
        return false;
      },
    } as NodeProcessRuntime;
    const streamRequests: StreamingProcessRequest[] = [];
    /* Only the workload stream advances the fake clock, so the arithmetic below stays readable
       regardless of what this listing quarantines. */
    const streamProcess = async (request: StreamingProcessRequest) => {
      const workload = streamRequests.push(request) === 1;
      if (workload) elapsed += 100;
      await request.onMarker();
      if (workload) elapsed += 1000;
      return { exitCode: 0, signal: null, markerSeen: true, spawned: true };
    };
    const services = new NodeProfileServices(retainedDataAiProfile, {
      clientId: "test-client",
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      processes,
      streamProcess,
      stderr: () => undefined,
      telemetry,
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current, "test-client"),
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    const result = await services.startRemote(["./verify"], { NEON_DEV_DATABASE_URL: "canary" }, async () => undefined);

    expect(result).toEqual({ kind: "completed", exitCode: 0 });
    const { phases, ssh } = telemetry.snapshot();
    expect(phases["child-start"]).toBe(100);
    expect(phases["workload"]).toBe(1000);
    expect(phases["post-activity"]).toBe(5);
    expect(phases["retention"]).toBeGreaterThan(0);
    /* Mutagen shares this process port and the fake clock, so counting it would shift all three ssh
       figures. */
    const sshRequests = requests.filter((request) => request.command === "ssh");
    expect(sshRequests.length).toBeGreaterThan(0);
    expect(sshRequests.length).toBeLessThan(requests.length);
    expect(ssh).toEqual({
      count: sshRequests.length + streamRequests.length,
      totalMs: 5 * sshRequests.length + 1100,
      maxMs: 1100,
    });
  });

  it("moves Mutagen's own flush duration out of the resume span", async () => {
    const telemetry = new RunTelemetry(() => 0);
    const services = new NodeProfileServices(profile, {
      clientId: "test-client",
      home: "/tmp/remote-runner-test-home",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array(),
      telemetry,
    });
    Object.assign(services, {
      pausedSession: {},
      mutagen: {
        async resumeAndFlush() {
          return { session: {}, flushDurationMs: 27 };
        },
      },
    });
    /* What the preparation facade measures around this call: the flush is inside it. */
    telemetry.add("sync-resume", 100);

    await services.resumeAndFlush();

    expect(telemetry.snapshot().phases).toEqual({ "sync-resume": 73, "sync-flush": 27 });
  });
});
