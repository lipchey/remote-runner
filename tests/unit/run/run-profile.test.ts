import { describe, expect, it } from "vitest";

import {
  INFRASTRUCTURE_EXIT_CODE,
  WORKLOAD_COMMAND_REASON,
  runProfile,
  type RunProfileRuntime,
} from "../../../src/run/run-profile.js";
import type { FailureClass, PrepareResult } from "../../../src/run/prepare.js";

class FakeRuntime implements RunProfileRuntime {
  readonly calls: string[] = [];
  preparations: PrepareResult[] = [];
  localExit = 17;
  remoteExit = 0;
  remoteKind: "completed" | "not-started" = "completed";
  notStartedReason = "spawn";
  marker = true;
  seenSecrets?: Readonly<Record<string, string>>;
  /* Its own field, not a shared one with `seenSecrets`: what the fallback receives and what the
     remote child received are the two values this unit exists to keep equal, and one recorder
     cannot tell a swap between them. */
  localSecrets: Readonly<Record<string, string>> | undefined;

  async prepareRemote() {
    this.calls.push("prepare");
    const next = this.preparations.shift();
    if (!next) throw new Error("unexpected prepare");
    return next;
  }
  async runLocal(command: readonly string[], prepared?: Readonly<Record<string, string>>) {
    this.calls.push(`local:${command.join("|")}`);
    this.localSecrets = prepared;
    return this.localExit;
  }
  async failClosed() {
    this.calls.push("fail-closed");
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
const failed = (reason = "transport", retryable = false, failureClass: FailureClass = "remote"): PrepareResult => ({
  ok: false,
  reason,
  retryable,
  failureClass,
});

describe("early lock release", () => {
  it("keeps the started workload when releasing the lock fails, then releases after it exits", async () => {
    const runtime = new FakeRuntime();
    runtime.remoteExit = 3;
    let attempts = 0;
    runtime.preparations = [
      {
        ok: true,
        secrets: {},
        release: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("release failed");
        },
      },
    ];

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["true"])).resolves.toBe(3);
    expect(runtime.calls).not.toContain("local:true");
    expect(attempts).toBe(2);
  });
});

describe("workspace lock contention", () => {
  it("fails closed instead of duplicating the workload that holds the lock", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("lock", true), failed("lock", true)];

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["true"])).resolves.toBe(
      INFRASTRUCTURE_EXIT_CODE,
    );
    /* The give-up hook still runs: contention is filtered out of the outage channel by reason, at
       the notification boundary, not by skipping the announcement here. */
    expect(runtime.calls).toEqual(["prepare", "prepare", "fail-closed"]);
  });
});
describe("consumer setup failure", () => {
  it("fails closed instead of rerunning the setup script that already failed identically", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("consumer-setup", false)];

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["./verify"])).resolves.toBe(
      INFRASTRUCTURE_EXIT_CODE,
    );
    expect(runtime.calls).toEqual(["prepare", "fail-closed"]);
  });
});
describe("secrets on the local leg", () => {
  it("hands the fallback the snapshot prepared for the remote child, not a second collection", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteKind = "not-started";

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["./verify"])).resolves.toBe(17);
    expect(runtime.localSecrets).toEqual({ SECRET: "ephemeral-canary" });
    expect(runtime.localSecrets).toEqual(runtime.seenSecrets);
  });

  it("leaves a run that never collected any to the local leg's own collection", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("secrets", false)];

    /* A collection failure still buys the fallback: it is not proof that an immediate second
       collection fails too, and if it does the local leg refuses there. */
    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["./verify"])).resolves.toBe(17);
    expect(runtime.calls).toEqual(["prepare", "local:./verify"]);
    expect(runtime.localSecrets).toBeUndefined();
  });

  it("passes nothing on a run pinned to local mode, which never prepared anything", async () => {
    const runtime = new FakeRuntime();

    await expect(runProfile(runtime, { mode: "auto", fallback: "local" }, ["./verify"], "local")).resolves.toBe(17);
    expect(runtime.localSecrets).toBeUndefined();
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
  ] as const)("announces the outage without a local run for mode=%s fallback=%s", async (mode, fallback) => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("transport")];
    expect(await runProfile(runtime, { mode, fallback }, ["./verify"])).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(runtime.calls).toEqual(["prepare", "fail-closed"]);
  });

  it("still exits 75 when the give-up announcement cannot be delivered", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("transport")];
    let attempted = false;
    runtime.failClosed = () => {
      attempted = true;
      return Promise.reject(new Error("telegram unreachable"));
    };
    expect(await runProfile(runtime, { mode: "remote", fallback: "local" }, ["./verify"])).toBe(
      INFRASTRUCTURE_EXIT_CODE,
    );
    /* 75 is the exit code of this path anyway, so without this the test is green even when the
       announcement is never attempted and the injected rejection never happens. */
    expect(attempted).toBe(true);
  });

  it("announces the outage without a local run after a not-started remote on a fail-closed profile", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteKind = "not-started";
    expect(await runProfile(runtime, { mode: "auto", fallback: "fail" }, ["./verify"])).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(runtime.calls).toEqual(["prepare", "remote:./verify", "release", "fail-closed"]);
  });

  it("announces the outage when the lock release fails on top of a remote that never started", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [{ ok: true, secrets: {}, release: () => Promise.reject(new Error("lock removal failed")) }];
    runtime.remoteKind = "not-started";
    expect(await runProfile(runtime, { mode: "auto", fallback: "fail" }, ["./verify"])).toBe(INFRASTRUCTURE_EXIT_CODE);
    expect(runtime.calls).toContain("fail-closed");
  });

  it("announces the outage when preparation itself throws", async () => {
    const runtime = new FakeRuntime();
    runtime.prepareRemote = () => Promise.reject(new Error("reporting the failure failed"));
    expect(await runProfile(runtime, { mode: "remote", fallback: "fail" }, ["./verify"])).toBe(
      INFRASTRUCTURE_EXIT_CODE,
    );
    expect(runtime.calls).toEqual(["fail-closed"]);
  });

  it("does not retry a non-retryable preparation failure", async () => {
    const runtime = new FakeRuntime();
    runtime.preparations = [failed("bootstrap", false)];
    expect(await runProfile(runtime, profile, ["./verify"])).toBe(17);
    expect(runtime.calls.filter((call) => call === "prepare")).toHaveLength(1);
  });
});

it.each(["account-busy", "connection-lost"])(
  "never falls back after an ambiguous or capacity-limited remote start: %s",
  async (reason) => {
    const runtime = new FakeRuntime();
    runtime.preparations = [prepared(runtime)];
    runtime.remoteKind = "not-started";
    runtime.notStartedReason = reason;
    expect(await runProfile(runtime, { mode: "auto", fallback: "local" }, ["test"])).toBe(75);
    expect(runtime.calls.some((call) => call.startsWith("local:"))).toBe(false);
  },
);
