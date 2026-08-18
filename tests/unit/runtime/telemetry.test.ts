import { describe, expect, it } from "vitest";

import { RUN_PHASES, RunTelemetry } from "../../../src/runtime/telemetry.js";

function fakeClock(): { readonly now: () => number; advance(milliseconds: number): void } {
  let current = 0;
  return {
    now: () => current,
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

describe("run telemetry", () => {
  it("names exactly the phases a run record may carry", () => {
    expect([...RUN_PHASES]).toEqual([
      "validate",
      "lock",
      "probe",
      "workload-lock",
      "sync-pause",
      "git-workspace",
      "sync-resume",
      "sync-flush",
      "bootstrap",
      "secrets",
      "child-start",
      "workload",
      "post-activity",
      "retention",
    ]);
  });

  it("sums a phase measured twice and reports whole milliseconds", async () => {
    const clock = fakeClock();
    const telemetry = new RunTelemetry(clock.now);

    await telemetry.measure("probe", async () => {
      clock.advance(1200.4);
    });
    await telemetry.measure("probe", async () => {
      clock.advance(800.2);
    });

    expect(telemetry.snapshot().phases).toEqual({ probe: 2001 });
  });

  it("keeps the spans a failing phase reached and leaves the later ones absent", async () => {
    const clock = fakeClock();
    const telemetry = new RunTelemetry(clock.now);

    await telemetry.measure("validate", async () => {
      clock.advance(10);
    });
    await expect(
      telemetry.measure("probe", async () => {
        clock.advance(4);
        throw new Error("remote shell is unusable");
      }),
    ).rejects.toThrow("remote shell is unusable");

    /* The failing phase keeps the time it spent failing; nothing after it is invented as zero. */
    expect(telemetry.snapshot().phases).toEqual({ validate: 10, probe: 4 });
  });

  it("moves an inner span out of the outer one that already counted it", async () => {
    const clock = fakeClock();
    const telemetry = new RunTelemetry(clock.now);

    await telemetry.measure("sync-resume", async () => {
      clock.advance(100);
    });
    telemetry.add("sync-flush", 70);
    telemetry.add("sync-resume", -70);

    expect(telemetry.snapshot().phases).toEqual({ "sync-resume": 30, "sync-flush": 70 });
  });

  it("aggregates every ssh the run spawns, including one that failed", async () => {
    const clock = fakeClock();
    const telemetry = new RunTelemetry(clock.now);

    await telemetry.measureSsh(async () => {
      clock.advance(300);
    });
    await expect(
      telemetry.measureSsh(async () => {
        clock.advance(1500);
        throw new Error("connection refused");
      }),
    ).rejects.toThrow("connection refused");
    await telemetry.measureSsh(async () => {
      clock.advance(200);
    });

    expect(telemetry.snapshot().ssh).toEqual({ count: 3, totalMs: 2000, maxMs: 1500 });
  });

  it("counts a span once however often its stop is called", () => {
    const clock = fakeClock();
    const telemetry = new RunTelemetry(clock.now);

    const stop = telemetry.start("child-start");
    clock.advance(40);
    stop();
    clock.advance(1000);
    stop();

    expect(telemetry.snapshot().phases).toEqual({ "child-start": 40 });
  });
});
