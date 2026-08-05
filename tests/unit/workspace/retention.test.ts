import { describe, expect, it } from "vitest";

import {
  planWorkspaceRetention,
  pruneRemoteWorkspaces,
  RemoteWorkspaceRetentionRuntime,
  type WorkspaceRetentionCommandPort,
  type WorkspaceRetentionRuntime,
} from "../../../src/workspace/retention.js";

const minute = 60_000;
const nowMs = 2_000_000_000_000;

function identity(value: number): string {
  return value.toString(16).padStart(24, "0");
}

describe("planWorkspaceRetention", () => {
  it("reserves the current identity, keeps the newest valid identities, and protects grace entries", () => {
    const current = identity(1);
    const recent = identity(2);
    const newest = identity(3);
    const nextNewest = identity(4);
    const stale = identity(5);
    const legacyWithoutMarker = identity(6);

    const plan = planWorkspaceRetention(
      [
        { identity: current, activityMs: nowMs - 10_000 * minute },
        { identity: recent, activityMs: nowMs - 30 * minute },
        { identity: newest, activityMs: nowMs - 61 * minute },
        { identity: nextNewest, activityMs: nowMs - 62 * minute },
        { identity: stale, activityMs: nowMs - 63 * minute },
        { identity: legacyWithoutMarker, activityMs: nowMs - 64 * minute },
        { identity: "../../hostile", activityMs: nowMs },
        { identity: "ABCDEFABCDEFABCDEFABCDEF", activityMs: nowMs },
        { identity: "abcdef", activityMs: nowMs },
      ],
      current,
      { keep: 3, graceMinutes: 60 },
      nowMs,
    );

    expect(plan).toEqual({
      retained: [current, recent, newest],
      graceProtected: [],
      candidates: [nextNewest, stale, legacyWithoutMarker],
    });
  });

  it("grace-protects recent identities that fall outside the keep budget", () => {
    const current = identity(10);
    const recent = identity(11);
    const kept = identity(12);
    const stale = identity(13);

    expect(
      planWorkspaceRetention(
        [
          { identity: current, activityMs: nowMs - 4 * minute },
          { identity: kept, activityMs: nowMs - 2 * minute },
          { identity: recent, activityMs: nowMs - 30 * minute },
          { identity: stale, activityMs: nowMs - 61 * minute },
        ],
        current,
        { keep: 2, graceMinutes: 60 },
        nowMs,
      ),
    ).toEqual({
      retained: [current, kept],
      graceProtected: [recent],
      candidates: [stale],
    });
  });

  it("sorts equal timestamps by identity and rejects unsafe numeric input", () => {
    const current = identity(20);
    const lower = identity(21);
    const higher = identity(22);

    expect(
      planWorkspaceRetention(
        [
          { identity: higher, activityMs: nowMs - 2 * minute },
          { identity: lower, activityMs: nowMs - 2 * minute },
          { identity: current, activityMs: nowMs - minute },
        ],
        current,
        { keep: 2, graceMinutes: 1 },
        nowMs,
      ),
    ).toEqual({
      retained: [current, lower],
      graceProtected: [],
      candidates: [higher],
    });

    expect(() =>
      planWorkspaceRetention(
        [{ identity: current, activityMs: Number.NaN }],
        current,
        { keep: 1, graceMinutes: 1 },
        nowMs,
      ),
    ).toThrow(/activity/i);
    expect(() => planWorkspaceRetention([], current, { keep: 1, graceMinutes: 1 }, Number.MAX_VALUE)).toThrow(/now/i);
  });
});

describe("pruneRemoteWorkspaces", () => {
  it("quarantines candidates under a lock before exact sync and metadata cleanup", async () => {
    const current = identity(30);
    const stale = identity(31);
    const calls: string[] = [];
    const runtime: WorkspaceRetentionRuntime = {
      async list() {
        calls.push("list");
        return [
          { kind: "directory", identity: current, activityMs: nowMs },
          { kind: "directory", identity: stale, activityMs: nowMs - 61 * minute },
        ];
      },
      async withQuarantine(target, quarantine, existing, _graceCutoffMs, cleanup) {
        calls.push(`quarantine:${target}:${quarantine}:${existing}`);
        await cleanup();
        calls.push(`remove-lock:${target}`);
        return "removed";
      },
      async terminateOwnedSync(target) {
        calls.push(`terminate:${target}`);
      },
      async removeQuarantine(quarantine) {
        calls.push(`remove-quarantine:${quarantine}`);
      },
      async removeActivity(target) {
        calls.push(`remove-activity:${target}`);
      },
      async removeSetupState(target) {
        calls.push(`remove-setup:${target}`);
      },
      async removePrivateRef(target) {
        calls.push(`remove-ref:${target}`);
      },
    };

    const result = await pruneRemoteWorkspaces(
      runtime,
      current,
      { keep: 1, graceMinutes: 60 },
      nowMs,
      () => "0123456789abcdef",
    );

    const quarantine = `.gc-${stale}-0123456789abcdef`;
    expect(calls).toEqual([
      "list",
      `quarantine:${stale}:${quarantine}:false`,
      `terminate:${stale}`,
      `remove-ref:${stale}`,
      `remove-quarantine:${quarantine}`,
      `remove-activity:${stale}`,
      `remove-setup:${stale}`,
      `remove-lock:${stale}`,
    ]);
    expect(result).toEqual({ retained: 1, graceProtected: 0, locked: 0, removed: 1, failed: 0, ignored: 0 });
  });

  it("resumes quarantines, skips locked and unsafe entries, and continues after a bounded failure", async () => {
    const current = identity(40);
    const remnant = identity(41);
    const locked = identity(42);
    const failed = identity(43);
    const removed = identity(44);
    const refreshed = identity(45);
    const calls: string[] = [];
    const runtime: WorkspaceRetentionRuntime = {
      async list() {
        calls.push("list");
        return [
          { kind: "directory", identity: current, activityMs: nowMs },
          { kind: "quarantine", identity: remnant, activityMs: 0, quarantineName: `.gc-${remnant}-aaaaaaaaaaaaaaaa` },
          { kind: "directory", identity: locked, activityMs: nowMs - 61 * minute },
          { kind: "directory", identity: failed, activityMs: nowMs - 62 * minute },
          { kind: "directory", identity: removed, activityMs: nowMs - 63 * minute },
          { kind: "directory", identity: refreshed, activityMs: nowMs - 64 * minute },
          { kind: "unsafe", identity: "symlink", activityMs: 0 },
        ];
      },
      async withQuarantine(target, _quarantine, existing, _graceCutoffMs, cleanup) {
        calls.push(`quarantine:${target}:${existing}`);
        if (target === locked) return "locked";
        if (target === refreshed) return "refreshed";
        if (target === failed) throw new Error("bounded candidate failure");
        await cleanup();
        calls.push(`remove-lock:${target}`);
        return "removed";
      },
      async terminateOwnedSync(target) {
        calls.push(`terminate:${target}`);
      },
      async removeQuarantine(quarantine) {
        calls.push(`remove-quarantine:${quarantine}`);
      },
      async removeActivity(target) {
        calls.push(`remove-activity:${target}`);
      },
      async removeSetupState(target) {
        calls.push(`remove-setup:${target}`);
      },
      async removePrivateRef(target) {
        calls.push(`remove-ref:${target}`);
      },
    };

    const result = await pruneRemoteWorkspaces(
      runtime,
      current,
      { keep: 1, graceMinutes: 60 },
      nowMs,
      () => "bbbbbbbbbbbbbbbb",
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        `quarantine:${remnant}:true`,
        `terminate:${remnant}`,
        `quarantine:${locked}:false`,
        `quarantine:${failed}:false`,
        `quarantine:${removed}:false`,
        `terminate:${removed}`,
        `quarantine:${refreshed}:false`,
      ]),
    );
    expect(result).toEqual({ retained: 1, graceProtected: 1, locked: 1, removed: 2, failed: 1, ignored: 1 });
  });
});

describe("RemoteWorkspaceRetentionRuntime", () => {
  it("rechecks fresh activity before resuming an existing quarantine", async () => {
    const target = identity(49);
    let command: readonly string[] | undefined;
    let cleaned = false;
    const port: WorkspaceRetentionCommandPort = {
      async run() {
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
      async withLock(args) {
        command = args;
        return "refreshed";
      },
    };
    const runtime = new RemoteWorkspaceRetentionRuntime(
      port,
      {
        profileRoot: "/profiles/verify-full",
        setupStateRoot: "/state/verify-full",
        mirror: "/profiles/.mirror.git",
        privateRefPrefix: "refs/remote-runner/ariadne/verify-full",
      },
      async () => undefined,
    );

    await expect(
      runtime.withQuarantine(target, `.gc-${target}-eeeeeeeeeeeeeeee`, true, nowMs - minute, async () => {
        cleaned = true;
      }),
    ).resolves.toBe("refreshed");

    const script = command?.[2] ?? "";
    expect(script.indexOf('stat -c %Y -- "$activity"')).toBeGreaterThan(-1);
    expect(script.indexOf('stat -c %Y -- "$activity"')).toBeLessThan(script.indexOf('if [ "$existing" = 1 ]'));
    expect(cleaned).toBe(false);
  });

  it("uses confined fixed-argv commands and parses only bounded NUL records", async () => {
    const current = identity(50);
    const remnant = identity(51);
    const commands: readonly string[][] = [] as string[][];
    const mutableCommands = commands as string[][];
    const encoded = new TextEncoder().encode(
      `d\0${current}\0${Math.floor(nowMs / 1000)}\0q\0.gc-${remnant}-cccccccccccccccc\0${0}\0u\0hostile\0${0}\0`,
    );
    const port: WorkspaceRetentionCommandPort = {
      async run(args) {
        mutableCommands.push([...args]);
        return { exitCode: 0, stdout: encoded, stderr: new Uint8Array() };
      },
      async withLock(args, cleanup) {
        mutableCommands.push([...args]);
        await cleanup();
        return "removed";
      },
    };
    const terminated: string[] = [];
    const runtime = new RemoteWorkspaceRetentionRuntime(
      port,
      {
        profileRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full",
        setupStateRoot: "/home/admin/.local/state/remote-runner/profiles/ariadne/verify-full",
        mirror: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/.mirror.git",
        privateRefPrefix: "refs/remote-runner/ariadne/verify-full",
      },
      async (target) => {
        terminated.push(target);
      },
    );

    expect(await runtime.list()).toEqual([
      { kind: "directory", identity: current, activityMs: Math.floor(nowMs / 1000) * 1000 },
      {
        kind: "quarantine",
        identity: remnant,
        quarantineName: `.gc-${remnant}-cccccccccccccccc`,
        activityMs: 0,
      },
      { kind: "unsafe", identity: "hostile", activityMs: 0 },
    ]);
    await runtime.withQuarantine(current, `.gc-${current}-dddddddddddddddd`, false, nowMs - minute, async () => {
      await runtime.terminateOwnedSync(current);
      await runtime.removePrivateRef(current);
      await runtime.removeQuarantine(`.gc-${current}-dddddddddddddddd`);
      await runtime.removeActivity(current);
      await runtime.removeSetupState(current);
    });

    expect(terminated).toEqual([current]);
    expect(commands[0]?.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    expect(commands[0]).toContain("/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full");
    expect(commands[1]).toEqual(
      expect.arrayContaining([
        "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/.locks/" + current,
        "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/" + current,
        "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/.gc-" +
          current +
          "-dddddddddddddddd",
        "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/verify-full/.activity/" + current,
        String(Math.floor((nowMs - minute) / 1000)),
      ]),
    );
    expect(commands[1]?.[2]).toContain("flock -n 9");
    expect(commands[1]?.[2]).toContain('stat -c %Y -- "$activity"');
    expect(commands.at(-1)).toEqual([
      "rm",
      "-rf",
      "--",
      "/home/admin/.local/state/remote-runner/profiles/ariadne/verify-full/" + current,
    ]);
    expect(commands.find((command) => command[3] === "remote-runner-private-ref")).toEqual([
      "sh",
      "-ceu",
      'test -d "$1" || exit 0; exec git -c core.hooksPath=/dev/null --git-dir="$1" update-ref -d "$2"',
      "remote-runner-private-ref",
      "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces/ariadne/.mirror.git",
      `refs/remote-runner/ariadne/verify-full/${current}`,
    ]);
  });

  it("rejects a private ref prefix that is not exactly consumer and profile", async () => {
    const port: WorkspaceRetentionCommandPort = {
      async run() {
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
      async withLock() {
        return "removed";
      },
    };
    const paths = {
      profileRoot: "/profiles/verify-full",
      setupStateRoot: "/state/verify-full",
      mirror: "/profiles/.mirror.git",
    };

    expect(
      () =>
        new RemoteWorkspaceRetentionRuntime(
          port,
          { ...paths, privateRefPrefix: "refs/remote-runner/ariadne" },
          async () => undefined,
        ),
    ).toThrow(/private ref prefix/u);
    expect(
      () =>
        new RemoteWorkspaceRetentionRuntime(
          port,
          { ...paths, privateRefPrefix: "refs/remote-runner/ariadne/verify-full/../../heads" },
          async () => undefined,
        ),
    ).toThrow(/private ref prefix/u);
  });
});
