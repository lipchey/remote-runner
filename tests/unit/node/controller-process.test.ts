import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForControllerSignal } from "../../../src/node/controller.js";

describe("controller process lifetime", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the event loop alive until a termination signal and then clears its handle", async () => {
    vi.useFakeTimers();

    const waiting = waitForControllerSignal();
    expect(vi.getTimerCount()).toBe(1);

    process.emit("SIGTERM", "SIGTERM");
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
