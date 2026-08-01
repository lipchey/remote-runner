import { describe, expect, it } from "vitest";

import {
  recordFallback,
  recordRemoteChildStarted,
  type NotificationEvent,
  type OutageRuntime,
  type OutageState,
} from "../../../src/notifications/outage.js";

class FakeRuntime implements OutageRuntime {
  state?: OutageState;
  readonly sent: NotificationEvent[] = [];
  readonly writes: OutageState[] = [];
  failures = 0;
  clock = 0;
  async readState() {
    return this.state;
  }
  async writeState(state: OutageState) {
    this.state = structuredClone(state);
    this.writes.push(structuredClone(state));
  }
  now() {
    return new Date(Date.UTC(2026, 6, 31, 16, 0, this.clock++)).toISOString();
  }
  async send(event: NotificationEvent) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("Telegram secret-canary failure");
    }
    this.sent.push(event);
  }
}

const context = { consumer: "ariadne", profile: "verify-full", remoteLabel: "pop-os" };

describe("durable outage transitions", () => {
  it("alerts once per active outage and recovers on the first later remote child marker", async () => {
    const runtime = new FakeRuntime();
    await recordFallback(runtime, context, "transport");
    await recordFallback(runtime, context, "transport");
    await recordRemoteChildStarted(runtime, context);
    await recordRemoteChildStarted(runtime, context);
    expect(runtime.sent.map((event) => event.kind)).toEqual(["outage", "recovery"]);
    expect(runtime.state).toEqual({ schemaVersion: 1, outageActive: false, queue: [] });
  });

  it("retains a retry marker and never throws when delivery fails", async () => {
    const runtime = new FakeRuntime();
    runtime.failures = 1;
    await expect(recordFallback(runtime, context, "transport")).resolves.toEqual({ delivered: false, pending: 1 });
    expect(runtime.state?.queue).toHaveLength(1);
    await expect(recordFallback(runtime, context, "transport")).resolves.toEqual({ delivered: true, pending: 0 });
    expect(runtime.sent.map((event) => event.kind)).toEqual(["outage"]);
  });

  it("queues recovery behind an unsent outage and preserves chronological order", async () => {
    const runtime = new FakeRuntime();
    runtime.failures = 2;
    await recordFallback(runtime, context, "capacity");
    await recordRemoteChildStarted(runtime, context);
    expect(runtime.state?.queue.map((event) => event.kind)).toEqual(["outage", "recovery"]);
    runtime.failures = 0;
    await recordRemoteChildStarted(runtime, context);
    expect(runtime.sent.map((event) => event.kind)).toEqual(["outage", "recovery"]);
  });

  it("preserves outage-recovery-outage ordering across a rapid reconnect and new fallback", async () => {
    const runtime = new FakeRuntime();
    runtime.failures = 3;
    await recordFallback(runtime, context, "transport");
    await recordRemoteChildStarted(runtime, context);
    await recordFallback(runtime, context, "transport");
    expect(runtime.state?.queue.map((event) => event.kind)).toEqual(["outage", "recovery", "outage"]);
    runtime.failures = 0;
    await recordFallback(runtime, context, "transport");
    expect(runtime.sent.map((event) => event.kind)).toEqual(["outage", "recovery", "outage"]);
  });

  it("sends recovery at child start even when the later child outcome is not known", async () => {
    const runtime = new FakeRuntime();
    await recordFallback(runtime, context, "transport");
    const result = await recordRemoteChildStarted(runtime, context);
    expect(result).toEqual({ delivered: true, pending: 0 });
    expect(runtime.sent.at(-1)?.kind).toBe("recovery");
  });

  it("rejects arbitrary reason text and closed-schema state before persistence or delivery", async () => {
    const runtime = new FakeRuntime();
    await expect(recordFallback(runtime, context, "secret-canary")).rejects.toThrow("invalid");
    expect(runtime.writes).toEqual([]);
    runtime.state = {
      schemaVersion: 1,
      outageActive: false,
      queue: [],
      token: "secret-canary",
    } as unknown as OutageState;
    await expect(recordRemoteChildStarted(runtime, context)).rejects.toThrow("corrupt");
    expect(runtime.sent).toEqual([]);
  });
});
