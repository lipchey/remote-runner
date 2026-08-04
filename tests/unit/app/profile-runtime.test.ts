import { describe, expect, it } from "vitest";

import { createProfileRuntime, type ProfileExecutionServices } from "../../../src/app/profile-runtime.js";
import { DiagnosableError } from "../../../src/runtime/diagnostic.js";
import { WORKLOAD_COMMAND_REASON, runProfile } from "../../../src/run/run-profile.js";

class FakeServices implements ProfileExecutionServices {
  readonly calls: string[] = [];
  failProbe = false;
  remoteExit = 0;
  notStartedReason?: string;
  async validate() {
    this.calls.push("validate");
  }
  async acquireLock() {
    this.calls.push("lock");
    return async () => {
      this.calls.push("release");
    };
  }
  async probe() {
    this.calls.push("probe");
    if (this.failProbe) throw new DiagnosableError("offline");
  }
  async pauseSync() {
    this.calls.push("pause");
  }
  async reconcileWorkspace() {
    this.calls.push("workspace");
  }
  async resumeAndFlush() {
    this.calls.push("flush");
  }
  async bootstrap() {
    this.calls.push("bootstrap");
  }
  async collectSecrets() {
    this.calls.push("secrets");
    return { SECRET: "secret-canary" };
  }
  async startRemote(
    _command: readonly string[],
    _secrets: Readonly<Record<string, string>>,
    marker: () => Promise<void>,
  ) {
    this.calls.push("remote");
    if (this.notStartedReason !== undefined) {
      return { kind: "not-started" as const, reason: this.notStartedReason };
    }
    await marker();
    return { kind: "completed" as const, exitCode: this.remoteExit };
  }
  async runLocal() {
    this.calls.push("local");
    return 17;
  }
  async recordFallback(reason: string) {
    this.calls.push(`outage:${reason}`);
  }
  async recordRemoteChildStarted() {
    this.calls.push("recovery");
  }
  reportedDetail: string | undefined;
  reportUnavailable(reason: string, detail?: string) {
    this.calls.push(`unavailable:${reason}`);
    this.reportedDetail = detail;
  }
}

const profile = { mode: "auto" as const, fallback: "local" as const };

describe("profile runtime composition", () => {
  it("records one stable outage before the automatic local fallback", async () => {
    const services = new FakeServices();
    services.failProbe = true;

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(17);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "release",
      "unavailable:transport",
      "outage:transport",
      "local",
    ]);
    /* The outage stays a stable reason while the operator gets the underlying failure. */
    expect(services.reportedDetail).toBe("offline");
  });

  it("records recovery at child start and keeps a remote failure authoritative", async () => {
    const services = new FakeServices();
    services.remoteExit = 23;

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(23);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "pause",
      "workspace",
      "flush",
      "bootstrap",
      "secrets",
      "remote",
      "release",
      "recovery",
    ]);
    expect(services.calls).not.toContain("local");
  });

  it("neither notifies nor falls back when the workload command cannot be executed", async () => {
    const services = new FakeServices();
    services.notStartedReason = WORKLOAD_COMMAND_REASON;

    const code = await runProfile(createProfileRuntime(services), profile, ["rm -rf .nx/cache && ls .nx"]);

    expect(code).toBe(127);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "pause",
      "workspace",
      "flush",
      "bootstrap",
      "secrets",
      "remote",
      "release",
    ]);
  });

  it("does not notify or prepare when the caller selects local mode", async () => {
    const services = new FakeServices();

    expect(await runProfile(createProfileRuntime(services), profile, ["./verify"], "local")).toBe(17);
    expect(services.calls).toEqual(["local"]);
  });
});
