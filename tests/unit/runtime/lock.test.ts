import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireProfileLock,
  LockTimeoutError,
  type LockFileSystem,
  type LockRuntime,
} from "../../../src/runtime/lock.js";

interface SeedOwner {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly leaseUntil: number;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class NodeLockFiles implements LockFileSystem {
  async mkdir(path: string): Promise<void> {
    await mkdir(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async writeFile(path: string, contents: Uint8Array, mode: number): Promise<void> {
    await writeFile(path, contents, { flag: "wx", mode });
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true });
  }

  async symlink(target: string, path: string): Promise<void> {
    await symlink(target, path, "dir");
  }

  async readlink(path: string): Promise<string> {
    return readlink(path);
  }

  async readdir(path: string): Promise<readonly string[]> {
    return readdir(path);
  }

  async modifiedAt(path: string): Promise<number> {
    return (await lstat(path)).mtimeMs;
  }
}

class MemoryLockFiles implements LockFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  readonly links = new Map<string, string>();
  readonly times = new Map<string, number>();
  readonly diagnostics: string[] = [];
  readonly renames: Array<{ readonly from: string; readonly to: string; readonly ownerToken?: string }> = [];
  beforeReadFile?: (path: string) => Promise<void>;
  beforeMkdir?: (path: string) => Promise<void>;
  beforeRemove?: (path: string) => Promise<void>;
  beforeWriteFile?: (path: string) => Promise<void>;
  beforeRename?: (from: string, to: string) => Promise<void>;
  beforeReadlink?: (path: string) => Promise<void>;

  async mkdir(path: string): Promise<void> {
    await this.beforeMkdir?.(path);
    if (this.exists(path)) throw fileError("EEXIST");
    /* Resolving through the canonical name, not merely observing it, is what models a dangling
       symlink: the link exists while the directory it names does not. */
    if (path.startsWith(`${lockPath}/`) && !this.directories.has(this.resolve(lockPath))) {
      throw fileError("ENOENT");
    }
    this.directories.add(this.resolve(path));
  }

  async readlink(path: string): Promise<string> {
    await this.beforeReadlink?.(path);
    const target = this.links.get(path);
    if (target === undefined) throw fileError("EINVAL");
    return target;
  }

  async readdir(path: string): Promise<readonly string[]> {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const entry of [...this.directories, ...this.links.keys()]) {
      if (!entry.startsWith(prefix)) continue;
      const name = entry.slice(prefix.length);
      if (!name.includes("/")) names.add(name);
    }
    return [...names];
  }

  async modifiedAt(path: string): Promise<number> {
    if (!this.exists(path)) throw fileError("ENOENT");
    return this.times.get(path) ?? 0;
  }

  async readFile(path: string): Promise<Uint8Array> {
    await this.beforeReadFile?.(path);
    const value = this.files.get(this.resolve(path));
    if (!value) throw fileError("ENOENT");
    return value;
  }

  async writeFile(path: string, contents: Uint8Array, _mode: number): Promise<void> {
    await this.beforeWriteFile?.(path);
    this.files.set(this.resolve(path), contents);
  }

  async symlink(target: string, path: string): Promise<void> {
    if (this.exists(path)) throw fileError("EEXIST");
    if (!this.directories.has(target)) throw fileError("ENOENT");
    this.links.set(path, target);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.beforeRename?.(from, to);
    if (this.exists(to)) throw fileError("EEXIST");
    const ownerToken = this.ownerToken(from);
    const linkTarget = this.links.get(from);
    if (linkTarget !== undefined) {
      this.links.delete(from);
      this.links.set(to, linkTarget);
      this.renames.push({ from, to, ...(ownerToken === undefined ? {} : { ownerToken }) });
      if (to.includes(".stale-") || to.includes(".corrupt-")) this.diagnostics.push(to);
      return;
    }
    if (!this.directories.has(from)) throw fileError("ENOENT");
    const movedDirectories = [...this.directories].filter((path) => path === from || path.startsWith(`${from}/`));
    for (const path of movedDirectories) {
      this.directories.delete(path);
      this.directories.add(`${to}${path.slice(from.length)}`);
    }
    const movedFiles = [...this.files].filter(([path]) => path.startsWith(`${from}/`));
    for (const [path, contents] of movedFiles) {
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, contents);
    }
    this.renames.push({ from, to, ...(ownerToken === undefined ? {} : { ownerToken }) });
    if (to.includes(".stale-") || to.includes(".corrupt-")) this.diagnostics.push(to);
  }

  async remove(path: string): Promise<void> {
    await this.beforeRemove?.(path);
    if (this.links.delete(path)) return;
    const resolved = this.resolve(path);
    if (!this.directories.has(resolved)) throw fileError("ENOENT");
    for (const directory of [...this.directories]) {
      if (directory === resolved || directory.startsWith(`${resolved}/`)) {
        this.directories.delete(directory);
      }
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${resolved}/`)) this.files.delete(file);
    }
  }

  seed(path: string, owner: SeedOwner | string): void {
    this.links.delete(path);
    this.directories.add(path);
    this.files.set(
      `${path}/owner.json`,
      new TextEncoder().encode(typeof owner === "string" ? owner : JSON.stringify(owner)),
    );
  }

  ownerToken(path: string): string | undefined {
    const contents = this.files.get(this.resolve(`${path}/owner.json`));
    if (!contents) return undefined;
    try {
      return (JSON.parse(new TextDecoder().decode(contents)) as { token?: string }).token;
    } catch {
      return undefined;
    }
  }

  exists(path: string): boolean {
    return this.links.has(path) || this.directories.has(this.resolve(path));
  }

  private resolve(path: string): string {
    for (const [link, target] of this.links) {
      if (path === link || path.startsWith(`${link}/`)) return `${target}${path.slice(link.length)}`;
    }
    return path;
  }
}

const fileError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const lockPath = "/locks/ariadne--identity.lock";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function runtime(
  files: LockFileSystem,
  options: {
    readonly alive?: readonly number[];
    readonly now?: number;
    readonly onSleep?: () => Promise<void>;
    readonly pid?: number;
    readonly path?: string;
    readonly token?: string;
  } = {},
): LockRuntime & { readonly sleeps: number[] } {
  let now = options.now ?? 0;
  const sleeps: number[] = [];
  const alive = new Set(options.alive ?? []);
  return {
    files,
    processes: { isAlive: async (pid) => alive.has(pid) },
    clock: {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        await options.onSleep?.();
        now += milliseconds;
      },
    },
    lockDirectory: () => options.path ?? lockPath,
    pid: options.pid ?? 42,
    leaseDurationMs: 1_000,
    pollIntervalMs: 100,
    createToken: () => options.token ?? "ours-unique-token",
    sleeps,
  };
}

describe("acquireProfileLock", () => {
  it("times out within the caller budget and never steals from a live owner", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    const adapter = runtime(files, { alive: [7], now: 20 });

    await expect(acquireProfileLock(adapter, "ariadne/identity", 250)).rejects.toBeInstanceOf(LockTimeoutError);

    expect(adapter.sleeps).toEqual([100, 100, 50]);
    expect(files.diagnostics).toEqual([]);
    expect(files.exists(lockPath)).toBe(true);
  });

  it("reclaims a dead owner's lock without waiting out its lease", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 120_000 });
    const adapter = runtime(files, { now: 5 });

    const release = await acquireProfileLock(adapter, "ariadne/identity", 500);

    expect(adapter.sleeps).toEqual([]);
    expect(files.diagnostics[0]).toContain(".stale-");
    await release();
  });

  it("waits between attempts when the published lock vanishes mid-check", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    files.beforeMkdir = async (path) => {
      if (path === `${lockPath}/.operation`) throw fileError("ENOENT");
    };
    const adapter = runtime(files, { alive: [7], now: 20 });

    await expect(acquireProfileLock(adapter, "ariadne/identity", 250)).rejects.toBeInstanceOf(LockTimeoutError);

    expect(adapter.sleeps).toEqual([100, 100, 50]);
  });

  it("recovers once the owner process is absent", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    const adapter = runtime(files, { now: 20 });

    const release = await acquireProfileLock(adapter, "ariadne/identity", 500);

    expect(files.diagnostics).toHaveLength(1);
    expect(files.diagnostics[0]).toContain(".stale-");
    expect(JSON.parse(new TextDecoder().decode(await files.readFile(`${lockPath}/owner.json`)))).toEqual({
      token: "ours-unique-token",
      pid: 42,
      acquiredAt: 20,
      leaseUntil: 1_020,
    });
    await release();
    expect(files.exists(lockPath)).toBe(false);
  });

  it("renames a corrupt lock diagnostically before retrying", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, "{not-json");

    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);

    expect(files.diagnostics).toHaveLength(1);
    expect(files.diagnostics[0]).toContain(".corrupt-");
    await release();
  });

  it("does not quarantine a lock when owner metadata cannot be read", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    files.beforeReadFile = async (path) => {
      if (path === `${lockPath}/owner.json`) throw fileError("EACCES");
    };

    await expect(acquireProfileLock(runtime(files), "ariadne/identity", 50)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(files.diagnostics).toEqual([]);
    expect(files.ownerToken(lockPath)).toBe("theirs");
  });

  it("retains an existing empty POSIX lock directory before publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-lock-posix-"));
    temporaryRoots.push(root);
    const path = join(root, "profile.lock");
    await mkdir(path);
    const files = new NodeLockFiles();

    const release = await acquireProfileLock(runtime(files, { path, token: "posix-owner" }), "ariadne/identity", 50);

    const entries = await readdir(root);
    const diagnosticEntries = entries.filter((entry) => entry.startsWith("profile.lock.corrupt-"));
    expect(diagnosticEntries).toHaveLength(1);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({
      token: "posix-owner",
    });
    await release();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual(diagnosticEntries);
  });

  it("release leaves a successor lock whose ownership token differs", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    files.seed(lockPath, { token: "successor", pid: 99, acquiredAt: 1, leaseUntil: 1_001 });

    await release();

    expect(files.exists(lockPath)).toBe(true);
  });

  it("rethrows a release rename failure and retries cleanup", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    let failRename = true;
    files.beforeRename = async (_from, to) => {
      if (failRename && to.includes(".release-")) throw fileError("EIO");
    };

    await expect(release()).rejects.toMatchObject({ code: "EIO" });
    failRename = false;
    await release();

    expect(files.exists(lockPath)).toBe(false);
    expect([...files.directories].filter((path) => path.includes(".generation-"))).toEqual([]);
  });

  it("rethrows a release remove failure and resumes its cleanup phase", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    let failRemove = true;
    files.beforeRemove = async (path) => {
      if (failRemove && path.includes(".release-")) throw fileError("EIO");
    };

    await expect(release()).rejects.toMatchObject({ code: "EIO" });
    failRemove = false;
    await release();

    expect(files.exists(lockPath)).toBe(false);
    expect([...files.directories].filter((path) => path.includes(".generation-"))).toEqual([]);
    expect([...files.links].filter(([path]) => path.includes(".release-"))).toEqual([]);
  });

  it("rejects retryably when release finds the operation guard busy", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    await files.mkdir(`${lockPath}/.operation`);

    await expect(release()).rejects.toThrow("release retry required");
    expect(files.exists(lockPath)).toBe(true);

    await files.remove(`${lockPath}/.operation`);
    await release();
    expect(files.exists(lockPath)).toBe(false);
  });

  it("rejects retryably when the canonical lock disappears during guard creation", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    let missGuard = true;
    files.beforeMkdir = async (path) => {
      if (missGuard && path === `${lockPath}/.operation`) throw fileError("ENOENT");
    };

    await expect(release()).rejects.toThrow("release retry required");
    expect(files.exists(lockPath)).toBe(true);

    missGuard = false;
    await release();
    expect(files.exists(lockPath)).toBe(false);
  });

  it("rejects retryably when owner metadata disappears while the canonical lock remains", async () => {
    const files = new MemoryLockFiles();
    const release = await acquireProfileLock(runtime(files), "ariadne/identity", 50);
    let missOwner = true;
    files.beforeReadFile = async (path) => {
      if (missOwner && path === `${lockPath}/owner.json`) throw fileError("ENOENT");
    };

    await expect(release()).rejects.toThrow("release retry required");
    expect(files.exists(lockPath)).toBe(true);

    missOwner = false;
    await release();
    expect(files.exists(lockPath)).toBe(false);
    expect([...files.directories].filter((path) => path.includes(".generation-"))).toEqual([]);
  });

  it("never publishes a lock before its owner metadata is complete", async () => {
    const files = new MemoryLockFiles();
    const firstWriteStarted = deferred();
    const finishFirstWrite = deferred();
    let blockedFirstWrite = false;
    files.beforeWriteFile = async () => {
      if (blockedFirstWrite) return;
      blockedFirstWrite = true;
      firstWriteStarted.resolve();
      await finishFirstWrite.promise;
    };

    const firstAcquisition = acquireProfileLock(
      runtime(files, { alive: [52], pid: 51, token: "first-token" }),
      "ariadne/identity",
      50,
    );
    await firstWriteStarted.promise;

    const secondRelease = await acquireProfileLock(
      runtime(files, { pid: 52, token: "second-token" }),
      "ariadne/identity",
      50,
    );
    finishFirstWrite.resolve();

    await expect(firstAcquisition).rejects.toBeInstanceOf(LockTimeoutError);
    expect(files.ownerToken(lockPath)).toBe("second-token");
    await secondRelease();
  });

  it("serializes two stale recoverers so the loser cannot displace the winner", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "expired", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    const firstStaleRenameStarted = deferred();
    const finishFirstStaleRename = deferred();
    let intercepted = false;
    files.beforeRename = async (_from, to) => {
      if (intercepted || !to.includes(".stale-")) return;
      intercepted = true;
      firstStaleRenameStarted.resolve();
      await finishFirstStaleRename.promise;
    };

    const firstAcquisition = acquireProfileLock(
      runtime(files, { alive: [51], now: 20, pid: 51, token: "first-reaper" }),
      "ariadne/identity",
      500,
    );
    await firstStaleRenameStarted.promise;
    const secondOutcome = await acquireProfileLock(
      runtime(files, { alive: [51], now: 20, pid: 52, token: "second-reaper" }),
      "ariadne/identity",
      50,
    ).then(
      (release) => ({ kind: "acquired" as const, release }),
      () => ({ kind: "timeout" as const }),
    );
    finishFirstStaleRename.resolve();
    const firstRelease = await firstAcquisition;

    expect(secondOutcome.kind).toBe("timeout");
    expect(files.ownerToken(lockPath)).toBe("first-reaper");
    await firstRelease();
    if (secondOutcome.kind === "acquired") await secondOutcome.release();
  });

  it("release racing recovery never moves a successor token", async () => {
    const files = new MemoryLockFiles();
    const ownerRelease = await acquireProfileLock(
      runtime(files, { pid: 51, token: "owner-token" }),
      "ariadne/identity",
      50,
    );
    const releaseRenameStarted = deferred();
    const finishReleaseRename = deferred();
    let intercepted = false;
    files.beforeRename = async (_from, to) => {
      if (intercepted || !to.includes(".release-owner-token")) return;
      intercepted = true;
      releaseRenameStarted.resolve();
      await finishReleaseRename.promise;
    };

    const releasing = ownerRelease();
    await releaseRenameStarted.promise;
    const recoveryWaitStarted = deferred();
    const finishRecoveryWait = deferred();
    const successorAcquisition = acquireProfileLock(
      runtime(files, {
        now: 2_000,
        pid: 52,
        token: "successor-token",
        onSleep: async () => {
          recoveryWaitStarted.resolve();
          await finishRecoveryWait.promise;
        },
      }),
      "ariadne/identity",
      500,
    );
    const recoveryState = await Promise.race([
      successorAcquisition.then(() => "acquired" as const),
      recoveryWaitStarted.promise.then(() => "waiting" as const),
    ]);

    finishReleaseRename.resolve();
    await releasing;
    if (recoveryState === "waiting") finishRecoveryWait.resolve();
    const successorRelease = await successorAcquisition;

    expect(
      files.renames.filter(({ to }) => to.includes(".release-owner-token")).map(({ ownerToken }) => ownerToken),
    ).toEqual(["owner-token"]);
    expect(files.ownerToken(lockPath)).toBe("successor-token");
    await successorRelease();
  });

  it("repairs a canonical symlink left dangling instead of waiting out the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-lock-dangling-"));
    temporaryRoots.push(root);
    const path = join(root, "profile.lock");
    await symlink(`${path}.generation-vanished`, path, "dir");
    const adapter = runtime(new NodeLockFiles(), { path, token: "repairing-owner" });

    const release = await acquireProfileLock(adapter, "ariadne/identity", 500);

    expect(adapter.sleeps).toEqual([]);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8")).token).toBe("repairing-owner");
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(true);
    await release();
  });

  it("never lets a repairer that decided while the link dangled displace the republished owner", async () => {
    const files = new MemoryLockFiles();
    files.links.set(lockPath, `${lockPath}.generation-vanished`);
    const lateDecisionMade = deferred();
    const finishLateDecision = deferred();
    let observed = 0;
    /* Block the repair the moment it has resolved the dangling link and before it acts on that
       decision — the interval the whole race lives in. The sweep at the head of the same
       acquisition readlinks first, hence the second observation, not the first. */
    files.beforeReadlink = async (path) => {
      if (path !== lockPath) return;
      observed += 1;
      if (observed !== 2) return;
      lateDecisionMade.resolve();
      await finishLateDecision.promise;
    };

    const lateRepair = acquireProfileLock(
      runtime(files, { alive: [52], pid: 51, token: "late-repairer" }),
      "ariadne/identity",
      50,
    );
    await lateDecisionMade.promise;
    const ownerRelease = await acquireProfileLock(
      runtime(files, { pid: 52, token: "republished-owner" }),
      "ariadne/identity",
      500,
    );
    finishLateDecision.resolve();

    await expect(lateRepair).rejects.toBeInstanceOf(LockTimeoutError);
    expect(files.links.get(lockPath)).toBe(`${lockPath}.generation-republished-owner`);
    expect(files.ownerToken(lockPath)).toBe("republished-owner");
    await ownerRelease();
  });

  it("reaps abandoned artifacts and keeps every generation directory still in use", async () => {
    const files = new MemoryLockFiles();
    const now = 5 * 24 * 60 * 60 * 1000;
    /* Each survivor is old enough to reap and protected by exactly one rule, so no rule can be
       removed without a failure: the canonical link (its owner is dead), the owner's liveness (it
       is not the canonical target), the retention window, and the artifact-name namespace. */
    files.seed(`${lockPath}.generation-published`, { token: "published", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    files.links.set(lockPath, `${lockPath}.generation-published`);
    files.seed(`${lockPath}.generation-running`, { token: "running", pid: 9, acquiredAt: 0, leaseUntil: 10 });
    files.directories.add(`${lockPath}.generation-abandoned`);
    files.links.set(`${lockPath}.stale-1-abandoned-0`, `${lockPath}.generation-abandoned`);
    files.directories.add(`${lockPath}.generation-fresh`);
    files.times.set(`${lockPath}.generation-fresh`, now);
    files.directories.add(`${lockPath}.unrelated`);
    files.directories.add(`${lockPath}.generation-`);

    const release = await acquireProfileLock(runtime(files, { alive: [9], now }), "ariadne/identity", 50);

    expect(files.exists(`${lockPath}.generation-abandoned`)).toBe(false);
    expect(files.exists(`${lockPath}.stale-1-abandoned-0`)).toBe(false);
    expect(files.exists(`${lockPath}.generation-published`)).toBe(true);
    expect(files.exists(`${lockPath}.generation-running`)).toBe(true);
    expect(files.exists(`${lockPath}.generation-fresh`)).toBe(true);
    expect(files.exists(`${lockPath}.unrelated`)).toBe(true);
    expect(files.exists(`${lockPath}.generation-`)).toBe(true);
    await release();
  });

  it("keeps sweeping after an artifact refuses to be removed", async () => {
    const files = new MemoryLockFiles();
    const now = 5 * 24 * 60 * 60 * 1000;
    files.directories.add(`${lockPath}.generation-stuck`);
    files.directories.add(`${lockPath}.generation-removable`);
    files.beforeRemove = async (path) => {
      if (path === `${lockPath}.generation-stuck`) throw fileError("EACCES");
    };

    const release = await acquireProfileLock(runtime(files, { now }), "ariadne/identity", 50);

    expect(files.exists(`${lockPath}.generation-stuck`)).toBe(true);
    expect(files.exists(`${lockPath}.generation-removable`)).toBe(false);
    await release();
  });

  it("refuses to sweep when the canonical link cannot be read", async () => {
    const files = new MemoryLockFiles();
    const now = 5 * 24 * 60 * 60 * 1000;
    files.seed(`${lockPath}.generation-published`, { token: "published", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    files.links.set(lockPath, `${lockPath}.generation-published`);
    files.directories.add(`${lockPath}.generation-abandoned`);
    files.beforeReadlink = async (path) => {
      if (path === lockPath) throw fileError("EACCES");
    };

    await expect(
      acquireProfileLock(runtime(files, { alive: [7], now }), "ariadne/identity", 50),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    /* Unreadable link means the sweep cannot tell which generation is live, so it removes nothing —
       the alternative deletes a live owner's directory and hands the lock to a second process. */
    expect(files.exists(`${lockPath}.generation-abandoned`)).toBe(true);
    expect(files.exists(`${lockPath}.generation-published`)).toBe(true);
  });

  it("falls back to the budgeted wait when the generation directory keeps vanishing", async () => {
    const files = new MemoryLockFiles();
    files.links.set(lockPath, `${lockPath}.generation-vanishing`);
    /* An external actor destroying the generation directory again on every guard attempt: repairing
       costs no sleep, so an unbounded repair would spin at 100% CPU past the caller's budget. */
    files.beforeMkdir = async (path) => {
      if (path === `${lockPath}/.operation`) files.directories.delete(`${lockPath}.generation-vanishing`);
    };
    const adapter = runtime(files, { token: "spinner" });

    await expect(acquireProfileLock(adapter, "ariadne/identity", 250)).rejects.toBeInstanceOf(LockTimeoutError);

    expect(adapter.sleeps).toEqual([100, 100, 50]);
  });

  it("refuses to repair a canonical link pointing outside the lock root", async () => {
    const files = new MemoryLockFiles();
    files.links.set(lockPath, `${lockPath}.generation-../../escaped`);

    await expect(acquireProfileLock(runtime(files), "ariadne/identity", 50)).rejects.toBeInstanceOf(LockTimeoutError);

    expect(files.exists(`${lockPath}.generation-../../escaped`)).toBe(false);
  });
});
