import { describe, expect, it } from "vitest";

import {
  INFRASTRUCTURE_EXIT_CODE,
  WORKLOAD_COMMAND_REASON,
  runProfile,
  type RunProfileRuntime,
} from "../../../src/run/run-profile.js";
import type { PrepareResult } from "../../../src/run/prepare.js";

class FakeRuntime implements RunProfileRuntime {
  readonly calls: string[] = [];
  preparations: PrepareResult[] = [];
  localExit = 17;
  remoteExit = 0;
  remoteKind: "completed" | "not-started" = "completed";
  notStartedReason = "spawn";
  marker = true;
  seenSecrets?: Readonly<Record<string, string>>;

  async prepareRemote() {
    this.calls.push("prepare");
    const next = this.preparations.shift();
    if (!next) throw new Error("unexpected prepare");
    return next;
  }
  async runLocal(command: readonly string[]) {
    this.calls.push(`local:${command.join("|")}`);
    return this.localExit;
  }
  async startRemote(
    command: readonly string[],
    secrets: Readonly<Record<string, string>>,
    onChildStarted: () => Promise<void>,
  ) {
    this.seenSecrets = secrets;
    this.calls.push(`remote:${command.join("|")}`);
    if (this.remoteKind === "not-started") return { kind: "not-started" as const, reason: this.notStartedReason };
    if (this.marker) {
      this.calls.push("marker");
      await onChildStarted();
    }
    this.calls.push(`remote-exit:${this.remoteExit}`);
    return { kind: "completed" as const, exitCode: this.remoteExit };
  }
}

function prepared(runtime: FakeRuntime): PrepareResult {
  let released = false;
  return {
    ok: true,
    secrets: { SECRET: "ephemeral-canary" },
    release: async () => {
      if (released) return;
      released = true;
      runtime.calls.push("release");
    },
  };
}
const failed = (reason = "transport", retryable = false): PrepareResult => ({ ok: false, reason, retryable });

describe("early lock release", () => {
  it("keeps the started workload when releasing the lock fails", async () => {
    const runtime = new FakeRuntime();
    runtime.remoteExit = 3;
    runtime.preparations = [
      {
        ok: true,
        secrets: {},
        release: async () => {
          throw new Error("release failed");
        },
      },
    ];

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["true"])).resolves.toBe(3);
    expect(runtime.calls).not.toContain("local:true");
  });
});
const profile = { mode: "auto" as const, fallback: "local" as const };

describe("run profile selection", () => {
  it("local mode bypasses every remote operation and returns the local exit exactly", async () => {
    const runtime = new FakeRuntime();
    expect(await runProfile(runtime, profile, ["./verify", "--full"], "local")).toBe(17);
    expect(runtime.calls).toEqual(["local:./verify|--full"]);
  });

  it("auto falls back locally after a bounded pre-child preparation failure", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("transport", true), failed("transport", true)];
    expect(await runProfile(runtime, profile, ["./verify", "--full"])).toBe(17);
    expect(runtime.calls).toEqual(["prepare", "prepare", "local:./verify|--full"]);
  });

  it("auto falls back after an explicit not-started result and releases the lock first", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteKind = "not-started";
    expect(await runProfile(runtime, profile, ["./verify", "--full"])).toBe(17);
    expect(runtime.calls).toEqual(["prepare", "remote:./verify|--full", "release", "local:./verify|--full"]);
  });

  it("returns command-not-found without a local fallback when the workload command cannot spawn", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteKind = "not-started";
    runtime.notStartedReason = WORKLOAD_COMMAND_REASON;
    expect(await runProfile(runtime, profile, ["rm -rf .nx/cache && ls .nx"])).toBe(127);
    expect(runtime.calls).toEqual(["prepare", "remote:rm -rf .nx/cache && ls .nx", "release"]);
  });

  it("releases at the child marker and propagates remote child failure without local retry", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteExit = 23;
    expect(await runProfile(runtime, profile, ["./verify", "--full"])).toBe(23);
    expect(runtime.calls).toEqual(["prepare", "remote:./verify|--full", "marker", "release", "remote-exit:23"]);
    expect(runtime.calls.some((call) => call.startsWith("local:"))).toBe(false);
    expect(runtime.seenSecrets).toEqual({ SECRET: "ephemeral-canary" });
  });

  it.each([0, 124, 137, 143, 255])("preserves authoritative remote exit %s", async (exitCode) => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteExit = exitCode;
    expect(await runProfile(runtime, profile, ["./verify"])).toBe(exitCode);
  });

  it("fails closed when remote completion lacks the child marker", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.marker = false;
    expect(await runProfile(runtime, profile, ["./verify"])).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(runtime.calls).not.toContain("local:./verify");
    expect(runtime.calls).toContain("release");
  });

  it.each([
    ["remote", "local"],
    ["auto", "fail"],
  ] as const)("does not fall back for mode=%s fallback=%s", async (mode, fallback) => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("transport")];
    expect(await runProfile(runtime, { mode, fallback }, ["./verify"])).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(runtime.calls).toEqual(["prepare"]);
  });

  it("does not retry a non-retryable preparation failure", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("bootstrap", false)];
    expect(await runProfile(runtime, profile, ["./verify"])).toBe(17);
    expect(runtime.calls.filter((call) => call === "prepare")).toHaveLength(1);
  });
});
