import type { Control, Runner } from "../src/decide.js";
import type { Heartbeat } from "../src/heartbeat.js";
import type { Config } from "../src/config.js";

export const config: Config = {
  repo: "lipchey/ariadne",
  pcRunners: ["popos-1", "popos-2", "popos-3"],
  laptopRunner: "ariadne-runner-1",
  laptopAdmissionLabels: ["ci-active"],
  githubAppId: "123",
  githubAppInstallationId: "456",
  githubAppPrivateKey: "unused",
  heartbeatSecret: "secret",
  telegramBotToken: "bot-token",
  telegramChatId: "chat",
};

export const start = 1_000_000;
export function control(): Control {
  return {
    createdAt: start,
    applied: "on",
    healthySince: start,
    lastKnownEvalAt: start,
    unknownSince: null,
    retryAt: null,
    cooldownUntil: null,
    alerts: { laptopMissing: false, unknown: false, noHeartbeat: false },
    token: null,
  };
}
export function heartbeat(now = start, healthySince: number | null = start): Heartbeat {
  return {
    report: {
      v: 1,
      counter: now,
      sentAt: now,
      githubProbe: true,
      runners: [{ name: "popos-1", unit: "active", listener: true }],
    },
    counter: now,
    acceptedAt: now,
    reportHealthySince: healthySince,
  };
}
export function runners(laptopLabels: string[] = ["ci-active"], laptopId = 4): Runner[] {
  return [
    { id: 1, name: "popos-1", status: "online", busy: false, labels: ["ci-active"] },
    { id: laptopId, name: config.laptopRunner, status: "online", busy: false, labels: [...laptopLabels] },
  ];
}
