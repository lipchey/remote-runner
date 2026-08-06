import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NodeProfileServices,
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
import type { NodeProcessRuntime, StreamingProcessRequest } from "../../../src/node/process.js";
import { pathIdentity, worktreeIdentity } from "../../../src/runtime/identity.js";
import type { BoundedProcessRequest } from "../../../src/ssh/client.js";
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

describe("pilot service boundaries", () => {
  it("applies the manifest child environment to a local workload", async () => {
    const chunks: Uint8Array[] = [];
    const services = new NodeProfileServices(
      {
        ...profile,
        workload: {
          ...profile.workload,
          childEnvironment: {
            ...profile.workload.childEnvironment,
            LOCAL_FALLBACK_CANARY: "manifest",
          },
        },
      },
      {
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

  it("notifies onLocalExecution before running a local workload", async () => {
    let notified = false;
    const services = new NodeProfileServices(profile, {
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
    const paths = resolveRemotePaths("/home/admin", profile, "0123456789abcdef01234567");

    expect(paths.generatedRoot).toBe("/home/admin/.cache/remote-runner/workspaces");
    expect(paths.workspace).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
    );
    expect(paths.workloadLock).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/.locks/0123456789abcdef01234567",
    );
    expect(paths.activityMarker).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/.activity/0123456789abcdef01234567",
    );
    expect(Object.values(paths).every((path) => path.startsWith("/home/admin/"))).toBe(true);
    expect(() => resolveRemotePaths("/", profile, "0123456789abcdef01234567")).toThrow();
  });

  it("preserves a canonical absolute generated root outside the remote home", () => {
    const paths = resolveRemotePaths("/home/admin", dataAiProfile, "0123456789abcdef01234567");

    expect(paths.generatedRoot).toBe("/mnt/DataAI/home/admin/.cache/remote-runner/workspaces");
    expect(paths.workspace).toBe(
      "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
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
    const current = worktreeIdentity(process.cwd());
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
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current) });

    await services.pauseSync();

    expect(requests[0]?.command).toBe("ssh");
    expect(JSON.stringify(requests[0]?.args)).toContain("remote-runner-touch-activity");
    expect(JSON.stringify(requests[0]?.args)).toContain("flock -w 60 9 || exit 75");
    expect(JSON.stringify(requests[0]?.args)).toContain(`${current}`);
    expect(requests.slice(1).map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
      "daemon start",
      "sync list",
      "sync create",
    ]);
  });

  it("offers a busy workload lock for another attempt instead of failing the preparation", async () => {
    const current = worktreeIdentity(process.cwd());
    const processes = {
      async run() {
        return {
          exitCode: 75,
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
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current) });

    await expect(services.pauseSync()).rejects.toMatchObject({ reason: "lock", retryable: true });
  });

  it("gives dependency setup a capture bound that a package install fits into", async () => {
    const current = worktreeIdentity(process.cwd());
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
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
    });
    Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current) });

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
      const current = worktreeIdentity(process.cwd());
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
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
        recordFallback: async (reason) => {
          outages.push(reason);
        },
      });
      Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current) });

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
      const current = worktreeIdentity(process.cwd());
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
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
      });
      Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current) });

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
      const current = worktreeIdentity(process.cwd());
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
        home: "/Users/admin",
        sourceRoot: process.cwd(),
        launcherSource: new Uint8Array([1]),
        processes,
      });
      Object.assign(services, { remotePaths: resolveRemotePaths("/home/admin", ensureProfile, current) });

      const caught = await services.bootstrap().catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toMatchObject({ reason: "consumer-setup" });
    },
  );

  it("keeps a busy lock off the outage channel while still telling the operator", async () => {
    const lines: string[] = [];
    let recorded: string | undefined;
    const services = new NodeProfileServices(profile, {
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
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      command,
    );

    expect(args).toEqual([
      "sh",
      "-ceu",
      'cd -- "$1" || exit 125; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
      "remote-runner-workspace-command",
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      ...command,
    ]);
    expect(args[2]).not.toContain("pnpm-state");
  });

  it("builds fixed artifact-check argv without shell-interpolating the path", () => {
    const artifact = "vendor/dev-standards/runner/dist/verify-runner.mjs";
    const args = remoteArtifactCheckArguments(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      artifact,
    );

    expect(args).toEqual([
      "sh",
      "-ceu",
      'cd -- "$1" || exit 125; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
      "remote-runner-workspace-command",
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      "test",
      "-f",
      artifact,
    ]);
    expect(args[2]).not.toContain(artifact);
  });

  it("touches activity and prunes after a marker-seen nonzero workload without changing its exit", async () => {
    const current = worktreeIdentity(process.cwd());
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
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current);
    const services = new NodeProfileServices(retainedDataAiProfile, {
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
    expect(serializedRequests.some((value) => value.includes("remote-runner-retention-list"))).toBe(true);
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
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      knownHostsPath: "/Users/admin/.local/state/remote-runner/known_hosts/managed",
      launcherSource: new Uint8Array([1]),
      streamProcess: async () => {
        throw new Error("the frame must fail before anything is spawned");
      },
    });
    Object.assign(services, {
      remotePaths: resolveRemotePaths("/home/admin", manySecrets, worktreeIdentity(process.cwd())),
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
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, worktreeIdentity(process.cwd())),
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
    const current = worktreeIdentity(process.cwd());
    const sandbox = await mkdtemp(join(tmpdir(), "remote-runner-sweep-"));
    const barrier = join(sandbox, "barrier");
    await mkdir(join(barrier, "worktree"), { recursive: true });
    const alphaRoots = [await realpath(process.cwd()), join(sandbox, "deleted-worktree"), join(barrier, "worktree")];
    const gone = pathIdentity(alphaRoots[1]!);
    const paths = resolveRemotePaths("/home/admin", profile, current);
    const listing = JSON.stringify(
      alphaRoots.map((alpha) => {
        const identity = pathIdentity(alpha);
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
    const current = worktreeIdentity(process.cwd());
    const sandbox = await mkdtemp(join(tmpdir(), "remote-runner-both-"));
    const gone = pathIdentity(join(sandbox, "deleted-worktree"));
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current);
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
    const current = worktreeIdentity(process.cwd());
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
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current);
    const services = new NodeProfileServices(retainedDataAiProfile, {
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
    const current = worktreeIdentity(process.cwd());
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
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current),
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
    const current = worktreeIdentity(process.cwd());
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
      remotePaths: resolveRemotePaths("/home/admin", retainedDataAiProfile, current),
      nodeRoot: "/home/admin/.local/share/remote-runner/toolchains/node/current",
      uvRoot: "/home/admin/.local/share/remote-runner/toolchains/uv/current",
    });

    await expect(services.startRemote(["./scripts/verify"], {}, async () => undefined)).resolves.toEqual({
      kind: "completed",
      exitCode: 75,
    });
  });

  it.each([
    [255, "child-start"],
    [69, "workload-command"],
  ])("does not touch activity or run retention when the child marker is absent (exit %i)", async (exitCode, reason) => {
    const current = worktreeIdentity(process.cwd());
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
    const paths = resolveRemotePaths("/home/admin", retainedDataAiProfile, current);
    const services = new NodeProfileServices(retainedDataAiProfile, {
      home: "/Users/admin",
      sourceRoot: process.cwd(),
      launcherSource: new Uint8Array([1]),
      processes,
      recordFallback: async (raised) => {
        outages.push(raised);
      },
      streamProcess: async () => ({ exitCode, signal: null, markerSeen: false, spawned: true }),
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
});
