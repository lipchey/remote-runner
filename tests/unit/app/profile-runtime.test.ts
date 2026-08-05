import { describe, expect, it } from "vitest";

import { createProfileRuntime, type ProfileExecutionServices } from "../../../src/app/profile-runtime.js";
import { DependencyCommandError } from "../../../src/bootstrap/dependencies.js";
import { DiagnosableError } from "../../../src/runtime/diagnostic.js";
import { PreparationError, RetryablePreparationError } from "../../../src/run/prepare.js";
import { INFRASTRUCTURE_EXIT_CODE, WORKLOAD_COMMAND_REASON, runProfile } from "../../../src/run/run-profile.js";

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
  probeFailures: Error[] = [];
  async probe() {
    this.calls.push("probe");
    if (this.failProbe) throw new DiagnosableError("offline");
    const failure = this.probeFailures.shift();
    if (failure !== undefined) throw failure;
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
  readonly reportedDetails: (string | undefined)[] = [];
  reportUnavailable(reason: string, detail?: string) {
    this.calls.push(`unavailable:${reason}`);
    this.reportedDetails.push(detail);
  }
  get reportedDetail(): string | undefined {
    return this.reportedDetails.at(-1);
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

  it("announces an unavailable remote before falling back when the child never starts", async () => {
    const services = new FakeServices();
    services.notStartedReason = "child-start";

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(17);
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
      "unavailable:child-start",
      "release",
      "outage:child-start",
      "local",
    ]);
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

  it("reports one unavailable line when the retried preparation fails the same way", async () => {
    const services = new FakeServices();
    services.probeFailures = [new RetryablePreparationError("offline"), new RetryablePreparationError("offline")];

    await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(services.calls.filter((call) => call.startsWith("unavailable:"))).toEqual(["unavailable:transport"]);
    expect(services.calls.filter((call) => call === "probe")).toHaveLength(2);
  });

  it("still reports the retry when it fails for a different reason", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("transport", true), new PreparationError("sync", true)];

    await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(services.calls.filter((call) => call.startsWith("unavailable:"))).toEqual([
      "unavailable:transport",
      "unavailable:sync",
    ]);
  });

  /* The memo keys on the whole failure, not the reason: the second detail is the actionable one and
     is the only thing the operator gets, since the notification channel carries the reason alone. */
  it("still reports the retry when the same reason carries a new detail", async () => {
    const services = new FakeServices();
    services.probeFailures = [
      new PreparationError("sync", true, { cause: new DiagnosableError("mutagen session is in conflict") }),
      new PreparationError("sync", true, { cause: new DiagnosableError("mutagen daemon is not running") }),
    ];

    await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(services.calls.filter((call) => call.startsWith("unavailable:"))).toEqual([
      "unavailable:sync",
      "unavailable:sync",
    ]);
    expect(services.reportedDetails).toEqual(["mutagen session is in conflict", "mutagen daemon is not running"]);
  });

  /* Without a diagnosable cause the operator gets one bare `reason=consumer-setup` line naming
     neither the script nor its exit code — nothing to act on, and no command output is forwarded. */
  it("names the failing consumer command and its exit code in the detail", async () => {
    const services = new FakeServices();
    services.probeFailures = [
      new PreparationError("consumer-setup", false, {
        cause: new DependencyCommandError(
          "./scripts/ds-bootstrap.sh",
          3,
          "dependency setup ./scripts/ds-bootstrap.sh failed with exit code 3",
        ),
      }),
    ];

    await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(services.reportedDetail).toBe("dependency setup ./scripts/ds-bootstrap.sh failed with exit code 3");
  });

  it("neither notifies nor falls back when the consumer's own setup command fails", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("consumer-setup", false)];

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toEqual(["validate", "lock", "probe", "release", "unavailable:consumer-setup"]);
    expect(services.calls).not.toContain("local");
    expect(services.calls.some((call) => call.startsWith("outage:"))).toBe(false);
  });

  it("does not notify or prepare when the caller selects local mode", async () => {
    const services = new FakeServices();

    expect(await runProfile(createProfileRuntime(services), profile, ["./verify"], "local")).toBe(17);
    expect(services.calls).toEqual(["local"]);
  });
});
