import { describe, expect, it } from "vitest";

import { RemoteToolchainRuntime, type RemoteCommandPort } from "../../../src/node/remote-toolchain.js";

class FakeRemote implements RemoteCommandPort {
  readonly calls: readonly string[][] = [] as string[][];
  outputs: string[] = [];
  async run(args: readonly string[]) {
    (this.calls as string[][]).push([...args]);
    return { exitCode: 0, stdout: new TextEncoder().encode(this.outputs.shift() ?? ""), stderr: new Uint8Array() };
  }
}

describe("RemoteToolchainRuntime", () => {
  it("creates and accepts only a confined remote temporary directory", async () => {
    const remote = new FakeRemote();
    remote.outputs = ["/home/admin/.local/share/remote-runner/toolchains/.tmp/node-26.5.0.abc123\n"];
    const runtime = new RemoteToolchainRuntime(remote, "/home/admin/.local/share/remote-runner/toolchains");

    await expect(runtime.createTemporaryDirectory("node-26.5.0")).resolves.toBe(
      "/home/admin/.local/share/remote-runner/toolchains/.tmp/node-26.5.0.abc123",
    );
    expect(remote.calls[0]?.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);

    remote.outputs = ["/tmp/escaped\n"];
    await expect(runtime.createTemporaryDirectory("uv-0.11.30")).rejects.toThrow("escaped");
  });

  it("uses fixed argv commands for download, digest, extraction, and cleanup", async () => {
    const remote = new FakeRemote();
    remote.outputs = ["", "a".repeat(64) + "\n"];
    const root = "/home/admin/.local/share/remote-runner/toolchains";
    const temporary = `${root}/.tmp/node.abc`;
    const runtime = new RemoteToolchainRuntime(remote, root);

    await runtime.download("https://example.test/archive.tar.xz", `${temporary}/archive.tar.xz`);
    expect(await runtime.sha256(`${temporary}/archive.tar.xz`)).toBe("a".repeat(64));
    await runtime.extract(`${temporary}/archive.tar.xz`, `${temporary}/extract`);
    await runtime.cleanup(temporary);

    expect(remote.calls).toContainEqual([
      "curl", "--fail", "--location", "--silent", "--show-error", "--output",
      `${temporary}/archive.tar.xz`, "https://example.test/archive.tar.xz",
    ]);
    expect(remote.calls).toContainEqual(["sha256sum", "--", `${temporary}/archive.tar.xz`]);
    expect(remote.calls).toContainEqual(["tar", "-xf", `${temporary}/archive.tar.xz`, "-C", `${temporary}/extract`]);
    expect(remote.calls.at(-1)).toEqual(["rm", "-rf", "--", temporary]);
  });

  it("refuses destructive cleanup or promotion outside the toolchain root", async () => {
    const remote = new FakeRemote();
    const root = "/home/admin/.local/share/remote-runner/toolchains";
    const runtime = new RemoteToolchainRuntime(remote, root);

    await expect(runtime.cleanup("/home/admin")).rejects.toThrow("temporary");
    await expect(runtime.promote(`${root}/.tmp/staged`, "/home/admin/other")).rejects.toThrow("target");
    expect(remote.calls).toHaveLength(0);
  });
});
