import { describe, expect, it } from "vitest";

import {
  PREPARATION_STEPS,
  PreparationError,
  RetryablePreparationError,
  prepareRemote,
  type PreparationRuntime,
} from "../../../src/run/prepare.js";

class FakePreparation implements PreparationRuntime {
  readonly calls: string[] = [];
  failAt?: string;
  retryable = false;
  async validate() {
    return this.step("validate");
  }
  async acquireLock() {
    this.step("lock");
    return async () => {
      this.calls.push("release");
    };
  }
  async probe() {
    return this.step("probe");
  }
  async pauseSync() {
    return this.step("sync-pause");
  }
  async reconcileWorkspace() {
    return this.step("git-workspace");
  }
  async resumeAndFlush() {
    return this.step("sync-resume-flush");
  }
  async bootstrap() {
    return this.step("bootstrap");
  }
  async collectSecrets() {
    this.step("secrets");
    return { SECRET: "canary" };
  }
  private step(name: string) {
    this.calls.push(name);
    if (this.failAt === name) {
      if (this.retryable) throw new RetryablePreparationError(`${name} unavailable`);
      throw new Error(`${name} failed`);
    }
  }
}

describe("remote preparation", () => {
  it("declares the exact preparation and child boundary order", () => {
    expect(PREPARATION_STEPS).toEqual([
      "validate",
      "lock",
      "probe",
      "sync-pause",
      "git-workspace",
      "sync-resume-flush",
      "bootstrap",
      "secrets",
      "child-start",
    ]);
  });

  it("prepares in order and returns an idempotent lock release for the child marker", async () => {
    const runtime = new FakePreparation();
    const result = await prepareRemote(runtime);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.secrets).toEqual({ SECRET: "canary" });
    expect(runtime.calls).toEqual(PREPARATION_STEPS.slice(0, -1));
    await result.release();
    await result.release();
    expect(runtime.calls.filter((call) => call === "release")).toHaveLength(1);
  });

  it.each([
    ["validate", "validation", false],
    ["lock", "lock", false],
    ["probe", "transport", true],
    ["sync-pause", "sync", false],
    ["git-workspace", "workspace", false],
    ["sync-resume-flush", "sync", false],
    ["bootstrap", "bootstrap", false],
    ["secrets", "secrets", false],
  ])("classifies %s failure as %s and releases an acquired lock", async (step, reason, retryable) => {
    const runtime = new FakePreparation();
    runtime.failAt = step;
    runtime.retryable = retryable;
    const result = await prepareRemote(runtime);
    expect(result).toEqual({ ok: false, reason, retryable });
    expect(runtime.calls.includes("release")).toBe(runtime.calls.includes("lock") && step !== "lock");
  });

  it("preserves an explicit stable capacity reason from the probe boundary", async () => {
    const runtime = new FakePreparation();
    runtime.probe = async () => {
      runtime.calls.push("probe");
      throw new PreparationError("capacity", false);
    };

    expect(await prepareRemote(runtime)).toEqual({ ok: false, reason: "capacity", retryable: false });
    expect(runtime.calls).toEqual(["validate", "lock", "probe", "release"]);
  });

  it("preserves an explicit stable SSH authentication reason", async () => {
    const runtime = new FakePreparation();
    runtime.probe = async () => {
      throw new PreparationError("authentication", false);
    };
    expect(await prepareRemote(runtime)).toEqual({
      ok: false,
      reason: "authentication",
      retryable: false,
    });
  });
});
