import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runControllerLoop } from "../../../src/node/controller.js";

describe("controller process lifetime", () => {
  afterEach(() => vi.useRealTimers());

  it("runs serialized passes immediately and on the bounded interval until termination", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let active = false;

    const running = runControllerLoop({
      intervalMs: 100,
      async runPass() {
        expect(active).toBe(false);
        active = true;
        calls.push("pass");
        await Promise.resolve();
        active = false;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["pass"]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["pass", "pass"]);

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues after an exceptional pass", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const running = runControllerLoop({
      intervalMs: 50,
      async runPass() {
        passes += 1;
        if (passes === 1) throw new Error("malformed queued request");
      },
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(passes).toBe(2);
    process.emit("SIGINT", "SIGINT");
    await expect(running).resolves.toBeUndefined();
  });
});
