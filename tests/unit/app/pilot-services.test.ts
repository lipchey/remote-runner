import { describe, expect, it } from "vitest";

import {
  NodeProfileServices,
  listLocalFingerprintFiles,
  listLocalGitlinks,
  parseProbeOutput,
  remoteArtifactCheckArguments,
  remoteChildArguments,
  remoteWorkspaceCommandArguments,
  resolveRemotePaths,
} from "../../../src/app/pilot-services.js";
import { loadManifestText } from "../../../src/config/load-manifest.js";
import type { NodeProcessRuntime, StreamingProcessRequest } from "../../../src/node/process.js";
import { worktreeIdentity } from "../../../src/runtime/identity.js";
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
    expect(JSON.stringify(requests[0]?.args)).toContain("flock -x 9");
    expect(JSON.stringify(requests[0]?.args)).toContain(`${current}`);
    expect(requests.slice(1).map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
      "daemon start",
      "sync list",
      "sync create",
    ]);
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
      'cd -- "$1"; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
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
      'cd -- "$1"; export PATH=$2; export REMOTE_RUNNER_CHILD=1; export REMOTE_RUNNER_PROVIDER=remote; shift 2; exec "$@"',
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
          ? `d\0${current}\0${2_000_000_000}\0d\0${stale}\0${1}\0`
          : "";
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
          outputTruncated: false,
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

  it("preserves the workload exit and emits one bounded warning when cleanup fails", async () => {
    const current = worktreeIdentity(process.cwd());
    const warnings: Uint8Array[] = [];
    const processes = {
      async run() {
        return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array(), outputTruncated: false };
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

  it("does not touch activity or run retention when the child marker is absent", async () => {
    const current = worktreeIdentity(process.cwd());
    let processCalls = 0;
    const processes = {
      async run() {
        processCalls += 1;
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), outputTruncated: false };
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
      streamProcess: async () => ({ exitCode: 255, signal: null, markerSeen: false, spawned: true }),
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
    ).toEqual({ kind: "not-started", reason: "child-start" });
    expect(processCalls).toBe(0);
  });

  it("bounds a large local index separately while retaining only gitlinks", async () => {
    const regular = `100644 ${"a".repeat(40)} 0\tfile\n`.repeat(1_200);
    const gitlink = `160000 ${"b".repeat(40)} 0\tpackages/submodule\n`;
    const requests: Array<{ readonly maxOutputBytes: number }> = [];
    const result = await listLocalGitlinks(
      {
        async run(request) {
          requests.push(request);
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(
              request.args[0] === "ls-files" ? regular + gitlink : `${"b".repeat(40)}\n`,
            ),
            stderr: new Uint8Array(),
            outputTruncated: false,
          };
        },
      },
      "/worktree",
    );

    expect(requests.map(({ maxOutputBytes }) => maxOutputBytes)).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(result).toEqual([{ oid: "b".repeat(40), path: "packages/submodule" }]);
  });

  it("fingerprints a gitlink from the superproject HEAD instead of the staged index", async () => {
    const indexedOid = "a".repeat(40);
    const headOid = "b".repeat(40);
    const requests: Array<{ readonly args: readonly string[]; readonly cwd: string | undefined }> = [];
    const result = await listLocalGitlinks(
      {
        async run(request) {
          requests.push({ args: request.args, cwd: request.cwd });
          const listing = request.args[0] === "ls-files";
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(
              listing ? `160000 ${indexedOid} 0\tvendor/dev-standards\n` : `${headOid}\n`,
            ),
            stderr: new Uint8Array(),
            outputTruncated: false,
          };
        },
      },
      "/worktree",
    );

    expect(result).toEqual([{ oid: headOid, path: "vendor/dev-standards" }]);
    expect(requests).toEqual([
      { args: ["ls-files", "--stage"], cwd: "/worktree" },
      { args: ["rev-parse", "HEAD:vendor/dev-standards"], cwd: "/worktree" },
    ]);
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
