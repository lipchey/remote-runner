import { describe, expect, it } from "vitest";

import {
  MANDATORY_MUTAGEN_IGNORES,
  MutagenSyncLifecycle,
  compileIgnores,
  inspectOwnedSession,
  mutagenSessionName,
  type MutagenProcessRuntime,
  type MutagenSessionOptions,
} from "../../../src/sync/mutagen.js";

const bytes = (value = ""): Uint8Array => new TextEncoder().encode(value);

interface Outcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: boolean;
}

class FakeProcesses implements MutagenProcessRuntime {
  readonly requests: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly maxOutputBytes: number;
  }> = [];

  constructor(private readonly outcomes: Outcome[]) {}

  async run(request: { readonly command: string; readonly args: readonly string[]; readonly maxOutputBytes: number }) {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error(`unexpected process call: ${request.args.join(" ")}`);
    return {
      exitCode: outcome.exitCode ?? 0,
      stdout: bytes(outcome.stdout),
      stderr: bytes(outcome.stderr),
      outputTruncated: outcome.outputTruncated ?? false,
    };
  }
}

class FakeClock {
  constructor(private readonly readings: number[]) {}

  now(): number {
    const reading = this.readings.shift();
    if (reading === undefined) throw new Error("unexpected clock read");
    return reading;
  }
}

const options: MutagenSessionOptions = {
  consumer: "ariadne",
  profile: "verify-full",
  identity: "0123456789abcdef01234567",
  canonicalAlphaRoot: "/Users/dev/Ariadne Worktree",
  betaTarget: "runner@example.test",
  betaRoot: "/srv/remote-runner/workspaces/ariadne",
  ignores: [".cache", "node_modules", "build/**", ".cache"],
};

const name = "remote-runner-ariadne-verify-full-0123456789abcdef01234567";
const beta = "runner@example.test:/srv/remote-runner/workspaces/ariadne";

function session(
  status: string,
  patch: Partial<{
    name: string;
    alpha: string;
    beta: string;
    mode: string;
    ignores: string[];
    conflicts: unknown[];
    excludedConflicts: number;
  }> = {},
): string {
  return JSON.stringify([
    {
      identifier: "sync_AbCdEf1234567890",
      name: patch.name ?? name,
      alpha: { url: patch.alpha ?? options.canonicalAlphaRoot },
      beta: { url: patch.beta ?? beta },
      configuration: { synchronizationMode: patch.mode ?? "one-way-replica" },
      ignore: { paths: patch.ignores ?? compileIgnores(options.ignores) },
      paused: status === "paused",
      ...(status === "paused" ? {} : { status }),
      conflicts: patch.conflicts ?? [],
      excludedConflicts: patch.excludedConflicts ?? 0,
    },
  ]);
}

function liveV018PausedSession(): string {
  return JSON.stringify([
    {
      identifier: "sync_cGg7xdiUF1jgc0sZmBFTu2ubaPJv9DU5yp7WmUr07Q8",
      version: 1,
      alpha: { protocol: "local", path: options.canonicalAlphaRoot, connected: false },
      beta: {
        protocol: "ssh",
        user: "runner",
        host: "example.test",
        path: options.betaRoot,
        connected: false,
      },
      mode: "one-way-replica",
      ignore: { paths: compileIgnores(options.ignores) },
      name,
      paused: true,
      status: "disconnected",
    },
  ]);
}

function commandNames(processes: FakeProcesses): string[] {
  return processes.requests.map(({ args }) => args.slice(0, 2).join(" "));
}

describe("Mutagen one-way lifecycle", () => {
  it("builds a stable owned session name and rejects hostile components", () => {
    expect(mutagenSessionName("ariadne", "verify-full", "0123456789abcdef01234567")).toBe(name);
    for (const [consumer, identity] of [
      ["../ariadne", "0123456789abcdef01234567"],
      ["Ariadne", "0123456789abcdef01234567"],
      ["ariadne\0x", "0123456789abcdef01234567"],
      ["ariadne", "short"],
      ["ariadne", "ABCDEF0123456789ABCDEF01"],
    ]) {
      expect(() => mutagenSessionName(consumer!, "verify-full", identity!)).toThrow();
    }
  });

  it("deduplicates profile ignores while retaining every mandatory dependency and cache exclusion", () => {
    const compiled = compileIgnores([".cache", "node_modules", ".nx", "build/**", ".cache"]);

    expect(compiled).toEqual([...MANDATORY_MUTAGEN_IGNORES, ".cache", "build/**"]);
    expect(new Set(compiled).size).toBe(compiled.length);
    expect(compiled).toEqual(expect.arrayContaining(["node_modules", ".nx"]));
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "safe/../../secret",
    "safe\0name",
    "C:\\Windows",
    "safe\\windows",
    "!node_modules",
    "!node_modules/**",
    "!.tools/**",
    "!**/coverage",
  ])("rejects unsafe ignore pattern %s", (pattern) => {
    expect(() => compileIgnores([pattern])).toThrow();
  });

  it.each(["!**", "!n*", "!node_modules/**", "!docs/README.md"])(
    "rejects every user negation with a stable error: %s",
    (pattern) => {
      expect(() => compileIgnores([pattern])).toThrowError("Mutagen user ignore negation is not allowed");
    },
  );

  it("starts the daemon and creates a missing one-way session already paused with explicit ignores", async () => {
    const processes = new FakeProcesses([{}, { stdout: "" }, {}]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list", "sync create"]);
    const create = processes.requests[2];
    expect(processes.requests[1]?.args).toEqual(["sync", "list", "--template", "{{ json . }}"]);
    expect(create?.command).toBe("mutagen");
    expect(create?.args).toEqual([
      "sync",
      "create",
      "--name",
      name,
      "--sync-mode",
      "one-way-replica",
      "--paused",
      ...compileIgnores(options.ignores).flatMap((pattern) => ["--ignore", pattern]),
      "--",
      options.canonicalAlphaRoot,
      beta,
    ]);
    expect(processes.requests.every(({ maxOutputBytes }) => maxOutputBytes === 64 * 1024)).toBe(true);
  });

  it("pauses exactly one matching active session without recreating it", async () => {
    const processes = new FakeProcesses([{}, { stdout: session("watching") }, {}]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list", "sync pause"]);
  });

  it("accepts an already-paused matching session idempotently", async () => {
    const processes = new FakeProcesses([{}, { stdout: session("paused") }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list"]);
  });

  it("accepts the sanitized live Mutagen 0.18.1 session JSON shape", async () => {
    const processes = new FakeProcesses([{}, { stdout: liveV018PausedSession() }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list"]);
  });

  it("terminates exactly one owned session and treats absence as success", async () => {
    const presentProcesses = new FakeProcesses([{ stdout: session("watching") }, {}]);
    const presentLifecycle = new MutagenSyncLifecycle(presentProcesses, new FakeClock([]));

    await presentLifecycle.terminateOwned(options);

    expect(commandNames(presentProcesses)).toEqual(["sync list", "sync terminate"]);
    expect(presentProcesses.requests[1]?.args).toEqual(["sync", "terminate", name]);

    const absentProcesses = new FakeProcesses([{ stdout: "" }]);
    const absentLifecycle = new MutagenSyncLifecycle(absentProcesses, new FakeClock([]));

    await absentLifecycle.terminateOwned(options);

    expect(commandNames(absentProcesses)).toEqual(["sync list"]);
  });

  it.each([
    ["duplicate", session("paused").replace(/\]$/u, `,${session("paused").slice(1)}`)],
    ["unsafe alpha", session("paused", { alpha: "../other" })],
    ["beta mismatch", session("paused", { beta: "runner@example.test:/other" })],
  ])("fails closed before retention termination on %s", async (_label, listing) => {
    const processes = new FakeProcesses([{ stdout: listing }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await expect(lifecycle.terminateOwned(options)).rejects.toThrow();
    expect(commandNames(processes)).toEqual(["sync list"]);
  });

  it("starts the daemon idempotently on each independently prepared reconciliation", async () => {
    const processes = new FakeProcesses([{}, { stdout: session("paused") }, {}, { stdout: session("paused") }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);
    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list", "daemon start", "sync list"]);
  });

  it.each([
    ["duplicate", session("paused").replace(/\]$/u, `,${session("paused").slice(1)}`)],
    ["alpha mismatch", session("paused", { alpha: "/other" })],
    ["beta mismatch", session("paused", { beta: "runner@example.test:/other" })],
    ["mode mismatch", session("paused", { mode: "two-way-resolved" })],
    ["conflict", session("watching", { conflicts: [{}] })],
  ])("fails closed on %s before pausing", async (_label, listing) => {
    const processes = new FakeProcesses([{}, { stdout: listing }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await expect(lifecycle.pauseForGitReconcile(options)).rejects.toThrow();
    expect(commandNames(processes)).toEqual(["daemon start", "sync list"]);
  });

  it.each(["disconnected", "halted-on-root-deletion"])(
    "recreates a %s session before pausing instead of forcing the run onto the local fallback",
    async (status) => {
      const processes = new FakeProcesses([{}, { stdout: session(status) }, {}, {}]);
      const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

      await lifecycle.pauseForGitReconcile(options);

      expect(commandNames(processes)).toEqual(["daemon start", "sync list", "sync terminate", "sync create"]);
      expect(processes.requests[3]?.args).toContain("--paused");
    },
  );

  it.each(["watching", "paused"])("recreates a %s session whose ignores drifted from the manifest", async (status) => {
    const listing = session(status, { ignores: [".git", "node_modules"] });
    const processes = new FakeProcesses([{}, { stdout: listing }, {}, {}]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list", "sync terminate", "sync create"]);
    expect(processes.requests[3]?.args).toEqual([
      "sync",
      "create",
      "--name",
      name,
      "--sync-mode",
      "one-way-replica",
      "--paused",
      ...compileIgnores(options.ignores).flatMap((pattern) => ["--ignore", pattern]),
      "--",
      options.canonicalAlphaRoot,
      beta,
    ]);
  });

  it("fails closed when a session replaced after the pause carries different ignores", async () => {
    const replaced = session("watching", { ignores: [".git", "node_modules"] });
    const processes = new FakeProcesses([{}, { stdout: session("paused") }, {}, {}, { stdout: replaced }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([100]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    await expect(lifecycle.resumeAndFlush(paused)).rejects.toThrowError("Mutagen session ignore mismatch");
  });

  it("resumes only on explicit invocation, flushes, inspects, and returns measured transfer data", async () => {
    const processes = new FakeProcesses([{}, { stdout: session("paused") }, {}, {}, { stdout: session("watching") }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([100, 127]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list"]);
    const result = await lifecycle.resumeAndFlush(paused);

    expect(commandNames(processes)).toEqual(["daemon start", "sync list", "sync resume", "sync flush", "sync list"]);
    expect(result.session).toBe(paused);
    expect(result.flushDurationMs).toBe(27);
    expect(result.transferredBytes).toBeUndefined();
  });

  it.each([
    "watching",
    "scanning",
    "waiting-for-rescan",
    "reconciling",
    "staging-alpha",
    "staging-beta",
    "transitioning",
    "saving",
    "connecting-alpha",
    "connecting-beta",
  ])("accepts upstream active machine status %s after flush", async (status) => {
    const processes = new FakeProcesses([{}, { stdout: session("paused") }, {}, {}, { stdout: session(status) }]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([1, 2]));
    const paused = await lifecycle.pauseForGitReconcile(options);
    await expect(lifecycle.resumeAndFlush(paused)).resolves.toMatchObject({ flushDurationMs: 1 });
  });

  it("rejects excluded conflicts even when the ordinary conflict list is empty", async () => {
    const processes = new FakeProcesses([{}, { stdout: session("watching", { excludedConflicts: 1 }) }]);
    await expect(new MutagenSyncLifecycle(processes, new FakeClock([])).pauseForGitReconcile(options)).rejects.toThrow(
      /conflict/u,
    );
  });

  it("rejects unknown and structurally malformed upstream session models", async () => {
    for (const listing of [
      session("future-state"),
      JSON.stringify([{ name, alpha: {}, beta: { url: beta }, paused: false }]),
    ]) {
      const processes = new FakeProcesses([{}, { stdout: listing }]);
      await expect(
        new MutagenSyncLifecycle(processes, new FakeClock([])).pauseForGitReconcile(options),
      ).rejects.toThrow();
    }
  });

  it("rejects a descriptor on a different lifecycle before invoking its runtime", async () => {
    const ownerProcesses = new FakeProcesses([{}, { stdout: session("paused") }]);
    const owner = new MutagenSyncLifecycle(ownerProcesses, new FakeClock([]));
    const descriptor = await owner.pauseForGitReconcile(options);
    const wrongProcesses = new FakeProcesses([]);
    const wrong = new MutagenSyncLifecycle(wrongProcesses, new FakeClock([]));

    await expect(wrong.resumeAndFlush(descriptor)).rejects.toThrow(/descriptor/u);
    expect(wrongProcesses.requests).toEqual([]);
  });

  it("performs one bounded owned-session recovery after a disconnected flush", async () => {
    const processes = new FakeProcesses([
      {},
      { stdout: session("paused") },
      {},
      { exitCode: 1, stderr: "unable to flush" },
      { stdout: session("disconnected") },
      {},
      {},
      {},
      { stdout: session("watching") },
    ]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([10, 55]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    const result = await lifecycle.resumeAndFlush(paused);

    expect(commandNames(processes)).toEqual([
      "daemon start",
      "sync list",
      "sync resume",
      "sync flush",
      "sync list",
      "sync terminate",
      "sync create",
      "sync flush",
      "sync list",
    ]);
    expect(processes.requests[5]?.args).toEqual(["sync", "terminate", name]);
    expect(result.flushDurationMs).toBe(45);
    expect(result.transferredBytes).toBeUndefined();
  });

  it("performs the same single recovery when resume discovers a stale session", async () => {
    const processes = new FakeProcesses([
      {},
      { stdout: session("paused") },
      { exitCode: 1, stderr: "stale transport" },
      { stdout: session("halted-on-root-deletion") },
      {},
      {},
      {},
      { stdout: session("watching") },
    ]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([20, 30]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    const result = await lifecycle.resumeAndFlush(paused);

    expect(commandNames(processes)).toEqual([
      "daemon start",
      "sync list",
      "sync resume",
      "sync list",
      "sync terminate",
      "sync create",
      "sync flush",
      "sync list",
    ]);
    expect(result.flushDurationMs).toBe(10);
  });

  it("fails closed when the recovered session is still disconnected", async () => {
    const processes = new FakeProcesses([
      {},
      { stdout: session("paused") },
      {},
      {},
      { stdout: session("halted-on-root-empty") },
      {},
      {},
      {},
      { stdout: session("disconnected") },
    ]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([1]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    await expect(lifecycle.resumeAndFlush(paused)).rejects.toThrow(/recovery/u);
    expect(commandNames(processes).filter((command) => command === "sync terminate")).toHaveLength(1);
  });

  it("does not recover an ordinary flush failure or continue setup", async () => {
    const processes = new FakeProcesses([
      {},
      { stdout: session("paused") },
      {},
      { exitCode: 1, stderr: "permission denied" },
      { stdout: session("watching") },
    ]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([1]));
    const paused = await lifecycle.pauseForGitReconcile(options);

    await expect(lifecycle.resumeAndFlush(paused)).rejects.toThrow(/flush/u);
    expect(commandNames(processes)).not.toContain("sync terminate");
  });

  it.each([
    ["daemon failure", [{ exitCode: 1 }]],
    ["truncated list", [{}, { stdout: "", outputTruncated: true }]],
    ["oversized list", [{}, { stdout: "x".repeat(64 * 1024 + 1) }]],
    ["malformed list", [{}, { stdout: "not-json" }]],
  ] as const)("fails closed on %s", async (_label, outcomes) => {
    const processes = new FakeProcesses([...outcomes]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));
    await expect(lifecycle.pauseForGitReconcile(options)).rejects.toThrow();
  });

  it.each([
    ["relative alpha", { canonicalAlphaRoot: "relative" }],
    ["noncanonical alpha", { canonicalAlphaRoot: "/tmp/a/../b" }],
    ["target option", { betaTarget: "-oProxyCommand=bad" }],
    ["target NUL", { betaTarget: "host\0bad" }],
    ["relative beta", { betaRoot: "relative" }],
    ["beta traversal", { betaRoot: "/srv/a/../b" }],
  ] as const)("rejects hostile %s before starting Mutagen", async (_label, patch) => {
    const processes = new FakeProcesses([]);
    const lifecycle = new MutagenSyncLifecycle(processes, new FakeClock([]));

    await expect(lifecycle.pauseForGitReconcile({ ...options, ...patch })).rejects.toThrow();
    expect(processes.requests).toEqual([]);
  });
});

describe("owned session inspection", () => {
  const expected = {
    consumer: options.consumer,
    profile: options.profile,
    identity: options.identity,
    canonicalAlphaRoot: options.canonicalAlphaRoot,
    betaTarget: options.betaTarget,
    betaRoot: options.betaRoot,
    ignores: options.ignores,
  };

  it.each([
    ["a healthy session", session("watching")],
    ["a paused session", session("paused")],
    ["no owned session", "[]"],
    ["a foreign session under another name", session("watching", { name: "mutagen-other" })],
    ["a live v0.18 paused session", liveV018PausedSession()],
  ])("accepts %s", (_case, listing) => {
    expect(inspectOwnedSession(bytes(listing), expected)).toEqual({ status: "ok" });
  });

  it.each([
    ["alpha endpoint drift", session("watching", { alpha: "/Users/dev/other" }), "Mutagen session endpoint mismatch"],
    [
      "beta endpoint drift",
      session("watching", { beta: "runner@other.test:/srv" }),
      "Mutagen session endpoint mismatch",
    ],
    ["mode drift", session("watching", { mode: "two-way-safe" }), "Mutagen session mode mismatch"],
    ["conflicts", session("watching", { conflicts: [{}] }), "Mutagen session has conflicts"],
    ["excluded conflicts", session("watching", { excludedConflicts: 2 }), "Mutagen session has conflicts"],
    [
      "two sessions under the owned name",
      `[${session("watching").slice(1, -1)},${session("paused").slice(1, -1)}]`,
      "multiple Mutagen sessions have the owned name",
    ],
    ["a malformed listing", "{}", "Mutagen session list must return a JSON array"],
  ])("fails on %s", (_case, listing, detail) => {
    expect(inspectOwnedSession(bytes(listing), expected)).toEqual({ status: "fail", detail });
  });

  it("warns while the live session still excludes the pre-drift ignore set", () => {
    expect(inspectOwnedSession(bytes(session("watching", { ignores: [".git"] })), expected)).toEqual({
      status: "warn",
      detail: "Mutagen session ignores drifted; the next run recreates it",
    });
  });

  it.each([
    ["reports the endpoint as unverified", session("watching"), "Mutagen beta endpoint unverified"],
    [
      "still reports drift it can see",
      session("watching", { ignores: [".git"] }),
      "Mutagen session ignores drifted; the next run recreates it",
    ],
  ])("with no resolvable remote root %s", (_case, listing, detail) => {
    const { betaRoot: _betaRoot, ...unresolved } = expected;
    expect(inspectOwnedSession(bytes(listing), unresolved)).toEqual({ status: "warn", detail });
  });

  it.each([
    ["a disconnected session", session("disconnected")],
    ["a halted session", session("halted-on-root-emptied")],
  ])("warns on %s the next run recreates", (_case, listing) => {
    expect(inspectOwnedSession(bytes(listing), expected)).toEqual({
      status: "warn",
      detail: "Mutagen session is disconnected; the next run recreates it",
    });
  });

  it("never reports text the Mutagen listing supplied", () => {
    const hostile = session("secret-canary-status");
    expect(inspectOwnedSession(bytes(hostile), expected)).toEqual({
      status: "fail",
      detail: "Mutagen session inspection failed",
    });
  });
});
