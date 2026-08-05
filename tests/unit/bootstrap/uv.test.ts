import { describe, expect, it } from "vitest";

import { installUv, uvLinuxTarget, type UvInstallRuntime } from "../../../src/bootstrap/uv.js";

class FakeRuntime implements UvInstallRuntime {
  readonly calls: string[] = [];
  digest = "c".repeat(64);
  present = false;
  async installed(path: string) {
    this.calls.push(`installed:${path}`);
    return this.present;
  }
  async createTemporaryDirectory(label: string) {
    this.calls.push(`temp:${label}`);
    return "/tools/.tmp/uv";
  }
  async download(url: string, destination: string) {
    this.calls.push(`download:${url}:${destination}`);
  }
  async sha256(path: string) {
    this.calls.push(`sha256:${path}`);
    return this.digest;
  }
  async extract(archive: string, destination: string) {
    this.calls.push(`extract:${archive}:${destination}`);
  }
  async promote(from: string, to: string) {
    this.calls.push(`promote:${from}:${to}`);
  }
  async cleanup(path: string) {
    this.calls.push(`cleanup:${path}`);
  }
}

describe("uv bootstrap", () => {
  it.each([
    ["x86_64", "x86_64-unknown-linux-gnu"],
    ["aarch64", "aarch64-unknown-linux-gnu"],
  ])("maps %s to %s", (machine, target) => expect(uvLinuxTarget(machine)).toBe(target));

  it("requires the pinned checksum before atomic promotion", async () => {
    const runtime = new FakeRuntime();
    const result = await installUv(runtime, {
      version: "0.11.32",
      machine: "x86_64",
      sha256: "c".repeat(64),
      toolchainRoot: "/tools",
    });
    expect(result).toEqual({
      version: "0.11.32",
      target: "x86_64-unknown-linux-gnu",
      root: "/tools/uv-0.11.32-x86_64-unknown-linux-gnu",
    });
    expect(runtime.calls.some((call) => call.startsWith("promote:"))).toBe(true);
    expect(runtime.calls.at(-1)).toBe("cleanup:/tools/.tmp/uv");
  });

  it("reuses an already promoted install instead of downloading it again", async () => {
    const runtime = new FakeRuntime();
    runtime.present = true;

    const result = await installUv(runtime, {
      version: "0.11.32",
      machine: "x86_64",
      sha256: "c".repeat(64),
      toolchainRoot: "/tools",
    });

    expect(result.root).toBe("/tools/uv-0.11.32-x86_64-unknown-linux-gnu");
    expect(runtime.calls).toEqual(["installed:/tools/uv-0.11.32-x86_64-unknown-linux-gnu/uv"]);
  });

  it("does not extract or promote a mismatched archive", async () => {
    const runtime = new FakeRuntime();
    await expect(
      installUv(runtime, {
        version: "0.11.32",
        machine: "x86_64",
        sha256: "d".repeat(64),
        toolchainRoot: "/tools",
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(runtime.calls.some((call) => call.startsWith("extract:") || call.startsWith("promote:"))).toBe(false);
  });
});
