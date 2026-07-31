import { describe, expect, it } from "vitest";

import { installMutagen, mutagenDarwinArchitecture, type MutagenInstallRuntime } from "../../../src/install/mutagen.js";

class FakeRuntime implements MutagenInstallRuntime {
  readonly calls: string[] = [];
  digest = "a".repeat(64);
  manifest = "";
  async createTemporaryDirectory(label: string) { this.calls.push(`temp:${label}`); return "/share/.tmp/mutagen"; }
  async readText(url: string) { this.calls.push(`manifest:${url}`); return this.manifest; }
  async download(url: string, path: string) { this.calls.push(`download:${url}:${path}`); }
  async sha256(path: string) { this.calls.push(`sha256:${path}`); return this.digest; }
  async extract(archive: string, destination: string) { this.calls.push(`extract:${archive}:${destination}`); }
  async promote(from: string, to: string) { this.calls.push(`promote:${from}:${to}`); }
  async cleanup(path: string) { this.calls.push(`cleanup:${path}`); }
}

describe("Mutagen installer", () => {
  it.each([["x86_64", "amd64"], ["arm64", "arm64"]])("maps %s to %s", (machine, arch) => {
    expect(mutagenDarwinArchitecture(machine)).toBe(arch);
  });

  it("verifies the exact official archive before atomic promotion", async () => {
    const runtime = new FakeRuntime();
    runtime.manifest = `${"a".repeat(64)}  mutagen_darwin_arm64_v0.18.1.tar.gz\n`;
    await expect(installMutagen(runtime, { version: "0.18.1", machine: "arm64", installRoot: "/share" }))
      .resolves.toEqual({ version: "0.18.1", arch: "arm64", root: "/share/mutagen-v0.18.1-darwin-arm64" });
    expect(runtime.calls.findIndex((call) => call.startsWith("sha256:"))).toBeLessThan(runtime.calls.findIndex((call) => call.startsWith("extract:")));
    expect(runtime.calls.at(-1)).toBe("cleanup:/share/.tmp/mutagen");
  });

  it("rejects checksum mismatch without extraction or promotion", async () => {
    const runtime = new FakeRuntime();
    runtime.manifest = `${"b".repeat(64)}  mutagen_darwin_amd64_v0.18.1.tar.gz\n`;
    await expect(installMutagen(runtime, { version: "0.18.1", machine: "x86_64", installRoot: "/share" })).rejects.toThrow("checksum mismatch");
    expect(runtime.calls.some((call) => call.startsWith("extract:") || call.startsWith("promote:"))).toBe(false);
  });
});
