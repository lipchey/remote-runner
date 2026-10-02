import { expect, it } from "vitest";
import { decide, type Runner } from "../src/decide.js";
import { acceptHeartbeat } from "../src/heartbeat.js";
import { config, start, control, heartbeat, runners } from "./fixtures.js";

it("item 1: expiresAt boundary is expired and desires ON", () => {
  expect(decide(heartbeat(), control(), runners(), config, start + 30_000)).toMatchObject({
    kind: "known",
    desired: "on",
    healthySince: null,
  });
});
it("item 4: OFF requires 120 seconds of continuous health", () => {
  const ctl = { ...control(), lastKnownEvalAt: start + 119_000 };
  expect(decide(heartbeat(start + 119_000), ctl, runners(), config, start + 119_000).desired).toBe("on");
  expect(decide(heartbeat(start + 120_000), ctl, runners(), config, start + 120_000).desired).toBe("off");
});
it("item 5: unknown, lease gap, overwritten unhealthy report and evaluation gap reset the countdown", () => {
  const ctl = control();
  const unknown = decide(heartbeat(), ctl, undefined, config, start + 1_000);
  expect(unknown).toMatchObject({ kind: "unknown", healthySince: null, unknownSince: start + 1_000 });
  const resumed = decide(heartbeat(start + 2_000), { ...ctl, ...unknown }, runners(), config, start + 2_000);
  expect(resumed.healthySince).toBe(start + 2_000);
  const gap = acceptHeartbeat(heartbeat(start + 30_000).report, heartbeat(), start + 30_000);
  if (gap.kind !== "ok") throw new Error("unexpected rejection");
  expect(decide(gap.hb, ctl, runners(), config, start + 30_000).healthySince).toBe(start + 30_000);
  const bad = acceptHeartbeat({ ...heartbeat(start + 10_000).report, githubProbe: false }, heartbeat(), start + 10_000);
  if (bad.kind !== "ok") throw new Error("unexpected rejection");
  const good = acceptHeartbeat(heartbeat(start + 20_000).report, bad.hb, start + 20_000);
  if (good.kind !== "ok") throw new Error("unexpected rejection");
  expect(decide(good.hb, ctl, runners(), config, start + 20_000).healthySince).toBe(start + 20_000);
  expect(decide(heartbeat(start + 90_001), ctl, runners(), config, start + 90_001).healthySince).toBe(start + 90_001);
  expect(decide(heartbeat(start + 90_000), ctl, runners(), config, start + 90_000).healthySince).toBe(start);
});
it("item 7: all PC runners busy and healthy never enable fallback", () => {
  const roster = config.pcRunners.map((name, index): Runner => ({
    id: index + 1,
    name,
    status: "online",
    busy: true,
    labels: ["ci-active"],
  }));
  const hb = heartbeat(start + 120_000);
  hb.report.runners = config.pcRunners.map((name) => ({ name, unit: "active", listener: true }));
  expect(decide(hb, { ...control(), lastKnownEvalAt: start + 119_000 }, roster, config, start + 120_000).desired).toBe(
    "off",
  );
});
it("item 8: health is never borrowed from another runner registration", () => {
  const roster = runners();
  roster[0]!.name = "popos-2";
  expect(
    decide(
      heartbeat(start, start - 120_001),
      {
        ...control(),
        applied: "off",
        healthySince: start - 120_001,
      },
      roster,
      config,
      start,
    ),
  ).toMatchObject({ desired: "on", pcHealthy: false, healthySince: null });
});
it("PC health requires ci-active, an active listener and the GitHub probe", () => {
  for (const labels of [[], ["popos"]]) {
    const roster = runners();
    roster[0]!.labels = labels;
    expect(decide(heartbeat(), control(), roster, config, start).pcHealthy).toBe(false);
  }
  for (const report of [
    { ...heartbeat().report, githubProbe: false },
    { ...heartbeat().report, runners: [{ name: "popos-1", unit: "failed", listener: true }] },
    { ...heartbeat().report, runners: [{ name: "popos-1", unit: "active", listener: false }] },
  ]) {
    expect(decide({ ...heartbeat(), report }, control(), runners(), config, start).pcHealthy).toBe(false);
  }
});
