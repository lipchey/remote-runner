import { describe, expect, it } from "vitest";

import { gitleaksLinuxArchitecture, installGitleaks, type GitleaksInstallRuntime } from "../../../src/bootstrap/gitleaks.js";

class FakeRuntime implements GitleaksInstallRuntime {
  readonly calls: string[] = [];
  digest = "e".repeat(64);
  async createTemporaryDirectory(label: string) { this.calls.push(`temp:${label}`); return "/tools/.tmp/gitleaks"; }
  async download(url: string, destination: string) { this.calls.push(`download:${url}:${destination}`); }
  async sha256(path: string) { this.calls.push(`sha256:${path}`); return this.digest; }
  async extract(archive: string, destination: string) { this.calls.push(`extract:${archive}:${destination}`); }
  async promote(from: string, to: string) { this.calls.push(`promote:${from}:${to}`); }
  async cleanup(path: string) { this.calls.push(`cleanup:${path}`); }
}

describe("gitleaks bootstrap", () => {
  it.each([["x86_64", "x64"], ["aarch64", "arm64"]])(
    "maps %s to %s", (machine, arch) => expect(gitleaksLinuxArchitecture(machine)).toBe(arch),
  );

  it("pins checksum and promotes only the verified extracted directory", async () => {
    const runtime = new FakeRuntime();
    const result = await installGitleaks(runtime, {
      version: "8.30.1", machine: "aarch64", sha256: "e".repeat(64), toolchainRoot: "/tools",
    });
    expect(result).toEqual({ version: "8.30.1", arch: "arm64", root: "/tools/gitleaks-8.30.1-linux-arm64" });
    expect(runtime.calls.findIndex((call) => call.startsWith("sha256:"))).toBeLessThan(
      runtime.calls.findIndex((call) => call.startsWith("extract:")),
    );
  });

  it("cleans but never promotes after an interrupted download", async () => {
    const runtime = new FakeRuntime();
    runtime.download = async () => { throw new Error("download interrupted"); };
    await expect(installGitleaks(runtime, {
      version: "8.30.1", machine: "x86_64", sha256: "e".repeat(64), toolchainRoot: "/tools",
    })).rejects.toThrow("download interrupted");
    expect(runtime.calls.some((call) => call.startsWith("promote:"))).toBe(false);
    expect(runtime.calls.at(-1)).toBe("cleanup:/tools/.tmp/gitleaks");
  });
});
