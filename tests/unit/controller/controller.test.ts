import { describe, expect, it } from "vitest";

import { ensureController, runControllerPass, type ControllerRuntime } from "../../../src/controller/controller.js";

class FakeRuntime implements ControllerRuntime {
  readonly actions: string[] = [];
  statuses: Array<{ loaded: boolean; running: boolean; compatible: boolean }> = [];
  profiles = ["alpha", "beta"];
  async inspect() {
    this.actions.push("inspect");
    return this.statuses.shift() ?? { loaded: true, running: true, compatible: true };
  }
  async bootstrap() {
    this.actions.push("bootstrap");
  }
  async bootout() {
    this.actions.push("bootout");
  }
  async kickstart() {
    this.actions.push("kickstart");
  }
  async registeredProfiles() {
    this.actions.push("profiles");
    return this.profiles;
  }
  async reconcile(profile: string) {
    this.actions.push(`reconcile:${profile}`);
    return profile === "alpha" ? { healthy: true } : { healthy: false, reason: "transport" };
  }
  async recordHealth(profile: string, health: { healthy: boolean; reason?: string }) {
    this.actions.push(`health:${profile}:${health.healthy}:${health.reason ?? "ok"}`);
  }
}

describe("controller self-healing", () => {
  it("is a no-op for a running compatible controller", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses = [{ loaded: true, running: true, compatible: true }];
    await ensureController(runtime);
    expect(runtime.actions).toEqual(["inspect"]);
  });

  it("bootstraps an unloaded controller and verifies the result", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses = [
      { loaded: false, running: false, compatible: true },
      { loaded: true, running: true, compatible: true },
    ];
    await ensureController(runtime);
    expect(runtime.actions).toEqual(["inspect", "bootstrap", "inspect"]);
  });

  it("kickstarts a loaded stopped controller", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses = [
      { loaded: true, running: false, compatible: true },
      { loaded: true, running: true, compatible: true },
    ];
    await ensureController(runtime);
    expect(runtime.actions).toEqual(["inspect", "kickstart", "inspect"]);
  });

  it("replaces an incompatible controller through bootout/bootstrap", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses = [
      { loaded: true, running: true, compatible: false },
      { loaded: true, running: true, compatible: true },
    ];
    await ensureController(runtime);
    expect(runtime.actions).toEqual(["inspect", "bootout", "bootstrap", "inspect"]);
  });

  it("fails closed if repair does not produce a running compatible controller", async () => {
    const runtime = new FakeRuntime();
    runtime.statuses = [
      { loaded: false, running: false, compatible: true },
      { loaded: true, running: false, compatible: true },
    ];
    await expect(ensureController(runtime)).rejects.toThrow("unhealthy");
  });

  it("controller pass reconciles registered sessions and records bounded health without workloads", async () => {
    const runtime = new FakeRuntime();
    await runControllerPass(runtime);
    expect(runtime.actions).toEqual([
      "profiles",
      "reconcile:alpha",
      "health:alpha:true:ok",
      "reconcile:beta",
      "health:beta:false:transport",
    ]);
  });
});
