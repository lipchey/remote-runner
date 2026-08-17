import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/* Runs the listing argv for real instead of faking its stdout. Substring assertions on a generated
   script survive any change that keeps the token and breaks the behaviour — dropping the clock
   `printf`, moving it after `find`, or breaking its quoting all leave the spelling intact. */
function localCommandPort(): WorkspaceRetentionCommandPort {
  return {
    async run(args) {
      const [command, ...rest] = args;
      const result = spawnSync(command!, rest, { maxBuffer: 1024 * 1024 });
      return {
        exitCode: result.status ?? 1,
        stdout: new Uint8Array(result.stdout ?? []),
        stderr: new Uint8Array(result.stderr ?? []),
      };
    },
    async withLock() {
      return "removed";
    },
  };
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
        return {
          nowMs,
          entries: [
            { kind: "directory", identity: current, activityMs: nowMs },
            { kind: "directory", identity: stale, activityMs: nowMs - 61 * minute },
          ],
        };
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
      async isIdentityDead() {
        return true;
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
        return {
          nowMs,
          entries: [
            { kind: "directory", identity: current, activityMs: nowMs },
            { kind: "quarantine", identity: remnant, activityMs: 0, quarantineName: `.gc-${remnant}-aaaaaaaaaaaaaaaa` },
            { kind: "directory", identity: locked, activityMs: nowMs - 61 * minute },
            { kind: "directory", identity: failed, activityMs: nowMs - 62 * minute },
            { kind: "directory", identity: removed, activityMs: nowMs - 63 * minute },
            { kind: "directory", identity: refreshed, activityMs: nowMs - 64 * minute },
            { kind: "unsafe", identity: "symlink", activityMs: 0 },
          ],
        };
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
      async isIdentityDead(target) {
        calls.push(`liveness:${target}`);
        return true;
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

  it("derives the grace window from the listing clock, not the local one", async () => {
    const current = identity(60);
    const active = identity(61);
    const stale = identity(62);
    /* Deliberately unlike any local clock: an implementation reading Date.now() puts the cutoff
       years ahead of every activity marker here, and collects the actively preparing workspace. */
    const remoteNowMs = 1_600_000_000_000;
    const quarantined: { identity: string; graceCutoffMs: number }[] = [];
    const runtime: WorkspaceRetentionRuntime = {
      async list() {
        return {
          nowMs: remoteNowMs,
          entries: [
            { kind: "directory", identity: current, activityMs: remoteNowMs },
            { kind: "directory", identity: active, activityMs: remoteNowMs - 10 * minute },
            { kind: "directory", identity: stale, activityMs: remoteNowMs - 61 * minute },
          ],
        };
      },
      async withQuarantine(target, _quarantine, _existing, graceCutoffMs, cleanup) {
        quarantined.push({ identity: target, graceCutoffMs });
        await cleanup();
        return "removed";
      },
      async terminateOwnedSync() {},
      async isIdentityDead() {
        return true;
      },
      async removeQuarantine() {},
      async removeActivity() {},
      async removeSetupState() {},
      async removePrivateRef() {},
    };

    const result = await pruneRemoteWorkspaces(runtime, current, { keep: 1, graceMinutes: 60 }, () => "0".repeat(16));

    expect(quarantined).toEqual([{ identity: stale, graceCutoffMs: remoteNowMs - 60 * minute }]);
    expect(result).toEqual({ retained: 1, graceProtected: 1, locked: 0, removed: 1, failed: 0, ignored: 0 });
  });

  it("reclaims a live identity's own quarantine and leaves its identity-scoped state alone", async () => {
    const current = identity(70);
    const revived = identity(71);
    const calls: string[] = [];
    const runtime: WorkspaceRetentionRuntime = {
      async list() {
        return {
          nowMs,
          entries: [
            { kind: "directory", identity: current, activityMs: nowMs },
            {
              kind: "quarantine",
              identity: current,
              activityMs: 0,
              quarantineName: `.gc-${current}-aaaaaaaaaaaaaaaa`,
            },
            { kind: "directory", identity: revived, activityMs: nowMs - 61 * minute },
            {
              kind: "quarantine",
              identity: revived,
              activityMs: 0,
              quarantineName: `.gc-${revived}-bbbbbbbbbbbbbbbb`,
            },
          ],
        };
      },
      async withQuarantine(target, quarantine, existing, _graceCutoffMs, cleanup) {
        calls.push(`quarantine:${target}:${quarantine}:${existing}`);
        await cleanup();
        return "removed";
      },
      async terminateOwnedSync(target) {
        calls.push(`terminate:${target}`);
      },
      /* The listing said the workspace was gone; this later answer is what must decide, or a
         resurrected identity loses the state it is using right now. */
      async isIdentityDead(target) {
        calls.push(`liveness:${target}`);
        return false;
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

    const result = await pruneRemoteWorkspaces(runtime, current, { keep: 2, graceMinutes: 60 }, () => "0".repeat(16));

    expect(calls).toEqual([
      `quarantine:${current}:.gc-${current}-aaaaaaaaaaaaaaaa:true`,
      `liveness:${current}`,
      `remove-quarantine:.gc-${current}-aaaaaaaaaaaaaaaa`,
      `quarantine:${revived}:.gc-${revived}-bbbbbbbbbbbbbbbb:true`,
      `liveness:${revived}`,
      `remove-quarantine:.gc-${revived}-bbbbbbbbbbbbbbbb`,
    ]);
    expect(result).toEqual({ retained: 2, graceProtected: 0, locked: 0, removed: 2, failed: 0, ignored: 0 });
  });
});

describe("RemoteWorkspaceRetentionRuntime", () => {
  it("refuses fresh activity when creating a quarantine and exempts the resume path from that refusal", async () => {
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
      runtime.withQuarantine(target, `.gc-${target}-eeeeeeeeeeeeeeee`, false, nowMs - minute, async () => {
        cleaned = true;
      }),
    ).resolves.toBe("refreshed");

    const script = command?.[2] ?? "";
    /* Without the `existing` gate a leftover quarantine of an identity that still dispatches is
       refused on every pass and no run ever reclaims it. */
    expect(script).toContain('if [ "$existing" != 1 ] && [ -f "$activity" ]');
    expect(script.indexOf('stat -c %Y -- "$activity"')).toBeLessThan(script.indexOf('if [ "$existing" = 1 ]'));
    expect(cleaned).toBe(false);
  });

  it("reads liveness under the lock and calls anything it cannot classify alive", async () => {
    const target = identity(52);
    const commands: string[][] = [];
    let exitCode = 0;
    const port: WorkspaceRetentionCommandPort = {
      async run(args) {
        commands.push([...args]);
        return { exitCode, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
      async withLock() {
        return "removed";
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

    await expect(runtime.isIdentityDead(target, nowMs - minute)).resolves.toBe(true);
    exitCode = 1;
    await expect(runtime.isIdentityDead(target, nowMs - minute)).resolves.toBe(false);
    exitCode = 127;
    await expect(runtime.isIdentityDead(target, nowMs - minute)).resolves.toBe(false);
    await expect(runtime.isIdentityDead("../escape", nowMs)).rejects.toThrow(/identity/iu);

    expect(commands[0]?.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    expect(commands[0]).toEqual(
      expect.arrayContaining([
        `/profiles/verify-full/${target}`,
        `/profiles/verify-full/.activity/${target}`,
        String(Math.floor((nowMs - minute) / 1000)),
      ]),
    );
    expect(commands[0]?.[2]).toContain('[ ! -e "$workspace" ] && [ ! -L "$workspace" ]');
  });

  it("runs the liveness script for real and calls every unclassifiable path alive", async () => {
    const profileRoot = await realpath(await mkdtemp(join(tmpdir(), "retention-liveness-")));
    temporaryRoots.push(profileRoot);
    const runtime = new RemoteWorkspaceRetentionRuntime(
      localCommandPort(),
      {
        profileRoot,
        setupStateRoot: profileRoot,
        mirror: `${profileRoot}/.mirror.git`,
        privateRefPrefix: "refs/remote-runner/ariadne/verify-full",
      },
      async () => undefined,
    );
    const cutoff = nowMs - minute;
    const dead = identity(80);
    const present = identity(81);
    const dangling = identity(82);
    const danglingMarker = identity(83);
    const linkedMarker = identity(84);

    await mkdir(join(profileRoot, present));
    await mkdir(join(profileRoot, ".activity"));
    await writeFile(join(profileRoot, "elsewhere"), "");
    spawnSync("ln", ["-s", join(profileRoot, "nowhere"), join(profileRoot, dangling)]);
    spawnSync("ln", ["-s", join(profileRoot, "nowhere"), join(profileRoot, ".activity", danglingMarker)]);
    spawnSync("ln", ["-s", join(profileRoot, "elsewhere"), join(profileRoot, ".activity", linkedMarker)]);

    await expect(runtime.isIdentityDead(dead, cutoff)).resolves.toBe(true);
    await expect(runtime.isIdentityDead(present, cutoff)).resolves.toBe(false);
    /* `-e` alone answers false for a dangling link, and "dead" is the answer that authorises
       deleting the identity's Mutagen session, private ref, marker and setup state. */
    await expect(runtime.isIdentityDead(dangling, cutoff)).resolves.toBe(false);
    await expect(runtime.isIdentityDead(danglingMarker, cutoff)).resolves.toBe(false);
    await expect(runtime.isIdentityDead(linkedMarker, cutoff)).resolves.toBe(false);
  });

  it("uses confined fixed-argv commands and parses only bounded NUL records", async () => {
    const current = identity(50);
    const remnant = identity(51);
    const commands: readonly string[][] = [] as string[][];
    const mutableCommands = commands as string[][];
    const remoteClockSeconds = Math.floor(nowMs / 1000) + 7;
    const encoded = new TextEncoder().encode(
      `${remoteClockSeconds}\0d\0${current}\0${Math.floor(nowMs / 1000)}\0q\0.gc-${remnant}-cccccccccccccccc\0${0}\0u\0hostile\0${0}\0`,
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

    expect(await runtime.list()).toEqual({
      nowMs: remoteClockSeconds * 1000,
      entries: [
        { kind: "directory", identity: current, activityMs: Math.floor(nowMs / 1000) * 1000 },
        {
          kind: "quarantine",
          identity: remnant,
          quarantineName: `.gc-${remnant}-cccccccccccccccc`,
          activityMs: 0,
        },
        { kind: "unsafe", identity: "hostile", activityMs: 0 },
      ],
    });
    await runtime.withQuarantine(current, `.gc-${current}-dddddddddddddddd`, false, nowMs - minute, async () => {
      await runtime.terminateOwnedSync(current);
      await runtime.removePrivateRef(current);
      await runtime.removeQuarantine(`.gc-${current}-dddddddddddddddd`);
      await runtime.removeActivity(current);
      await runtime.removeSetupState(current);
    });

    expect(terminated).toEqual([current]);
    expect(commands[0]?.slice(0, 3)).toEqual(["sh", "-ceu", expect.any(String)]);
    /* The clock record the parser consumes is emitted by this script and by nothing else, so
       dropping it here turns every real listing into a partial-records failure. */
    expect(commands[0]?.[2]).toContain('printf "%s\\0" "$(date +%s)"');
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

  it("reads the clock from the listing script it actually runs", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "remote-runner-retention-")));
    temporaryRoots.push(root);
    const remnant = identity(70);
    const quarantineName = `.gc-${remnant}-ffffffffffffffff`;
    /* A quarantine entry, not an identity directory: the inner script reports it without calling
       `stat -c %Y`, so this covers clock-then-entries ordering on a host without GNU coreutils. */
    await mkdir(join(root, quarantineName), { recursive: true });
    const runtime = new RemoteWorkspaceRetentionRuntime(
      localCommandPort(),
      {
        profileRoot: root,
        setupStateRoot: "/state/verify-full",
        mirror: "/profiles/.mirror.git",
        privateRefPrefix: "refs/remote-runner/ariadne/verify-full",
      },
      async () => undefined,
    );

    const before = Math.floor(Date.now() / 1000) * 1000;
    const listing = await runtime.list();
    const after = Math.ceil(Date.now() / 1000) * 1000;

    expect(listing.nowMs).toBeGreaterThanOrEqual(before);
    expect(listing.nowMs).toBeLessThanOrEqual(after);
    expect(listing.entries).toEqual([{ kind: "quarantine", identity: remnant, quarantineName, activityMs: 0 }]);
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
