import { describe, expect, it } from "vitest";
import { acceptHeartbeat, bearerMatches, parseHeartbeat, type Heartbeat } from "../src/heartbeat.js";
import { config } from "./fixtures.js";

export function report(now = 1_000_000, counter = now) {
  return {
    v: 1 as const,
    counter,
    sentAt: now,
    githubProbe: true,
    runners: [{ name: "popos-1", unit: "active", listener: true }],
  };
}

describe("heartbeat", () => {
  it("item 13: rejects schema, unknown names, old counters and stale/future reports without replacing hb", () => {
    const now = 1_000_000;
    const hb: Heartbeat = { report: report(now, 10), counter: 10, acceptedAt: now, reportHealthySince: now };
    const invalid = [
      { ...report(now), extra: true },
      { ...report(now), v: 2 },
      { ...report(now), runners: [] },
      { ...report(now), githubProbe: "true" },
      { ...report(now), counter: 1.5 },
      { ...report(now), sentAt: null },
      { ...report(now), runners: [report(now).runners[0], report(now).runners[0]] },
      { ...report(now), runners: [{ name: "popos-4", unit: "active", listener: true }] },
      { ...report(now), runners: [{ name: "popos-1", unit: "active", listener: true, extra: 0 }] },
      { ...report(now), runners: [{ name: "popos-1", unit: false, listener: true }] },
      { ...report(now), runners: [{ name: "popos-1", unit: "active", listener: 1 }] },
      report(now, 10),
      report(now, 9),
      report(now - 10_001),
      report(now + 10_001),
    ];
    for (const value of invalid) {
      const parsed = parseHeartbeat(JSON.stringify(value), config);
      const result = parsed.kind === "ok" ? acceptHeartbeat(parsed.report, hb, now) : parsed;
      expect(result.kind).toBe("rejected");
      expect(hb.counter).toBe(10);
    }
    expect(parseHeartbeat("{", config).kind).toBe("rejected");
    expect(parseHeartbeat(" ".repeat(4097), config)).toMatchObject({ kind: "rejected", status: 413 });
    expect(parseHeartbeat('"' + "é".repeat(2048) + '"', config)).toMatchObject({ status: 413 });
  });

  it("accepts the inclusive sentAt window and preserves only continuous report health", () => {
    const now = 1_000_000;
    expect(parseHeartbeat(JSON.stringify(report(now)), config)).toEqual({ kind: "ok", report: report(now) });
    const first = acceptHeartbeat(report(now), undefined, now);
    expect(first).toMatchObject({ kind: "ok", hb: { reportHealthySince: now } });
    if (first.kind !== "ok") throw new Error("acceptance failed");
    for (const offset of [-10_000, 10_000]) {
      expect(acceptHeartbeat(report(now + offset, now + 1), first.hb, now).kind).toBe("ok");
    }
    expect(acceptHeartbeat(report(now + 10_000), first.hb, now + 10_000)).toMatchObject({
      hb: { reportHealthySince: now },
    });
    const unhealthy = acceptHeartbeat({ ...report(now + 20_000), githubProbe: false }, first.hb, now + 20_000);
    expect(unhealthy).toMatchObject({ hb: { reportHealthySince: null } });
    if (unhealthy.kind !== "ok") throw new Error("acceptance failed");
    expect(acceptHeartbeat(report(now + 21_000), unhealthy.hb, now + 21_000)).toMatchObject({
      hb: { reportHealthySince: now + 21_000 },
    });
    expect(acceptHeartbeat(report(now + 30_000), first.hb, now + 30_000)).toMatchObject({
      hb: { reportHealthySince: now + 30_000 },
    });
  });

  it("robustness: constant-time bearer comparison uses UTF-8 bytes and rejects length mismatches", () => {
    expect(bearerMatches("Bearer secret", "secret")).toBe(true);
    expect(bearerMatches("Bearer sécret", "sécret")).toBe(true);
    for (const value of [
      null,
      "secret",
      "bearer secret",
      "Bearer secreu",
      "Bearer secre",
      "Bearer secretx",
      "Bearer sècret",
    ]) {
      expect(bearerMatches(value, "secret")).toBe(false);
    }
  });
});
