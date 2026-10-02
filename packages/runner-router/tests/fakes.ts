import type { Storage, TelegramPort } from "../src/core.js";
import type { InstallationToken, Runner } from "../src/decide.js";
import type { Fetch, GitHubPort, Result } from "../src/github.js";
import { runners } from "./fixtures.js";

export class FakeStorage implements Storage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  failAtomic = false;
  reads: string[] = [];
  writes: (string | string[])[] = [];
  onRead: ((key: string) => void) | undefined;
  async get<T>(key: string): Promise<T | undefined> {
    this.reads.push(key);
    this.onRead?.(key);
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") {
      this.writes.push(key);
      this.values.set(key, structuredClone(value));
    } else {
      if (this.failAtomic) {
        this.failAtomic = false;
        throw new Error("atomic failure");
      }
      this.writes.push(Object.keys(key));
      for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
    }
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }
}
export class FakeGitHub implements GitHubPort {
  token: InstallationToken | null = null;
  roster = runners();
  calls: string[] = [];
  listResult: Result<Runner[]> | undefined;
  getResult: Result<Runner> | undefined;
  addResult: Result<void> | undefined;
  removeResults: Result<void>[] = [];
  onList: (() => Promise<void>) | undefined;
  onAdd: (() => Promise<void>) | undefined;
  onRemove: (() => Promise<void>) | undefined;
  async list(signal: AbortSignal): Promise<Result<Runner[]>> {
    this.calls.push("list");
    await this.onList?.();
    if (signal.aborted) return { kind: "unknown", reason: "timeout" };
    return this.listResult ?? { kind: "ok", value: structuredClone(this.roster) };
  }
  async get(runner: Runner, _signal: AbortSignal): Promise<Result<Runner>> {
    this.calls.push(`get:${runner.id}`);
    if (this.getResult) return this.getResult;
    const actual = this.roster.find((entry) => entry.id === runner.id);
    return actual ? { kind: "ok", value: structuredClone(actual) } : { kind: "unknown", reason: "absent" };
  }
  async add(runner: Runner, labels: string[], _signal: AbortSignal): Promise<Result<void>> {
    this.calls.push(`add:${runner.id}:${labels.join(",")}`);
    await this.onAdd?.();
    const actual = this.roster.find((entry) => entry.id === runner.id)!;
    actual.labels = [...new Set([...actual.labels, ...labels])];
    return this.addResult ?? { kind: "ok", value: undefined };
  }
  async remove(runner: Runner, label: string, _signal: AbortSignal): Promise<Result<void>> {
    this.calls.push(`remove:${runner.id}:${label}`);
    await this.onRemove?.();
    const result = this.removeResults.shift() ?? { kind: "ok", value: undefined };
    if (result.kind === "ok") {
      const actual = this.roster.find((entry) => entry.id === runner.id)!;
      actual.labels = actual.labels.filter((entry) => entry !== label);
    }
    return result;
  }
}
export class FakeTelegram implements TelegramPort {
  messages: string[] = [];
  fail = false;
  onSend: (() => Promise<void>) | undefined;
  async send(text: string): Promise<boolean> {
    this.messages.push(text);
    await this.onSend?.();
    return !this.fail;
  }
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export class FakeFetch {
  calls: { url: string; init: RequestInit }[] = [];
  responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[] = [];
  fetch: Fetch = async (url, init) => {
    this.calls.push({ url, init });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    if (!next) throw new Error("unexpected request");
    return next;
  };
}
