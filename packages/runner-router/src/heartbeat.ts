import type { Config } from "./config.js";

export interface Report {
  v: 1;
  counter: number;
  sentAt: number;
  githubProbe: boolean;
  runners: { name: string; unit: string; listener: boolean }[];
}

export interface Heartbeat {
  report: Report;
  counter: number;
  acceptedAt: number;
  reportHealthySince: number | null;
  /* Optional: heartbeats stored before this field existed lack it. */
  probeFailures?: number;
}

export interface Rejection {
  kind: "rejected";
  status: number;
  reason: string;
}
export interface LastRejected {
  at: number;
  reason: string;
}

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseHeartbeat(body: string, config: Config): { kind: "ok"; report: Report } | Rejection {
  if (new TextEncoder().encode(body).length > 4096)
    return { kind: "rejected", status: 413, reason: "body exceeds 4 KiB" };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { kind: "rejected", status: 400, reason: "invalid JSON" };
  }
  if (
    !object(value, ["v", "counter", "sentAt", "githubProbe", "runners"]) ||
    value.v !== 1 ||
    !Number.isSafeInteger(value.counter) ||
    Number(value.counter) < 0 ||
    !Number.isSafeInteger(value.sentAt) ||
    typeof value.githubProbe !== "boolean" ||
    !Array.isArray(value.runners) ||
    value.runners.length === 0
  ) {
    return { kind: "rejected", status: 400, reason: "invalid report schema" };
  }
  const names = new Set<string>();
  for (const runner of value.runners as unknown[]) {
    if (
      !object(runner, ["name", "unit", "listener"]) ||
      typeof runner.name !== "string" ||
      !config.pcRunners.includes(runner.name) ||
      names.has(runner.name) ||
      typeof runner.unit !== "string" ||
      typeof runner.listener !== "boolean"
    ) {
      return { kind: "rejected", status: 400, reason: "invalid or duplicate runner" };
    }
    names.add(runner.name);
  }
  return { kind: "ok", report: value as unknown as Report };
}

export function acceptHeartbeat(
  report: Report,
  hb: Heartbeat | undefined,
  now: number,
): { kind: "ok"; hb: Heartbeat } | Rejection {
  if (hb && report.counter <= hb.counter) return { kind: "rejected", status: 409, reason: "counter did not increase" };
  if (Math.abs(report.sentAt - now) > 10_000)
    return { kind: "rejected", status: 400, reason: "sentAt outside 10 s window" };
  const healthy = report.githubProbe && report.runners.some((runner) => runner.unit === "active" && runner.listener);
  const leased = hb !== undefined && now < hb.acceptedAt + 30_000;
  const continuous = leased && hb.reportHealthySince !== null;
  return {
    kind: "ok",
    hb: {
      report,
      counter: report.counter,
      acceptedAt: now,
      reportHealthySince: healthy ? (continuous ? hb.reportHealthySince : now) : null,
      probeFailures: report.githubProbe ? 0 : (leased ? (hb.probeFailures ?? 0) : 0) + 1,
    },
  };
}

export function bearerMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const actual = encoder.encode(header.slice(7));
  const expected = encoder.encode(secret);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}
