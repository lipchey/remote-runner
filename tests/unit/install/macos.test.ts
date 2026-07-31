import { describe, expect, it } from "vitest";

import { OWNED_MAC_PATHS, installMac, uninstallMac, type MacInstallRuntime } from "../../../src/install/macos.js";

type Status = "missing" | "compatible" | "owned-stale" | "foreign";

class FakeRuntime implements MacInstallRuntime {
  readonly calls: string[] = [];
  statuses = new Map<string, Status>();
  launch = { loaded: false, running: false };
  uid = 501;
  async currentUid() { return this.uid; }
  async inspectArtifact(path: string) { this.calls.push(`inspect:${path}`); return this.statuses.get(path) ?? "missing"; }
  async writeOwned(path: string, _contents: Uint8Array, mode: number) { this.calls.push(`write:${path}:${mode.toString(8)}`); this.statuses.set(path, "compatible"); }
  async launchStatus() { this.calls.push("launch-status"); return this.launch; }
  async bootstrap(domain: string, path: string) { this.calls.push(`bootstrap:${domain}:${path}`); this.launch = { loaded: true, running: true }; }
  async bootout(domain: string, label: string) { this.calls.push(`bootout:${domain}:${label}`); this.launch = { loaded: false, running: false }; }
  async kickstart(domain: string, label: string) { this.calls.push(`kickstart:${domain}:${label}`); this.launch.running = true; }
  async removeOwned(path: string) { this.calls.push(`remove:${path}`); this.statuses.set(path, "missing"); }
}

const options = {
  executable: new TextEncoder().encode("remote-runner-v1"),
  plistTemplate: "<plist>{{EXECUTABLE}}</plist>",
  executablePath: "/Users/admin/.local/bin/remote-runner",
};

describe("macOS lifecycle install", () => {
  it("uses a small explicit ownership allowlist", () => {
    expect(OWNED_MAC_PATHS).toEqual([
      "~/.local/bin/remote-runner",
      "~/Library/LaunchAgents/com.lipchey.remote-runner.plist",
      "~/.local/state/remote-runner",
      "~/.cache/remote-runner",
    ]);
  });

  it("installs owned executable/plist and bootstraps idempotently", async () => {
    const runtime = new FakeRuntime();
    await installMac(runtime, options);
    await installMac(runtime, options);
    expect(runtime.calls.filter((call) => call.startsWith("write:"))).toEqual([
      "write:~/.local/bin/remote-runner:755",
      "write:~/Library/LaunchAgents/com.lipchey.remote-runner.plist:600",
    ]);
    expect(runtime.calls.filter((call) => call.startsWith("bootstrap:"))).toHaveLength(1);
  });

  it("bootouts before atomically replacing an owned stale plist", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses.set("~/.local/bin/remote-runner", "compatible");
    runtime.statuses.set("~/Library/LaunchAgents/com.lipchey.remote-runner.plist", "owned-stale");
    runtime.launch = { loaded: true, running: true };
    await installMac(runtime, options);
    expect(runtime.calls.indexOf("bootout:gui/501:com.lipchey.remote-runner")).toBeLessThan(
      runtime.calls.indexOf("write:~/Library/LaunchAgents/com.lipchey.remote-runner.plist:600"),
    );
    expect(runtime.calls.some((call) => call.startsWith("bootstrap:"))).toBe(true);
  });

  it("restarts a running controller when only the owned executable is upgraded", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses.set("~/.local/bin/remote-runner", "owned-stale");
    runtime.statuses.set("~/Library/LaunchAgents/com.lipchey.remote-runner.plist", "compatible");
    runtime.launch = { loaded: true, running: true };
    await installMac(runtime, options);
    expect(runtime.calls).toContain("bootout:gui/501:com.lipchey.remote-runner");
    expect(runtime.calls).toContain("write:~/.local/bin/remote-runner:755");
    expect(runtime.calls.some((call) => call.startsWith("bootstrap:"))).toBe(true);
  });

  it("refuses to overwrite or uninstall a foreign owned-path candidate", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses.set("~/.local/bin/remote-runner", "foreign");
    await expect(installMac(runtime, options)).rejects.toThrow("foreign");
    expect(runtime.calls.some((call) => call.startsWith("write:"))).toBe(false);
    await expect(uninstallMac(runtime)).rejects.toThrow("foreign");
    expect(runtime.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("uninstalls only exact preflighted owned paths and leaves siblings untouched", async () => {
    const runtime = new FakeRuntime();
    for (const path of OWNED_MAC_PATHS) runtime.statuses.set(path, "owned-stale");
    runtime.statuses.set("~/.local/bin/remote-runner-user", "foreign");
    runtime.launch = { loaded: true, running: true };
    await uninstallMac(runtime);
    expect(runtime.calls.filter((call) => call.startsWith("remove:")).map((call) => call.slice(7))).toEqual([...OWNED_MAC_PATHS].reverse());
    expect(runtime.calls.join("\n")).not.toContain("remote-runner-user");
  });
});
