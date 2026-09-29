import { describe, expect, it } from "vitest";

import {
  observePrimaryChildStarted,
  observeReachable,
  observeRefused,
  observeUnreachable,
  selectPrimary,
  type FallbackContext,
  type FallbackEvent,
  type FallbackRuntime,
  type FallbackState,
} from "../../../src/notifications/outage.js";

const context: FallbackContext = {
  consumer: "ariadne",
  requested: "verify-full-pop-os",
  fallback: "verify-full",
  remoteLabel: "pop-os",
  topology: {
    target: "runner@pop-os",
    hostKeySha256: "SHA256:primary",
    fallback: "verify-full",
    fallbackTarget: "runner@fallback",
  },
};

class FakeRuntime implements FallbackRuntime {
  state?: unknown;
  readonly sent: FallbackEvent[] = [];
  readonly writes: FallbackState[] = [];
  readonly warnings: string[] = [];
  clock = 0;
  writeAttempts = 0;
  failWriteAt: number | undefined;

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async readState(): Promise<unknown> {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  async writeState(state: FallbackState): Promise<void> {
    this.writeAttempts += 1;
    if (this.writeAttempts === this.failWriteAt) throw new Error("write failed");
    this.state = structuredClone(state);
    this.writes.push(structuredClone(state));
  }

  nowMs(): number {
    return this.clock;
  }

  async send(event: FallbackEvent): Promise<void> {
    this.sent.push(structuredClone(event));
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function event(index: number): FallbackEvent {
  return {
    kind: "primary-down",
    consumer: context.consumer,
    requested: context.requested,
    fallback: context.fallback,
    remoteLabel: context.remoteLabel,
    class: "reachability",
    reason: "transport",
    timestamp: new Date(index).toISOString(),
  };
}

function state(patch: Partial<FallbackState> = {}): FallbackState {
  return {
    schemaVersion: 2,
    consumer: context.consumer,
    primary: context.requested,
    topology: context.topology,
    outage: null,
    refusal: null,
    negative: null,
    lease: null,
    lastRecoveryAt: null,
    backoffTtlMs: 60_000,
    queue: [],
    ...patch,
  };
}

describe("fallback state", () => {
  it("sends one primary-down and sets a 60 s negative entry", async () => {
    const runtime = new FakeRuntime();

    await observeUnreachable(runtime, context, "transport");

    expect(runtime.sent.map(({ kind }) => kind)).toEqual(["primary-down"]);
    expect((runtime.state as FallbackState).negative).toEqual({
      checkedAt: "1970-01-01T00:00:00.000Z",
      ttlMs: 60_000,
    });
  });

  it("repeats extend the TTL without a second primary-down", async () => {
    const runtime = new FakeRuntime();

    await observeUnreachable(runtime, context, "transport");
    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(60_000);
    await observeUnreachable(runtime, context, "transport");
    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(120_000);
    await observeUnreachable(runtime, context, "transport");
    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(240_000);
    for (let index = 0; index < 5; index += 1) await observeUnreachable(runtime, context, "transport");
    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(600_000);
    expect(runtime.sent).toHaveLength(1);
  });

  it("selectPrimary skips a fresh entry and leases an expired one once", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");
    expect(await selectPrimary(runtime, context)).toBe(false);

    runtime.clock = 61_000;
    expect(await selectPrimary(runtime, context)).toBe(true);
    expect((runtime.state as FallbackState).lease).toEqual({
      takenAt: "1970-01-01T00:01:01.000Z",
      ttlMs: 60_000,
    });
    expect(await selectPrimary(runtime, context)).toBe(false);

    runtime.clock = 122_000;
    expect(await selectPrimary(runtime, context)).toBe(true);
  });

  it("a backward clock step expires the entry", async () => {
    const runtime = new FakeRuntime();
    runtime.clock = 100_000;
    await observeUnreachable(runtime, context, "transport");

    runtime.clock = 99_000;
    await expect(selectPrimary(runtime, context)).resolves.toBe(true);
  });

  it("an entry whose ttlMs exceeds the cap is clamped", async () => {
    const runtime = new FakeRuntime();
    runtime.state = state({
      outage: { reason: "transport", since: "1970-01-01T00:00:00.000Z" },
      negative: { checkedAt: "1970-01-01T00:00:00.000Z", ttlMs: 1_000_000_000 },
    });
    runtime.clock = 600_001;

    await expect(selectPrimary(runtime, context)).resolves.toBe(true);
  });

  it("sends one primary-recovered on a primary child start and clears the cache", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");

    await observePrimaryChildStarted(runtime, context);
    await observePrimaryChildStarted(runtime, context);

    expect(runtime.sent.map(({ kind }) => kind)).toEqual(["primary-down", "primary-recovered"]);
    expect(runtime.state).toMatchObject({ outage: null, refusal: null, negative: null, lease: null });
  });

  it("observeReachable clears the cache but sends no recovery", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");

    await observeReachable(runtime, context);

    expect(runtime.sent.map(({ kind }) => kind)).toEqual(["primary-down"]);
    expect(runtime.state).toMatchObject({ outage: { reason: "transport" }, negative: null, lease: null });
  });

  it("a security refusal is delivered while a transport outage is active", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");

    await observeRefused(runtime, context, "security", "host-key");
    await observeRefused(runtime, context, "security", "host-key");

    expect(runtime.sent.map(({ kind }) => kind)).toEqual(["primary-down", "primary-refused"]);
    expect(runtime.state).toMatchObject({ outage: { reason: "transport" }, refusal: { reason: "host-key" } });
  });

  it("a remote-class refusal with a local reason is silent", async () => {
    const runtime = new FakeRuntime();

    await observeRefused(runtime, context, "remote", "lock");

    expect(runtime.sent).toEqual([]);
  });

  it("refusal clears the negative entry and lease and outranks fallback selection", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");
    runtime.clock = 61_000;
    await selectPrimary(runtime, context);

    await observeRefused(runtime, context, "security", "host-key");

    expect(runtime.state).toMatchObject({ negative: null, lease: null });
    await expect(selectPrimary(runtime, context)).resolves.toBe(true);
  });

  it("a concurrent selector skips only while the outage probe lease is live", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");
    runtime.clock = 61_000;

    await expect(selectPrimary(runtime, context)).resolves.toBe(true);
    await expect(selectPrimary(runtime, context)).resolves.toBe(false);
    await observeRefused(runtime, context, "security", "host-key");
    await expect(selectPrimary(runtime, context)).resolves.toBe(true);
  });

  it("a flap within 15 min resumes persisted backoff after serialization", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");
    await observeUnreachable(runtime, context, "transport");
    runtime.clock = 1_000;
    await observePrimaryChildStarted(runtime, context);
    runtime.state = JSON.parse(JSON.stringify(runtime.state)) as unknown;

    runtime.clock = 899_000;
    await observeUnreachable(runtime, context, "transport");

    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(240_000);
  });

  it("a flap outside 15 min resets persisted backoff to 60 s", async () => {
    const runtime = new FakeRuntime();
    await observeUnreachable(runtime, context, "transport");
    await observeUnreachable(runtime, context, "transport");
    runtime.clock = 1_000;
    await observePrimaryChildStarted(runtime, context);

    runtime.clock = 901_001;
    await observeUnreachable(runtime, context, "transport");

    expect((runtime.state as FallbackState).negative?.ttlMs).toBe(60_000);
  });

  it("a topology mismatch resets transitions, preserves the queue, and sends nothing", async () => {
    const runtime = new FakeRuntime();
    runtime.state = state({
      topology: { ...context.topology, target: "runner@old-primary" },
      outage: { reason: "transport", since: "1970-01-01T00:00:00.000Z" },
      negative: { checkedAt: "1970-01-01T00:00:00.000Z", ttlMs: 60_000 },
      queue: [event(0)],
    });

    await observeUnreachable(runtime, context, "transport");

    expect(runtime.sent).toEqual([]);
    expect(runtime.warnings).toHaveLength(1);
    expect(runtime.state).toMatchObject({
      topology: context.topology,
      outage: null,
      negative: null,
      queue: [event(0)],
    });
  });

  it("primary-recovered names whether it cleared outage, refusal, or both", async () => {
    const cleared: string[] = [];
    for (const setup of [
      async (runtime: FakeRuntime) => observeUnreachable(runtime, context, "transport"),
      async (runtime: FakeRuntime) => observeRefused(runtime, context, "security", "host-key"),
      async (runtime: FakeRuntime) => {
        await observeUnreachable(runtime, context, "transport");
        await observeRefused(runtime, context, "security", "host-key");
      },
    ]) {
      const runtime = new FakeRuntime();
      await setup(runtime);
      await observePrimaryChildStarted(runtime, context);
      const recovery = runtime.sent.find(({ kind }) => kind === "primary-recovered");
      if (recovery?.kind === "primary-recovered") cleared.push(recovery.cleared);
    }
    expect(cleared).toEqual(["outage", "refusal", "both"]);
  });

  it("delivers at most four queued events per lock hold", async () => {
    const runtime = new FakeRuntime();
    runtime.state = state({ queue: [event(0), event(1), event(2), event(3), event(4)] });

    await observeReachable(runtime, context);

    expect(runtime.sent).toHaveLength(4);
    expect((runtime.state as FallbackState).queue).toEqual([event(4)]);
  });

  it("durably enqueues before delivery and may redeliver after a dequeue-write crash", async () => {
    const runtime = new FakeRuntime();
    runtime.failWriteAt = 2;

    await expect(observeUnreachable(runtime, context, "transport")).rejects.toThrow("write failed");
    expect(runtime.sent).toHaveLength(1);
    expect((runtime.state as FallbackState).queue).toHaveLength(1);

    runtime.failWriteAt = undefined;
    await observeUnreachable(runtime, context, "transport");
    expect(runtime.sent).toHaveLength(2);
  });

  it("rejects a corrupt or v1 file", async () => {
    const runtime = new FakeRuntime();
    runtime.state = { schemaVersion: 1, outageActive: false, queue: [] };
    await expect(selectPrimary(runtime, context)).rejects.toThrow("fallback state is corrupt");

    runtime.state = { ...state(), extra: true };
    await expect(selectPrimary(runtime, context)).rejects.toThrow("fallback state is corrupt");
  });
});
