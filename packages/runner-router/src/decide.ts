import type { Config } from "./config.js";
import type { Heartbeat } from "./heartbeat.js";

export type Admission = "on" | "off";
export interface Runner {
  id: number;
  name: string;
  status: "online" | "offline";
  busy: boolean;
  labels: string[];
}
export interface InstallationToken {
  value: string;
  expiresAt: number;
}
export interface Control {
  createdAt: number;
  applied: Admission | null;
  healthySince: number | null;
  lastKnownEvalAt: number | null;
  unknownSince: number | null;
  retryAt: number | null;
  cooldownUntil: number | null;
  alerts: { laptopMissing: boolean; unknown: boolean; noHeartbeat: boolean };
  token: InstallationToken | null;
}
export interface Decision {
  kind: "known" | "unknown";
  desired: Admission | null;
  healthySince: number | null;
  lastKnownEvalAt: number | null;
  unknownSince: number | null;
  pcHealthy: boolean;
}
export function decide(
  hb: Heartbeat | undefined,
  ctl: Control,
  roster: readonly Runner[] | undefined,
  config: Config,
  now: number,
): Decision {
  if (!roster)
    return {
      kind: "unknown",
      desired: ctl.applied,
      healthySince: null,
      lastKnownEvalAt: ctl.lastKnownEvalAt,
      unknownSince: ctl.unknownSince ?? now,
      pcHealthy: false,
    };
  const pcHealthy =
    !!hb &&
    now < hb.acceptedAt + 30_000 &&
    hb.report.githubProbe &&
    hb.report.runners.some(
      (report) =>
        config.pcRunners.includes(report.name) &&
        report.unit === "active" &&
        report.listener &&
        roster.some(
          (runner) => runner.name === report.name && runner.status === "online" && runner.labels.includes("ci-active"),
        ),
    );
  let healthySince = pcHealthy ? Math.max(ctl.healthySince ?? now, hb!.reportHealthySince ?? now) : null;
  if (pcHealthy && ctl.lastKnownEvalAt !== null && now - ctl.lastKnownEvalAt > 90_000) healthySince = now;
  return {
    kind: "known",
    pcHealthy,
    healthySince,
    lastKnownEvalAt: now,
    unknownSince: null,
    desired: !pcHealthy ? "on" : now - healthySince! >= 120_000 ? "off" : (ctl.applied ?? "on"),
  };
}
