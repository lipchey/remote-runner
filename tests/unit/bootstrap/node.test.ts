import { describe, expect, it } from "vitest";

import {
  installNode,
  localNodeVersion,
  nodeLinuxArchitecture,
  type NodeInstallRuntime,
} from "../../../src/bootstrap/node.js";

class FakeRuntime implements NodeInstallRuntime {
  readonly calls: string[] = [];
  manifest = "";
  digest = "a".repeat(64);

  async createTemporaryDirectory(label: string) {
    this.calls.push(`temp:${label}`);
    return "/tools/.tmp/token";
  }
  async download(url: string, destination: string) {
    this.calls.push(`download:${url}:${destination}`);
  }
  async readText(url: string) {
    this.calls.push(`manifest:${url}`);
    return this.manifest;
  }
  async sha256(path: string) {
    this.calls.push(`sha256:${path}`);
    return this.digest;
  }
  async extract(archive: string, destination: string) {
    this.calls.push(`extract:${archive}:${destination}`);
  }
  async installPackageManager(nodeRoot: string, spec: string) {
    this.calls.push(`package-manager:${nodeRoot}:${spec}`);
  }
  async promote(from: string, to: string) {
    this.calls.push(`promote:${from}:${to}`);
  }
  async cleanup(path: string) {
    this.calls.push(`cleanup:${path}`);
  }
}

describe("native Node bootstrap", () => {
  it("reads the laptop's exact process.versions.node value without range coercion", () => {
    expect(localNodeVersion({ node: "26.5.0" })).toBe("26.5.0");
    expect(() => localNodeVersion({ node: "26" })).toThrow("exact semver");
  });

  it.each([
    ["x86_64", "x64"],
    ["amd64", "x64"],
    ["aarch64", "arm64"],
    ["arm64", "arm64"],
  ])("maps Linux machine %s to official Node architecture %s", (machine, expected) =>
    expect(nodeLinuxArchitecture(machine)).toBe(expected),
  );

  it("verifies the exact official manifest entry before package-manager activation and promotion", async () => {
    const runtime = new FakeRuntime();
    runtime.manifest = `${"a".repeat(64)}  node-v26.5.0-linux-x64.tar.xz\n`;

    const result = await installNode(runtime, {
      version: "26.5.0",
      machine: "x86_64",
      packageManager: "pnpm@11.9.0",
      toolchainRoot: "/tools",
    });

    expect(result).toEqual({
      version: "26.5.0",
      arch: "x64",
      root: "/tools/node-v26.5.0-linux-x64",
      packageManager: "pnpm@11.9.0",
    });
    expect(runtime.calls.findIndex((call) => call.startsWith("sha256:"))).toBeLessThan(
      runtime.calls.findIndex((call) => call.startsWith("extract:")),
    );
    expect(runtime.calls.findIndex((call) => call.startsWith("package-manager:"))).toBeLessThan(
      runtime.calls.findIndex((call) => call.startsWith("promote:")),
    );
    expect(runtime.calls.at(-1)).toBe("cleanup:/tools/.tmp/token");
  });

  it("never extracts or promotes a checksum mismatch and still cleans temporary data", async () => {
    const runtime = new FakeRuntime();
    runtime.manifest = `${"b".repeat(64)}  node-v26.5.0-linux-x64.tar.xz\n`;

    await expect(
      installNode(runtime, {
        version: "26.5.0",
        machine: "x86_64",
        packageManager: "pnpm@11.9.0",
        toolchainRoot: "/tools",
      }),
    ).rejects.toThrow("checksum mismatch");

    expect(runtime.calls.some((call) => call.startsWith("extract:"))).toBe(false);
    expect(runtime.calls.some((call) => call.startsWith("promote:"))).toBe(false);
    expect(runtime.calls.at(-1)).toBe("cleanup:/tools/.tmp/token");
  });

  it.each(["mips64", "", "x86_64\n"])("rejects unsupported or unsafe machine value %j", (machine) => {
    expect(() => nodeLinuxArchitecture(machine)).toThrow();
  });
});
