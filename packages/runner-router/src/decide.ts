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
  /* The last committed decision, for alarm planning outside a pass: a debounced probe failure leaves
     the PC healthy with `healthySince` null. Absent on controls stored before it existed. */
  pcHealthy?: boolean;
}
export interface Decision {
  kind: "known" | "unknown";
  desired: Admission | null;
  healthySince: number | null;
  lastKnownEvalAt: number | null;
  unknownSince: number | null;
  pcHealthy: boolean;
  /* `desired: "off"` can merely echo a stale stored `applied`; only this authorises removing labels. */
  offAuthorized: boolean;
}
/* A single 3 s probe can fail on a PC saturated by CI while GitHub still sees every runner online;
   a real selective cut fails every report, and three at the 10 s cadence stay inside the 45 s
   death-to-label target. */
export const PROBE_FAILURES_FOR_OUTAGE = 3;

function githubUnreachable(hb: Heartbeat): boolean {
  return !hb.report.githubProbe && (hb.probeFailures ?? 0) >= PROBE_FAILURES_FOR_OUTAGE;
}

export function healthReport(
  hb: Heartbeat | undefined,
  roster: readonly Runner[] | undefined,
  config: Config,
  now: number,
): string[] {
  const lines: string[] = [];
  const pcUnreachable = !hb || now >= hb.acceptedAt + 30_000 || githubUnreachable(hb);
  if (!hb) lines.push("heartbeat: жодного прийнятого");
  else {
    const age = Math.round((now - hb.acceptedAt) / 1000);
    lines.push(`heartbeat: ${age} с тому${now >= hb.acceptedAt + 30_000 ? " — оренда минула" : ""}`);
    if (!hb.report.githubProbe)
      lines.push(
        githubUnreachable(hb)
          ? `ПК не дістає GitHub (проба впала ${hb.probeFailures} рази поспіль)`
          : `проба ПК → GitHub впала ${hb.probeFailures ?? 1}× поспіль — ще не фоллбек`,
      );
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
      offAuthorized: false,
    };
  const runnerHealthy =
    !!hb &&
    now < hb.acceptedAt + 30_000 &&
    hb.report.runners.some(
      (report) =>
        config.pcRunners.includes(report.name) &&
        report.unit === "active" &&
        report.listener &&
        roster.some(
          (runner) => runner.name === report.name && runner.status === "online" && runner.labels.includes("ci-active"),
        ),
    );
  const pcHealthy = runnerHealthy && !githubUnreachable(hb!);
  /* The probe is debounced only for turning fallback ON; any failed probe still restarts the 120 s
     of health that OFF requires, so the debounce never hastens a return to the PC. */
  const strictlyHealthy = runnerHealthy && hb!.report.githubProbe;
  let healthySince = strictlyHealthy ? Math.max(ctl.healthySince ?? now, hb!.reportHealthySince ?? now) : null;
  if (strictlyHealthy && ctl.lastKnownEvalAt !== null && now - ctl.lastKnownEvalAt > 90_000) healthySince = now;
  const offAuthorized = pcHealthy && healthySince !== null && now - healthySince >= 120_000;
  return {
    kind: "known",
    pcHealthy,
    healthySince,
    lastKnownEvalAt: now,
    unknownSince: null,
    offAuthorized,
    desired: !pcHealthy ? "on" : offAuthorized ? "off" : (ctl.applied ?? "on"),
  };
}
