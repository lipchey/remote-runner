import type { Config } from "./config.js";
import { decide, healthReport, type Control, type Decision, type Runner } from "./decide.js";
import type { Deadline, GitHubPort, Result } from "./github.js";
import { acceptHeartbeat, type Heartbeat, type LastRejected, type Report, type Rejection } from "./heartbeat.js";
import { configSecrets, writeLog } from "./log.js";

const kyivTime = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const kyiv = (at: number) => `${kyivTime.format(new Date(at))} (Київ)`;
const minutes = (milliseconds: number) => Math.round(milliseconds / 60_000);
/* Telegram rejects text over 4096 characters, and a rejected head entry blocks the outbox. */
const TELEGRAM_TEXT_BUDGET = 4000;

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
}
export interface Outbox {
  messages: { id: number; text: string }[];
  nextId: number;
  dropped: number;
}
export interface TelegramPort {
  send(text: string): Promise<boolean>;
}
export interface Ports {
  now(): number;
  storage: Storage;
  github: GitHubPort;
  telegram: TelegramPort;
  deadline: Deadline;
}

function lastPcHealthy(ctl: Control): boolean {
  return ctl.pcHealthy ?? ctl.healthySince !== null;
}

export function initialControl(now: number): Control {
  return {
    createdAt: now,
    applied: null,
    healthySince: null,
    lastKnownEvalAt: null,
    unknownSince: null,
    retryAt: null,
    cooldownUntil: null,
    alerts: { laptopMissing: false, unknown: false, noHeartbeat: false },
    token: null,
  };
}
function decisionTrace(decision: Decision, hb: Heartbeat | undefined, at: number) {
  return {
    at,
    hbCounter: hb?.counter ?? null,
    hbAcceptedAt: hb?.acceptedAt ?? null,
    kind: decision.kind,
    desired: decision.desired,
    pcHealthy: decision.pcHealthy,
    offAuthorized: decision.offAuthorized,
    healthySince: decision.healthySince,
    lastKnownEvalAt: decision.lastKnownEvalAt,
  };
}

type Trace = Record<string, unknown> & {
  decisions: ReturnType<typeof decisionTrace>[];
  mutations: { op: string; labels: string[]; result: string; reason?: string }[];
};

export class RouterCore {
  private mutex: Promise<void> = Promise.resolve();
  private flushing: Promise<void> = Promise.resolve();
  private unknownReason: string | undefined;
  get flushed(): Promise<void> {
    return this.flushing;
  }
  constructor(
    private readonly config: Config,
    private readonly ports: Ports,
  ) {}

  private log(event: string, fields: Record<string, unknown>, tokens: Iterable<string> = []): void {
    writeLog(event, fields, [...configSecrets(this.config), ...tokens, this.ports.github.token?.value ?? ""]);
  }

  private async control(): Promise<Control> {
    const stored = await this.ports.storage.get<Control>("ctl");
    if (stored) return stored;
    const ctl = initialControl(this.ports.now());
    await this.ports.storage.put("ctl", ctl);
    return ctl;
  }

  async requestReconcile(source: "heartbeat" | "cron"): Promise<void> {
    const ctl = await this.control();
    const now = this.ports.now();
    if (source === "heartbeat" && ctl.cooldownUntil !== null && now < ctl.cooldownUntil) return;
    await this.ports.storage.put("wake", now);
    const alarm = await this.ports.storage.getAlarm();
    if (alarm === null || alarm > now) await this.ports.storage.setAlarm(now);
  }

  async heartbeat(report: Report): Promise<{ kind: "ok" } | Rejection> {
    await this.control();
    /* Input gates protect this read/put pair only without intervening external I/O. */
    const previous = await this.ports.storage.get<Heartbeat>("hb");
    const result = acceptHeartbeat(report, previous, this.ports.now());
    if (result.kind === "rejected") {
      await this.rejectHeartbeat(result);
      return result;
    }
    await this.ports.storage.put("hb", result.hb);
    await this.requestReconcile("heartbeat");
    return { kind: "ok" };
  }

  async rejectHeartbeat(rejection: Rejection): Promise<void> {
    const ctl = await this.control();
    const lastRejected: LastRejected = { at: this.ports.now(), reason: rejection.reason };
    this.log("heartbeat_rejected", { status: rejection.status, reason: lastRejected.reason }, [ctl.token?.value ?? ""]);
    await this.ports.storage.put("lastRejected", lastRejected);
  }

  async reconcile(): Promise<void> {
    const trace: Trace = { decisions: [], mutations: [] };
    const tokens = new Set<string>();
    const pass = this.mutex.then(() => this.pass(trace, tokens));
    this.mutex = pass.then(
      () => {},
      () => {},
    );
    let passStart: number;
    try {
      passStart = await pass;
    } catch (error) {
      this.log("reconcile_error", { ...trace, error: error instanceof Error ? error.message : String(error) }, tokens);
      throw error;
    }
    const flush = this.flushing.then(() => this.flush(passStart, tokens));
    this.flushing = flush.catch((error) => {
      this.log("flush_error", { error: error instanceof Error ? error.message : String(error) }, tokens);
    });
  }

  private unknown(ctl: Control, result: Exclude<Result<unknown>, { kind: "ok" }>, prior: Control): void {
    const now = this.ports.now();
    this.unknownReason = result.reason;
    ctl.healthySince = null;
    ctl.unknownSince = prior.unknownSince ?? now;
    ctl.lastKnownEvalAt = prior.lastKnownEvalAt;
    ctl.retryAt = result.kind === "cooldown" ? null : now + 10_000;
    ctl.cooldownUntil = result.kind === "cooldown" ? result.until : null;
  }

  private async call<T>(signal: AbortSignal, operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (signal.aborted) return { kind: "unknown", reason: "Reconcile deadline expired" };
    return operation();
  }

  private async pass(trace: Trace, tokens: Set<string>): Promise<number> {
    const passStart = this.ports.now();
    trace.at = passStart;
    const rememberToken = () => tokens.add(this.ports.github.token?.value ?? "");
    rememberToken();
    const signal = this.ports.deadline.timeout(15_000);
    let ctl = initialControl(passStart);
    let pcHealthy = false;
    let rosterSnapshot: Runner[] | undefined;
    this.unknownReason = undefined;
    try {
      ctl = await this.control();
      const prior = { ...ctl };
      tokens.add(ctl.token?.value ?? "");
      trace.previousApplied = prior.applied;
      this.ports.github.token = ctl.token;
      let laptopMissing: boolean | undefined;
      try {
        const now = this.ports.now();
        const roster: Result<Runner[]> =
          ctl.cooldownUntil !== null && now < ctl.cooldownUntil
            ? { kind: "cooldown", until: ctl.cooldownUntil, reason: "GitHub cooldown" }
            : await this.call(signal, () => this.ports.github.list(signal));
        rememberToken();
        const hb = await this.ports.storage.get<Heartbeat>("hb");
        const decidedAt = this.ports.now();
        const decision = decide(hb, ctl, roster.kind === "ok" ? roster.value : undefined, this.config, decidedAt);
        trace.decisions.push(decisionTrace(decision, hb, decidedAt));
        Object.assign(ctl, {
          healthySince: decision.healthySince,
          lastKnownEvalAt: decision.lastKnownEvalAt,
          unknownSince: decision.unknownSince,
        });
        pcHealthy = decision.pcHealthy;
        if (roster.kind !== "ok") this.unknown(ctl, roster, prior);
        else {
          rosterSnapshot = roster.value;
          ctl.retryAt = null;
          ctl.cooldownUntil = null;
          const laptop = roster.value.find((runner) => runner.name === this.config.laptopRunner);
          trace.laptop = laptop
            ? { id: laptop.id, status: laptop.status, busy: laptop.busy, labels: [...laptop.labels] }
            : null;
          laptopMissing = !laptop || laptop.status === "offline";
          if (laptop) {
            let failure: Exclude<Result<unknown>, { kind: "ok" }> | undefined;
            if (decision.desired === "on") {
              const missing = this.config.laptopAdmissionLabels.filter((label) => !laptop.labels.includes(label));
              if (missing.length) {
                const result = await this.call(signal, () => this.ports.github.add(laptop, missing, signal));
                rememberToken();
                trace.mutations.push({
                  op: "add",
                  labels: missing,
                  result: result.kind,
                  ...(result.kind !== "ok" ? { reason: result.reason } : {}),
                });
                if (result.kind !== "ok") failure = result;
              }
            } else {
              for (const label of this.config.laptopAdmissionLabels.filter((label) => laptop.labels.includes(label))) {
                const fresh = await this.ports.storage.get<Heartbeat>("hb");
                const checkedAt = this.ports.now();
                const checked = decide(fresh, ctl, roster.value, this.config, checkedAt);
                trace.decisions.push(decisionTrace(checked, fresh, checkedAt));
                Object.assign(ctl, {
                  healthySince: checked.healthySince,
                  lastKnownEvalAt: checked.lastKnownEvalAt,
                  unknownSince: checked.unknownSince,
                });
                pcHealthy = checked.pcHealthy;
                if (checked.desired !== "off" || !checked.offAuthorized) break;
                const result = await this.call(signal, () => this.ports.github.remove(laptop, label, signal));
                rememberToken();
                trace.mutations.push({
                  op: "remove",
                  labels: [label],
                  result: result.kind,
                  ...(result.kind !== "ok" ? { reason: result.reason } : {}),
                });
                if (result.kind !== "ok") {
                  failure = result;
                  break;
                }
              }
            }
            const actual =
              failure?.kind === "cooldown"
                ? failure
                : await this.call(signal, () => this.ports.github.get(laptop, signal));
            rememberToken();
            trace.readback =
              actual.kind === "ok"
                ? { kind: actual.kind, status: actual.value.status, labels: [...actual.value.labels] }
                : { kind: actual.kind, reason: actual.reason };
            if (actual.kind === "ok" && actual.value.name === this.config.laptopRunner) {
              ctl.applied = this.config.laptopAdmissionLabels.some((label) => actual.value.labels.includes(label))
                ? "on"
                : "off";
              laptopMissing = actual.value.status === "offline";
            } else if (actual.kind === "cooldown") failure = actual;
            else if (actual.kind !== "ok") failure ??= actual;
            else failure ??= { kind: "unknown", reason: "Laptop registration changed" };
            if (failure) {
              this.unknown(ctl, failure, prior);
              pcHealthy = false;
            }
          }
        }
      } catch (error) {
        rememberToken();
        const detail = error instanceof Error ? error.message : String(error);
        this.unknown(ctl, { kind: "unknown", reason: `Reconcile failed: ${detail}` }, prior);
        pcHealthy = false;
      }
      ctl.token = this.ports.github.token;
      const hb = await this.ports.storage.get<Heartbeat>("hb");
      const lastRejected = await this.ports.storage.get<LastRejected>("lastRejected");
      const previous = await this.ports.storage.get<Control>("ctl");
      const now = this.ports.now();
      const messages: string[] = [];
      const laptop = this.config.laptopRunner;
      const status = healthReport(hb, rosterSnapshot, this.config, now)
        .map((line) => `- ${line}`)
        .join("\n");
      const healthyLongEnough = pcHealthy && ctl.healthySince !== null && now - ctl.healthySince >= 120_000;
      if (ctl.applied === "on" && previous?.applied !== "on")
        messages.push(
          `🟠 Ariadne CI: фоллбек УВІМКНЕНО — ноут ${laptop} бере джоби (${this.config.laptopAdmissionLabels.join(", ")}).\n${
            !pcHealthy
              ? "Немає жодного здорового раннера ПК:"
              : previous?.applied
                ? "Лейбл ноута виявлено під час перевірки, стан ПК:"
                : "Перший прохід після запуску Worker-а, стан ПК:"
          }\n${status}`,
        );
      if (ctl.applied === "off" && previous?.applied !== "off")
        messages.push(
          `🟢 Ariadne CI: фоллбек ВИМКНЕНО — ноут ${laptop} більше не бере нових джоб (поточна доробиться).\n${
            healthyLongEnough ? "ПК здоровий ≥120 с:" : "Лейбли ноута зняті, стан ПК:"
          }\n${status}`,
        );
      const episode = (key: keyof Control["alerts"], active: boolean | undefined, alert: string, recovery: string) => {
        if (active === undefined || active === ctl.alerts[key]) return;
        ctl.alerts[key] = active;
        messages.push(active ? alert : recovery);
      };
      episode(
        "laptopMissing",
        laptopMissing,
        `⚠️ Ariadne CI: ноут ${laptop} недоступний (offline або не зареєстрований) — фоллбеку нікуди перемикатись.`,
        `✅ Ariadne CI: ноут ${laptop} знову online.`,
      );
      episode(
        "unknown",
        ctl.unknownSince === null ? false : now - ctl.unknownSince >= 180_000 ? true : undefined,
        `⚠️ Ariadne CI: роутер ${minutes(now - (ctl.unknownSince ?? now))} хв не може прочитати GitHub — лейбли ноута заморожені (${ctl.applied?.toUpperCase() ?? "стан невідомий"}).\nОстання помилка: ${this.unknownReason ?? "невідома"}`,
        `✅ Ariadne CI: роутер знову читає GitHub${prior.unknownSince !== null ? ` (після ${minutes(now - prior.unknownSince)} хв)` : ""}.`,
      );
      episode(
        "noHeartbeat",
        now - (hb?.acceptedAt ?? ctl.createdAt) >= 300_000,
        `🔴 Ariadne CI: 5+ хв немає heartbeat від ПК (останній: ${hb ? kyiv(hb.acceptedAt) : "жодного"}) — роутер вважає ПК мертвим.${
          lastRejected ? `\nОстаннє відхилення ${kyiv(lastRejected.at)}: ${lastRejected.reason}` : ""
        }`,
        "✅ Ariadne CI: heartbeat від ПК знову приходить.",
      );
      const outbox = (await this.ports.storage.get<Outbox>("outbox")) ?? { messages: [], nextId: 1, dropped: 0 };
      const queued: Outbox["messages"] = [];
      for (const text of messages) {
        const message = { id: outbox.nextId++, text: `${text.slice(0, TELEGRAM_TEXT_BUDGET)}\n🕒 ${kyiv(now)}` };
        outbox.messages.push(message);
        /* Untruncated, so a secret cut at the Telegram budget still matches the scrub. */
        queued.push({ id: message.id, text });
      }
      const excess = Math.max(0, outbox.messages.length - 64);
      outbox.messages.splice(0, excess);
      outbox.dropped += excess;
      ctl.pcHealthy = pcHealthy;
      const lastDecision = trace.decisions.at(-1);
      Object.assign(trace, {
        at: now,
        kind: this.unknownReason !== undefined ? "unknown" : (lastDecision?.kind ?? "unknown"),
        desired: lastDecision?.desired ?? null,
        applied: ctl.applied,
        previousApplied: previous?.applied ?? null,
        pcHealthy,
        offAuthorized: lastDecision?.offAuthorized ?? false,
        healthySince: ctl.healthySince,
        healthyForS: ctl.healthySince === null ? null : (now - ctl.healthySince) / 1000,
        unknownSince: ctl.unknownSince,
        cooldownUntil: ctl.cooldownUntil,
        retryAt: ctl.retryAt,
        heartbeat: hb
          ? {
              ageS: (now - hb.acceptedAt) / 1000,
              counter: hb.counter,
              githubProbe: hb.report.githubProbe,
              probeFailures: hb.probeFailures ?? 0,
              reportHealthySince: hb.reportHealthySince,
            }
          : null,
        pcRunners: this.config.pcRunners.map((name) => {
          const report = hb?.report.runners.find((runner) => runner.name === name);
          const runner = rosterSnapshot?.find((runner) => runner.name === name);
          return {
            name,
            unit: report?.unit ?? null,
            listener: report?.listener ?? null,
            status: runner?.status ?? null,
            busy: runner?.busy ?? null,
            labels: runner ? [...runner.labels] : [],
          };
        }),
        laptop: trace.laptop ?? null,
        readback: trace.readback ?? null,
        unknownReason: this.unknownReason ?? null,
        alerts: { ...ctl.alerts },
        queued,
        outbox: { pending: outbox.messages.length, dropped: outbox.dropped },
      });
      await this.ports.storage.put({ ctl, outbox });
    } catch (error) {
      ctl = (await this.ports.storage.get<Control>("ctl")) ?? ctl;
      ctl.retryAt = Math.min(ctl.retryAt ?? Infinity, this.ports.now() + 10_000);
      pcHealthy = lastPcHealthy(ctl);
      throw error;
    } finally {
      await this.planAlarm(passStart, ctl, pcHealthy);
    }
    trace.durationMs = this.ports.now() - passStart;
    this.log("reconcile", trace, tokens);
    return passStart;
  }

  private async flush(passStart: number, tokens: Set<string>): Promise<void> {
    try {
      for (let sent = 0; sent < 5; sent++) {
        const outbox = await this.ports.storage.get<Outbox>("outbox");
        const message = outbox?.messages[0];
        if (!message) return;
        let ok = false;
        let error: string | undefined;
        try {
          ok = await this.ports.telegram.send(message.text);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          ok = false;
        }
        this.log("telegram", { id: message.id, ok, ...(error !== undefined ? { error } : {}) }, tokens);
        if (!ok) return;
        /* A reconcile can append messages while Telegram is pending. */
        const ack = this.mutex.then(async () => {
          const latest = await this.ports.storage.get<Outbox>("outbox");
          if (!latest) return;
          latest.messages = latest.messages.filter((entry) => entry.id !== message.id);
          await this.ports.storage.put("outbox", latest);
        });
        this.mutex = ack.catch(() => {});
        await ack;
      }
    } finally {
      const ctl = await this.control();
      const hb = await this.ports.storage.get<Heartbeat>("hb");
      await this.planAlarm(passStart, ctl, lastPcHealthy(ctl) && !!hb);
    }
  }

  private async planAlarm(passStart: number, ctl: Control, pcHealthy: boolean): Promise<void> {
    const hb = await this.ports.storage.get<Heartbeat>("hb");
    const outbox = await this.ports.storage.get<Outbox>("outbox");
    const wake = await this.ports.storage.get<number>("wake");
    const now = this.ports.now();
    const deadlines = [
      now + 60_000,
      ctl.retryAt,
      ctl.cooldownUntil,
      pcHealthy && hb ? hb.acceptedAt + 30_000 : null,
      ctl.healthySince !== null &&
      ctl.applied !== "off" &&
      !ctl.alerts.laptopMissing &&
      ctl.healthySince + 120_000 > now
        ? ctl.healthySince + 120_000
        : null,
      ctl.unknownSince !== null && !ctl.alerts.unknown ? ctl.unknownSince + 180_000 : null,
      !ctl.alerts.noHeartbeat ? (hb?.acceptedAt ?? ctl.createdAt) + 300_000 : null,
      outbox?.messages.length ? now + 30_000 : null,
    ];
    await this.ports.storage.setAlarm(
      wake !== undefined && wake > passStart
        ? now
        : Math.min(...deadlines.filter((at): at is number => at !== null).map((at) => Math.max(now, at))),
    );
  }
}
