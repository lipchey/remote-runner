import type { Config } from "./config.js";
import { decide, type Control, type Runner } from "./decide.js";
import type { Deadline, GitHubPort, Result } from "./github.js";
import { acceptHeartbeat, type Heartbeat, type LastRejected, type Report, type Rejection } from "./heartbeat.js";

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
export class RouterCore {
  private mutex: Promise<void> = Promise.resolve();
  private flushing: Promise<void> = Promise.resolve();
  get flushed(): Promise<void> {
    return this.flushing;
  }
  constructor(
    private readonly config: Config,
    private readonly ports: Ports,
  ) {}

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
    await this.control();
    const lastRejected: LastRejected = { at: this.ports.now(), reason: rejection.reason };
    console.warn(`Heartbeat rejected: ${lastRejected.reason}`);
    await this.ports.storage.put("lastRejected", lastRejected);
  }

  async reconcile(): Promise<void> {
    const pass = this.mutex.then(() => this.pass());
    this.mutex = pass.then(
      () => {},
      () => {},
    );
    const passStart = await pass;
    const flush = this.flushing.then(() => this.flush(passStart));
    this.flushing = flush.catch(() => {});
  }

  private unknown(ctl: Control, result: Exclude<Result<unknown>, { kind: "ok" }>, prior: Control): void {
    const now = this.ports.now();
    console.warn(`Reconcile ${result.kind}: ${result.reason}`);
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

  private async pass(): Promise<number> {
    const passStart = this.ports.now();
    const signal = this.ports.deadline.timeout(15_000);
    let ctl = initialControl(passStart);
    let pcHealthy = false;
    try {
      ctl = await this.control();
      const prior = { ...ctl };
      this.ports.github.token = ctl.token;
      let laptopMissing: boolean | undefined;
      try {
        const now = this.ports.now();
        const roster: Result<Runner[]> =
          ctl.cooldownUntil !== null && now < ctl.cooldownUntil
            ? { kind: "cooldown", until: ctl.cooldownUntil, reason: "GitHub cooldown" }
            : await this.call(signal, () => this.ports.github.list(signal));
        const hb = await this.ports.storage.get<Heartbeat>("hb");
        const decision = decide(
          hb,
          ctl,
          roster.kind === "ok" ? roster.value : undefined,
          this.config,
          this.ports.now(),
        );
        Object.assign(ctl, {
          healthySince: decision.healthySince,
          lastKnownEvalAt: decision.lastKnownEvalAt,
          unknownSince: decision.unknownSince,
        });
        pcHealthy = decision.pcHealthy;
        if (roster.kind !== "ok") this.unknown(ctl, roster, prior);
        else {
          ctl.retryAt = null;
          ctl.cooldownUntil = null;
          const laptop = roster.value.find((runner) => runner.name === this.config.laptopRunner);
          laptopMissing = !laptop || laptop.status === "offline";
          if (laptop) {
            let failure: Exclude<Result<unknown>, { kind: "ok" }> | undefined;
            if (decision.desired === "on") {
              const missing = this.config.laptopAdmissionLabels.filter((label) => !laptop.labels.includes(label));
              if (missing.length) {
                const result = await this.call(signal, () => this.ports.github.add(laptop, missing, signal));
                if (result.kind !== "ok") failure = result;
              }
            } else {
              for (const label of this.config.laptopAdmissionLabels.filter((label) => laptop.labels.includes(label))) {
                const fresh = await this.ports.storage.get<Heartbeat>("hb");
                const checked = decide(fresh, ctl, roster.value, this.config, this.ports.now());
                Object.assign(ctl, {
                  healthySince: checked.healthySince,
                  lastKnownEvalAt: checked.lastKnownEvalAt,
                  unknownSince: checked.unknownSince,
                });
                pcHealthy = checked.pcHealthy;
                if (checked.desired !== "off") break;
                const result = await this.call(signal, () => this.ports.github.remove(laptop, label, signal));
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
      if (ctl.applied !== previous?.applied && ctl.applied !== null)
        messages.push(`Fallback ${ctl.applied.toUpperCase()}`);
      const episode = (key: keyof Control["alerts"], active: boolean | undefined, alert: string, recovery: string) => {
        if (active === undefined || active === ctl.alerts[key]) return;
        ctl.alerts[key] = active;
        messages.push(active ? alert : recovery);
      };
      episode("laptopMissing", laptopMissing, "Laptop offline or absent", "Laptop recovered");
      episode(
        "unknown",
        ctl.unknownSince === null ? false : now - ctl.unknownSince >= 180_000 ? true : undefined,
        "GitHub unknown for at least 3 minutes",
        "GitHub recovered",
      );
      episode(
        "noHeartbeat",
        now - (hb?.acceptedAt ?? ctl.createdAt) >= 300_000,
        `No accepted heartbeat for 5 minutes${lastRejected ? `; last rejected at ${new Date(lastRejected.at).toISOString()}: ${lastRejected.reason}` : ""}`,
        "Heartbeat recovered",
      );
      const outbox = (await this.ports.storage.get<Outbox>("outbox")) ?? { messages: [], nextId: 1, dropped: 0 };
      for (const text of messages) {
        const stamped = `[${new Date(now).toISOString()}] ${text}`;
        console.log(stamped);
        outbox.messages.push({ id: outbox.nextId++, text: stamped });
      }
      const excess = Math.max(0, outbox.messages.length - 64);
      outbox.messages.splice(0, excess);
      outbox.dropped += excess;
      await this.ports.storage.put({ ctl, outbox });
    } catch (error) {
      ctl = (await this.ports.storage.get<Control>("ctl")) ?? ctl;
      ctl.retryAt = Math.min(ctl.retryAt ?? Infinity, this.ports.now() + 10_000);
      pcHealthy = ctl.healthySince !== null;
      throw error;
    } finally {
      await this.planAlarm(passStart, ctl, pcHealthy);
    }
    return passStart;
  }

  private async flush(passStart: number): Promise<void> {
    try {
      for (let sent = 0; sent < 5; sent++) {
        const outbox = await this.ports.storage.get<Outbox>("outbox");
        const message = outbox?.messages[0];
        if (!message) return;
        let ok = false;
        try {
          ok = await this.ports.telegram.send(message.text);
        } catch {
          ok = false;
        }
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
      await this.planAlarm(passStart, ctl, ctl.healthySince !== null && !!hb);
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
