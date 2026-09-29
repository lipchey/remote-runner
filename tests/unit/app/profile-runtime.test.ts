import { describe, expect, it } from "vitest";

import { createProfileRuntime, type ProfileExecutionServices } from "../../../src/app/profile-runtime.js";
import { DependencyCommandError } from "../../../src/bootstrap/dependencies.js";
import { DiagnosableError } from "../../../src/runtime/diagnostic.js";
import { RunTelemetry } from "../../../src/runtime/telemetry.js";
import { PreparationError, RetryablePreparationError, type FailureClass } from "../../../src/run/prepare.js";
import {
  INFRASTRUCTURE_EXIT_CODE,
  WORKLOAD_COMMAND_REASON,
  runProfile,
  runProfileLeg,
} from "../../../src/run/run-profile.js";

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
  async touchActivity() {
    this.calls.push("activity");
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
  throwAt?: "before-marker" | "after-marker";
  async startRemote(
    _command: readonly string[],
    _secrets: Readonly<Record<string, string>>,
    marker: () => Promise<void>,
  ) {
    this.calls.push("remote");
    if (this.throwAt === "before-marker") throw new Error("controller failed before the child started");
    if (this.notStartedReason !== undefined) {
      return { kind: "not-started" as const, reason: this.notStartedReason };
    }
    await marker();
    if (this.throwAt === "after-marker") throw new Error("stream writer failed mid-workload");
    return { kind: "completed" as const, exitCode: this.remoteExit };
  }
  localSecrets: Readonly<Record<string, string>> | undefined;
  async runLocal(_command: readonly string[], prepared?: Readonly<Record<string, string>>) {
    this.calls.push("local");
    this.localSecrets = prepared;
    return 17;
  }
  /* Distinct labels: the two differ in production — recordFallback additionally prints
     `running locally`, so a swap would announce a local run the fail-closed profile never makes. */
  async recordFallback(reason: string) {
    this.calls.push(`fallback:${reason}`);
  }
  async recordOutage(reason: string, failureClass?: FailureClass) {
    this.calls.push(`outage:${reason}${failureClass === undefined ? "" : `:${failureClass}`}`);
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

describe("remote fallback failure context", () => {
  it("hands the preparation's failure class to the fail-closed alert", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("host-key", false, { failureClass: "security" })];

    expect(
      await runProfile(createProfileRuntime(services), { mode: "auto", fallback: "verify-full" }, ["./verify"]),
    ).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toContain("outage:host-key:security");
  });

  it("records nothing when the leg fails over", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("transport", false, { failureClass: "reachability" })];

    expect(
      await runProfileLeg(createProfileRuntime(services), { mode: "auto", fallback: "verify-full" }, ["./verify"]),
    ).toEqual({ kind: "failover", reason: "transport" });
    expect(services.calls.some((call) => call.startsWith("outage:") || call.startsWith("fallback:"))).toBe(false);
  });

  it("passes remote as the class of a not-started outage", async () => {
    const services = new FakeServices();
    services.notStartedReason = "connection-lost";

    expect(await runProfile(createProfileRuntime(services), { mode: "auto", fallback: "fail" }, ["./verify"])).toBe(
      INFRASTRUCTURE_EXIT_CODE,
    );
    expect(services.calls).toContain("outage:connection-lost:remote");
  });
});

describe("profile runtime composition", () => {
  it("forwards the prepared secrets to the local leg, and nothing when preparation never got there", async () => {
    const started = new FakeServices();
    started.notStartedReason = "child-start";

    await expect(runProfile(createProfileRuntime(started), profile, ["./verify"])).resolves.toBe(17);
    expect(started.localSecrets).toEqual({ SECRET: "secret-canary" });

    const early = new FakeServices();
    early.failProbe = true;

    await expect(runProfile(createProfileRuntime(early), profile, ["./verify"])).resolves.toBe(17);
    expect(early.localSecrets).toBeUndefined();
  });

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
      "fallback:transport",
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
      "activity",
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
      "activity",
      "pause",
      "workspace",
      "flush",
      "bootstrap",
      "secrets",
      "remote",
      "unavailable:child-start",
      "release",
      "fallback:child-start",
      "local",
    ]);
  });

  /* The throwing half of the same outcome. Before this it returned 75 having established no reason
     at all, so nothing reached stderr, the runner log or the outage channel. */
  it("fails closed on an ambiguous remote outcome when the controller throws pre-marker", async () => {
    const services = new FakeServices();
    services.throwAt = "before-marker";

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "activity",
      "pause",
      "workspace",
      "flush",
      "bootstrap",
      "secrets",
      "remote",
      "unavailable:connection-lost",
      "release",
      "outage:connection-lost:remote",
    ]);
  });

  it("announces the give-up without a local run when the controller throws pre-marker on fallback=fail", async () => {
    const services = new FakeServices();
    services.throwAt = "before-marker";

    const code = await runProfile(createProfileRuntime(services), { mode: "auto", fallback: "fail" }, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toContain("unavailable:connection-lost");
    expect(services.calls).toContain("outage:connection-lost:remote");
    expect(services.calls).not.toContain("local");
  });

  /* A writer that threw killed the LOCAL ssh process; the workload is already running remotely and
     its result is unknown. So: no local rerun, no claim that the remote went down, but the operator
     and the runner log still learn the run gave up. */
  it("reports an unknown outcome without an outage or a rerun when the throw follows the marker", async () => {
    const services = new FakeServices();
    services.throwAt = "after-marker";

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toContain("unavailable:unknown");
    expect(services.calls.some((call) => call.startsWith("outage:"))).toBe(false);
    expect(services.calls).not.toContain("local");
    expect(services.calls).not.toContain("unavailable:child-start");
  });

  /* The reason belongs to the site that knows what failed: an unencodable secret frame is the
     secrets step failing, not a child that failed to start. */
  it("keeps the reason a not-started result carries instead of relabelling it child-start", async () => {
    const services = new FakeServices();
    services.notStartedReason = "secrets";

    await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(services.calls).toContain("unavailable:secrets");
    expect(services.calls).toContain("fallback:secrets");
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
      "activity",
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

  /* The reason reaches the outage boundary and is refused there, by the one predicate that owns
     which reasons mean the remote is down — this layer only decides that there is no local run. */
  it("does not fall back when the consumer's own setup command fails", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("consumer-setup", false)];

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "release",
      "unavailable:consumer-setup",
      "outage:consumer-setup:remote",
    ]);
    expect(services.calls).not.toContain("local");
  });

  it.each([
    ["remote", "local"],
    ["auto", "fail"],
  ] as const)("records the outage with no local run to announce it (mode=%s fallback=%s)", async (mode, fallback) => {
    const services = new FakeServices();
    services.failProbe = true;

    const code = await runProfile(createProfileRuntime(services), { mode, fallback }, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls).toEqual([
      "validate",
      "lock",
      "probe",
      "release",
      "unavailable:transport",
      "outage:transport:remote",
    ]);
    expect(services.calls).not.toContain("local");
  });

  it("records the outage once when the remote child never starts on a fail-closed profile", async () => {
    const services = new FakeServices();
    services.notStartedReason = "child-start";

    const code = await runProfile(createProfileRuntime(services), { mode: "auto", fallback: "fail" }, ["./verify"]);

    expect(code).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(services.calls.filter((call) => call.startsWith("outage:"))).toEqual(["outage:child-start:remote"]);
    expect(services.calls).not.toContain("local");
  });

  /* Passing the port's reason through means an implementation outside the shipped one can put an
     unrecognised string on the channel, so it degrades to a known code rather than being asserted
     as a specific diagnosis. The give-up is still announced — only the word is withheld. */
  it("degrades an unrecognised not-started reason instead of asserting child-start", async () => {
    const services = new FakeServices();
    services.notStartedReason = "spawn";

    await runProfile(createProfileRuntime(services), { mode: "auto", fallback: "fail" }, ["./verify"]);

    expect(services.calls.filter((call) => call.startsWith("outage:"))).toEqual(["outage:unknown:remote"]);
  });

  /* A failure the second attempt survives means the run reached the remote, so there is no outage to
     announce — the give-up hook is the consumption point precisely so the retry can clear it. */
  it("stays silent on the outage channel when a retryable failure is survived", async () => {
    const services = new FakeServices();
    services.probeFailures = [new PreparationError("transport", true)];

    const code = await runProfile(createProfileRuntime(services), { mode: "remote", fallback: "fail" }, ["./verify"]);

    expect(code).toBe(0);
    expect(services.calls).toContain("unavailable:transport");
    expect(services.calls.some((call) => call.startsWith("outage:"))).toBe(false);
  });

  /* Reporting sits between storing the pending reason and returning the preparation result, so an
     escaping throw would turn a diagnosed failure into an undiagnosed one: the run would lose its
     fallback and announce the give-up outage instead of the fallback it should have taken. */
  it("keeps the diagnosed verdict when reporting the failure throws", async () => {
    const services = new FakeServices();
    services.failProbe = true;
    services.reportUnavailable = () => {
      throw new Error("stderr is closed");
    };

    const code = await runProfile(createProfileRuntime(services), profile, ["./verify"]);

    expect(code).toBe(17);
    expect(services.calls).toContain("fallback:transport");
  });

  it("does not notify or prepare when the caller selects local mode", async () => {
    const services = new FakeServices();

    expect(await runProfile(createProfileRuntime(services), profile, ["./verify"], "local")).toBe(17);
    expect(services.calls).toEqual(["local"]);
  });

  /* Distinct costs per step — equal ones would keep the test green even if two spans swapped
     names. */
  it("times each preparation step under its own phase name", async () => {
    let elapsed = 0;
    const telemetry = new RunTelemetry(() => elapsed);
    class TimedServices extends FakeServices {
      override async validate() {
        elapsed += 1;
        return super.validate();
      }
      override async acquireLock() {
        elapsed += 2;
        return super.acquireLock();
      }
      override async probe() {
        elapsed += 4;
        return super.probe();
      }
      override async touchActivity() {
        elapsed += 256;
        return super.touchActivity();
      }
      override async pauseSync() {
        elapsed += 8;
        return super.pauseSync();
      }
      override async reconcileWorkspace() {
        elapsed += 16;
        return super.reconcileWorkspace();
      }
      override async resumeAndFlush() {
        elapsed += 32;
        return super.resumeAndFlush();
      }
      override async bootstrap() {
        elapsed += 64;
        return super.bootstrap();
      }
      override async collectSecrets() {
        elapsed += 128;
        return super.collectSecrets();
      }
    }

    const prepared = await createProfileRuntime(new TimedServices(), telemetry).prepareRemote();

    expect(prepared.ok).toBe(true);
    expect(telemetry.snapshot().phases).toEqual({
      validate: 1,
      lock: 2,
      probe: 4,
      "workload-lock": 256,
      "sync-pause": 8,
      "git-workspace": 16,
      "sync-resume": 32,
      bootstrap: 64,
      secrets: 128,
    });
  });

  it("leaves an unprepared run's later phases out of the record", async () => {
    let elapsed = 0;
    const telemetry = new RunTelemetry(() => elapsed);
    const services = new FakeServices();
    services.probe = async () => {
      elapsed += 9;
      throw new DiagnosableError("offline");
    };

    await createProfileRuntime(services, telemetry).prepareRemote();

    expect(Object.keys(telemetry.snapshot().phases)).toEqual(["validate", "lock", "probe"]);
    expect(telemetry.snapshot().phases["probe"]).toBe(9);
  });
});
