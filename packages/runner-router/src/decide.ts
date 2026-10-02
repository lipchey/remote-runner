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
export function healthReport(
  hb: Heartbeat | undefined,
  roster: readonly Runner[] | undefined,
  config: Config,
  now: number,
): string[] {
  const lines: string[] = [];
  const pcUnreachable = !hb || now >= hb.acceptedAt + 30_000 || !hb.report.githubProbe;
  if (!hb) lines.push("heartbeat: жодного прийнятого");
  else {
    const age = Math.round((now - hb.acceptedAt) / 1000);
    lines.push(`heartbeat: ${age} с тому${now >= hb.acceptedAt + 30_000 ? " — оренда минула" : ""}`);
    if (!hb.report.githubProbe) lines.push("ПК не дістає GitHub (проба впала)");
  }
  for (const name of config.pcRunners) {
    const report = hb?.report.runners.find((runner) => runner.name === name);
    const registration = roster?.find((runner) => runner.name === name);
    const problems: string[] = [];
    if (!report) problems.push("немає в heartbeat");
    else {
      if (report.unit !== "active") problems.push(`юніт ${report.unit}`);
      if (!report.listener) problems.push("listener не працює");
    }
    if (!roster) problems.push("ростер GitHub невідомий");
    else if (!registration) problems.push("не зареєстрований у GitHub");
    else {
      if (registration.status !== "online") problems.push("GitHub: offline");
      if (!registration.labels.includes("ci-active")) problems.push("без лейбла ci-active");
    }
    lines.push(
      `${name}: ${problems.length ? problems.join(", ") : pcUnreachable ? "без власних проблем" : "здоровий"}${registration?.busy ? " (зайнятий)" : ""}`,
    );
  }
  return lines;
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
