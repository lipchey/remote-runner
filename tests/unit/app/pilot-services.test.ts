import { describe, expect, it } from "vitest";

import {
  listLocalGitlinks,
  parseProbeOutput,
  remoteChildArguments,
  resolveRemotePaths,
} from "../../../src/app/pilot-services.js";
import { loadManifestText } from "../../../src/config/load-manifest.js";
import { validManifest } from "../config/manifest-fixture.js";

const profile = loadManifestText(validManifest).profiles[0]!;

describe("pilot service boundaries", () => {
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
      profile,
      ["./scripts/verify", "--full"],
    );
    const serialized = JSON.stringify(args);

    expect(args.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    expect(serialized).toContain("NEON_DEV_DATABASE_URL");
    expect(serialized).toContain("REMOTE_RUNNER_CHILD");
    expect(serialized).not.toContain("secret-canary");
    expect(serialized).not.toContain("postgres://");
  });

  it("bounds a large local index separately while retaining only gitlinks", async () => {
    const regular = `100644 ${"a".repeat(40)} 0\tfile\n`.repeat(1_200);
    const gitlink = `160000 ${"b".repeat(40)} 0\tpackages/submodule\n`;
    const requests: Array<{ readonly maxOutputBytes: number }> = [];
    const result = await listLocalGitlinks({
      async run(request) {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(regular + gitlink),
          stderr: new Uint8Array(),
          outputTruncated: false,
        };
      },
    }, "/worktree");

    expect(requests.map(({ maxOutputBytes }) => maxOutputBytes)).toEqual([4 * 1024 * 1024]);
    expect(result).toEqual([{ oid: "b".repeat(40), path: "packages/submodule" }]);
  });
});
