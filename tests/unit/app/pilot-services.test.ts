import { describe, expect, it } from "vitest";

import {
  NodeProfileServices,
  listLocalFingerprintFiles,
  listLocalGitlinks,
  parseProbeOutput,
  remoteChildArguments,
  remoteWorkspaceCommandArguments,
  resolveRemotePaths,
} from "../../../src/app/pilot-services.js";
import { loadManifestText } from "../../../src/config/load-manifest.js";
import { validManifest } from "../config/manifest-fixture.js";

const profile = loadManifestText(validManifest).profiles[0]!;

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
      'process.stdout.write(process.env.LOCAL_FALLBACK_CANARY ?? "missing")',
    ]);

    expect(exitCode).toBe(0);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("manifest");
  });

  it("resolves every generated target below the canonical remote home", () => {
    const paths = resolveRemotePaths("/home/admin", profile, "0123456789abcdef01234567");

    expect(paths.generatedRoot).toBe("/home/admin/.cache/remote-runner/workspaces");
    expect(paths.workspace).toBe(
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
    );
    expect(Object.values(paths).every((path) => path.startsWith("/home/admin/"))).toBe(true);
    expect(() => resolveRemotePaths("/", profile, "0123456789abcdef01234567")).toThrow();
  });

  it("parses one remote home and byte-capacity record without accepting extra output", () => {
    expect(parseProbeOutput("/home/admin\n12345678901\n", 10_000_000_000)).toEqual({
      home: "/home/admin",
      availableBytes: 12_345_678_901,
    });
    expect(() => parseProbeOutput("/home/admin\n123\nsecret-canary\n", 1)).toThrow();
  });

  it("builds fixed child argv without putting secret values into it", () => {
    const args = remoteChildArguments(
      "/remote/node/bin/node",
      "/remote/launcher.mjs",
      "/remote/workspace",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      profile,
      ["./scripts/verify", "--full"],
    );
    const serialized = JSON.stringify(args);

    expect(args.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    expect(serialized).toContain("NEON_DEV_DATABASE_URL");
    expect(serialized).toContain("REMOTE_RUNNER_CHILD");
    expect(args).toContain("PATH=/remote/node/bin:/remote/uv:/usr/bin:/bin");
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
      'cd -- "$1"; export PATH=$2; export REMOTE_RUNNER_CHILD=1; shift 2; exec "$@"',
      "remote-runner-workspace-command",
      "/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/0123456789abcdef01234567",
      "/remote/node/bin:/remote/uv:/usr/bin:/bin",
      ...command,
    ]);
    expect(args[2]).not.toContain("pnpm-state");
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
            stdout: new TextEncoder().encode(regular + gitlink),
            stderr: new Uint8Array(),
            outputTruncated: false,
          };
        },
      },
      "/worktree",
    );

    expect(requests.map(({ maxOutputBytes }) => maxOutputBytes)).toEqual([4 * 1024 * 1024]);
    expect(result).toEqual([{ oid: "b".repeat(40), path: "packages/submodule" }]);
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
