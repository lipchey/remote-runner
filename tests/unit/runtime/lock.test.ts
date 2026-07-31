import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
}

class MemoryLockFiles implements LockFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  readonly links = new Map<string, string>();
  readonly diagnostics: string[] = [];
  readonly renames: Array<{ readonly from: string; readonly to: string; readonly ownerToken?: string }> = [];
  beforeReadFile?: (path: string) => Promise<void>;
  beforeMkdir?: (path: string) => Promise<void>;
  beforeRemove?: (path: string) => Promise<void>;
  beforeWriteFile?: (path: string) => Promise<void>;
  beforeRename?: (from: string, to: string) => Promise<void>;

  async mkdir(path: string): Promise<void> {
    await this.beforeMkdir?.(path);
    if (this.exists(path)) throw fileError("EEXIST");
    if (path.startsWith(`${lockPath}/`) && !this.exists(lockPath)) {
      throw fileError("ENOENT");
    }
    this.directories.add(this.resolve(path));
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
    const movedDirectories = [...this.directories].filter(
      (path) => path === from || path.startsWith(`${from}/`),
    );
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

    await expect(acquireProfileLock(adapter, "ariadne/identity", 250)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    expect(adapter.sleeps).toEqual([100, 100, 50]);
    expect(files.diagnostics).toEqual([]);
    expect(files.exists(lockPath)).toBe(true);
  });

  it("recovers only after the lease expired and the owner is absent", async () => {
    const files = new MemoryLockFiles();
    files.seed(lockPath, { token: "theirs", pid: 7, acquiredAt: 0, leaseUntil: 10 });
    const adapter = runtime(files, { now: 20 });

    const release = await acquireProfileLock(adapter, "ariadne/identity", 500);

    expect(files.diagnostics).toHaveLength(1);
    expect(files.diagnostics[0]).toContain(".stale-");
    expect(JSON.parse(new TextDecoder().decode(await files.readFile(`${lockPath}/owner.json`)))).toEqual(
      {
        token: "ours-unique-token",
        pid: 42,
        acquiredAt: 20,
        leaseUntil: 1_020,
      },
    );
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

    const release = await acquireProfileLock(
      runtime(files, { path, token: "posix-owner" }),
      "ariadne/identity",
      50,
    );

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
      files.renames
        .filter(({ to }) => to.includes(".release-owner-token"))
        .map(({ ownerToken }) => ownerToken),
    ).toEqual(["owner-token"]);
    expect(files.ownerToken(lockPath)).toBe("successor-token");
    await successorRelease();
  });
});
