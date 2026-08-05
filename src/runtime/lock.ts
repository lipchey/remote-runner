import { errorCode } from "./errno.js";

export interface LockFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<readonly string[]>;
  /* Age of the entry itself, never of a symlink's target. */
  modifiedAt(path: string): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LockRuntime {
  readonly files: LockFileSystem;
  readonly processes: { isAlive(pid: number): Promise<boolean> };
  readonly clock: { now(): number; sleep(milliseconds: number): Promise<void> };
  readonly lockDirectory: (identity: string) => string;
  readonly pid: number;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
  readonly createToken: () => string;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
  readonly leaseUntil: number;
}

export class LockTimeoutError extends Error {
  constructor(identity: string, waitBudgetMs: number) {
    super(`timed out acquiring lock for ${identity} after ${waitBudgetMs}ms`);
    this.name = "LockTimeoutError";
  }
}

export class LockReleaseRetryableError extends Error {
  constructor(reason: "busy" | "missing") {
    super(`release retry required: operation guard ${reason}`);
    this.name = "LockReleaseRetryableError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function parseOwner(contents: Uint8Array): LockOwner {
  const parsed: unknown = JSON.parse(decoder.decode(contents));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lock owner must be an object");
  }
  const candidate = parsed as Partial<Record<keyof LockOwner, unknown>>;
  if (
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    typeof candidate.acquiredAt !== "number" ||
    !Number.isFinite(candidate.acquiredAt) ||
    typeof candidate.leaseUntil !== "number" ||
    !Number.isFinite(candidate.leaseUntil) ||
    candidate.leaseUntil < candidate.acquiredAt
  ) {
    throw new Error("invalid lock owner");
  }
  return candidate as unknown as LockOwner;
}

async function renameForDiagnosis(
  runtime: LockRuntime,
  lockPath: string,
  kind: "stale" | "corrupt",
  token: string,
  attempt: number,
): Promise<boolean> {
  const diagnosticPath = `${lockPath}.${kind}-${runtime.clock.now()}-${token}-${attempt}`;
  try {
    await runtime.files.rename(lockPath, diagnosticPath);
    return true;
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return false;
    throw caught;
  }
}

function isPublishCollision(caught: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(errorCode(caught) ?? "");
}

async function removeIfPresent(files: LockFileSystem, path: string): Promise<void> {
  try {
    await files.remove(path);
  } catch (caught) {
    if (errorCode(caught) !== "ENOENT") throw caught;
  }
}

async function publishInitializedLock(runtime: LockRuntime, lockPath: string, token: string): Promise<boolean> {
  const generationPath = `${lockPath}.generation-${token}`;
  const generationOwnerPath = `${generationPath}/owner.json`;
  await runtime.files.mkdir(generationPath);
  const acquiredAt = runtime.clock.now();
  const owner: LockOwner = {
    token,
    pid: runtime.pid,
    acquiredAt,
    leaseUntil: acquiredAt + runtime.leaseDurationMs,
  };
  try {
    await runtime.files.writeFile(generationOwnerPath, encoder.encode(JSON.stringify(owner)), 0o600);
    await runtime.files.symlink(generationPath, lockPath);
    return true;
  } catch (caught) {
    await removeIfPresent(runtime.files, generationPath);
    if (isPublishCollision(caught)) return false;
    throw caught;
  }
}

/* Every name this protocol leaves in the lock root is `${lockPath}` plus one of these infixes, and
   nothing in the tool ever reads them back, so an unswept root grows by one entry per crashed run
   forever. The window keeps them long enough to be worth the diagnosis they were renamed for. */
const ARTIFACT_INFIXES = [".generation-", ".stale-", ".corrupt-", ".release-"];
const ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;

async function isAbandoned(runtime: LockRuntime, path: string): Promise<boolean> {
  try {
    return runtime.clock.now() - (await runtime.files.modifiedAt(path)) >= ARTIFACT_RETENTION_MS;
  } catch {
    return false;
  }
}

async function hasLiveOwner(runtime: LockRuntime, generationPath: string): Promise<boolean> {
  try {
    const owner = parseOwner(await runtime.files.readFile(`${generationPath}/owner.json`));
    return await runtime.processes.isAlive(owner.pid);
  } catch {
    return false;
  }
}

async function reapAbandonedArtifacts(runtime: LockRuntime, lockPath: string): Promise<void> {
  const separator = lockPath.lastIndexOf("/");
  if (separator <= 0) return;
  const root = lockPath.slice(0, separator);
  const prefix = lockPath.slice(separator + 1);
  let published: string | undefined;
  try {
    published = await runtime.files.readlink(lockPath);
  } catch (caught) {
    /* ENOENT is an unheld lock and EINVAL the legacy plain-directory shape, both meaning "nothing
       is published". Any other errno means the link exists and could not be read, so the sweep has
       no idea which generation is live: skip it entirely rather than fall back to the age bound. */
    if (!["ENOENT", "EINVAL"].includes(errorCode(caught) ?? "")) return;
  }
  for (const name of await runtime.files.readdir(root)) {
    const infix = ARTIFACT_INFIXES.find(
      (candidate) => name.startsWith(`${prefix}${candidate}`) && name.length > prefix.length + candidate.length,
    );
    if (infix === undefined) continue;
    const path = `${root}/${name}`;
    /* Two independent reasons to keep a generation directory, because deleting a live one hands the
       canonical name to a second owner: it is what the canonical symlink resolves to, or its owner
       process is still running. Neither is sufficient alone — the first is blind for the moments
       between reading the link and a newer owner publishing (the age bound covers that: a directory
       young enough to belong to a lock this sweep never observed is never removed), the second is
       blind to a holder whose pid was reused. Keeping a quarantined artifact whose pid was reused
       is the price, and it costs one undeleted directory. */
    if (path === published) continue;
    if (!(await isAbandoned(runtime, path))) continue;
    if (infix === ".generation-" && (await hasLiveOwner(runtime, path))) continue;
    /* An entry that refuses to be removed must not abort the entries after it, or one root-owned
       leftover disables the sweep for good. */
    await removeIfPresent(runtime.files, path).catch(() => undefined);
  }
}

type GuardResult = "acquired" | "busy" | "missing";

async function acquireOperationGuard(runtime: LockRuntime, guardPath: string): Promise<GuardResult> {
  try {
    await runtime.files.mkdir(guardPath);
    return "acquired";
  } catch (caught) {
    if (errorCode(caught) === "EEXIST") return "busy";
    if (errorCode(caught) === "ENOENT") return "missing";
    throw caught;
  }
}

/* A canonical symlink whose generation directory was removed underneath it (an operator or a tmp
   sweeper tidying the lock root is the only way in — no path in this file unpublishes a directory
   before its symlink) wedges every future run: nobody can create `${lockPath}/.operation` through
   it, so neither the guarded recovery below nor the owner's own release can ever fire, and each run
   burns its whole wait budget. Recreating the missing target restores the ordinary "owner metadata
   is unreadable" shape, which the guarded recovery already quarantines. Restoring the target is
   deliberately ALL this does: removing the canonical name outside the guard is what would let a
   process that decided while the link was dangling unpublish a lock somebody else has since
   republished, and two owners would run at once. */
async function restoreDanglingGeneration(runtime: LockRuntime, lockPath: string): Promise<boolean> {
  let target: string;
  try {
    target = await runtime.files.readlink(lockPath);
  } catch {
    return false;
  }
  /* Only directories this protocol names itself are ever recreated, and only as a single sibling
     segment: a prefix test alone accepts `${lockPath}.generation-../../elsewhere`, which would put
     mkdir on a target chosen by whoever wrote the link rather than inside the lock root. */
  const suffix = target.startsWith(`${lockPath}.generation-`) ? target.slice(`${lockPath}.generation-`.length) : "";
  if (suffix.length === 0 || suffix.includes("/")) return false;
  try {
    await runtime.files.mkdir(target);
    return true;
  } catch {
    /* Including EEXIST: another process repaired it, so retry through the wait rather than
       immediately, which is what kept the pre-repair spin off the CPU. */
    return false;
  }
}

async function waitForRetry(
  runtime: LockRuntime,
  identity: string,
  waitBudgetMs: number,
  deadline: number,
): Promise<void> {
  const remaining = deadline - runtime.clock.now();
  if (remaining <= 0) throw new LockTimeoutError(identity, waitBudgetMs);
  await runtime.clock.sleep(Math.min(runtime.pollIntervalMs, remaining));
}

interface ReleaseProgress {
  phase: "published" | "moved" | "unlinked" | "complete";
}

async function releaseOwnedLock(
  runtime: LockRuntime,
  lockPath: string,
  ownerPath: string,
  token: string,
  generationPath: string,
  progress: ReleaseProgress,
): Promise<void> {
  const releasePath = `${lockPath}.release-${token}`;
  if (progress.phase === "published") {
    const guardPath = `${lockPath}/.operation`;
    const guard = await acquireOperationGuard(runtime, guardPath);
    if (guard !== "acquired") throw new LockReleaseRetryableError(guard);
    let moved = false;
    try {
      let current: LockOwner;
      try {
        current = parseOwner(await runtime.files.readFile(ownerPath));
      } catch (caught) {
        if (errorCode(caught) === "ENOENT") throw new LockReleaseRetryableError("missing");
        throw caught;
      }
      if (current.token !== token) {
        progress.phase = "complete";
        return;
      }
      try {
        await runtime.files.rename(lockPath, releasePath);
      } catch (caught) {
        if (errorCode(caught) === "ENOENT") {
          progress.phase = "complete";
          return;
        }
        throw caught;
      }
      moved = true;
      progress.phase = "moved";
    } finally {
      if (!moved) await removeIfPresent(runtime.files, guardPath);
    }
  }

  if (progress.phase === "moved") {
    try {
      await runtime.files.remove(releasePath);
    } catch (caught) {
      if (errorCode(caught) !== "ENOENT") throw caught;
    }
    progress.phase = "unlinked";
  }

  if (progress.phase === "unlinked") {
    try {
      await runtime.files.remove(generationPath);
    } catch (caught) {
      if (errorCode(caught) !== "ENOENT") throw caught;
    }
    progress.phase = "complete";
  }
}

export async function acquireProfileLock(
  runtime: LockRuntime,
  identity: string,
  waitBudgetMs: number,
): Promise<() => Promise<void>> {
  if (!Number.isFinite(waitBudgetMs) || waitBudgetMs < 0) {
    throw new Error("lock wait budget must be a finite non-negative number");
  }
  if (!Number.isFinite(runtime.leaseDurationMs) || runtime.leaseDurationMs <= 0) {
    throw new Error("lock lease duration must be positive");
  }
  if (!Number.isFinite(runtime.pollIntervalMs) || runtime.pollIntervalMs <= 0) {
    throw new Error("lock poll interval must be positive");
  }

  const lockPath = runtime.lockDirectory(identity);
  const ownerPath = `${lockPath}/owner.json`;
  const token = runtime.createToken();
  if (token.length === 0) throw new Error("lock ownership token must not be empty");
  const generationPath = `${lockPath}.generation-${token}`;
  const deadline = runtime.clock.now() + waitBudgetMs;
  let diagnosticAttempt = 0;
  let repaired = false;

  /* A lock root that cannot be swept is still a lock root that can be taken. */
  await reapAbandonedArtifacts(runtime, lockPath).catch(() => undefined);

  for (;;) {
    if (await publishInitializedLock(runtime, lockPath, token)) {
      const progress: ReleaseProgress = { phase: "published" };
      let pendingRelease: Promise<void> = Promise.resolve();
      return async () => {
        const attempt = pendingRelease.then(async () => {
          if (progress.phase === "complete") return;
          await releaseOwnedLock(runtime, lockPath, ownerPath, token, generationPath, progress);
        });
        pendingRelease = attempt.catch(() => undefined);
        return attempt;
      };
    }

    const guardPath = `${lockPath}/.operation`;
    const guard = await acquireOperationGuard(runtime, guardPath);
    /* "missing" is either a lock that vanished between the two calls, which the ordinary retry
       covers, or a dangling canonical symlink, which does not resolve on its own. */
    if (guard === "missing") {
      /* One repair per acquisition: the retry below is the only deadline enforcement in this loop,
         so a canonical name that keeps being re-dangled by whatever destroyed it in the first place
         would otherwise spin here for free, ignoring the caller's budget. */
      if (repaired || !(await restoreDanglingGeneration(runtime, lockPath))) {
        await waitForRetry(runtime, identity, waitBudgetMs, deadline);
      }
      repaired = true;
      continue;
    }
    if (guard === "busy") {
      await waitForRetry(runtime, identity, waitBudgetMs, deadline);
      continue;
    }

    let moved = false;
    try {
      let ownerContents: Uint8Array;
      try {
        ownerContents = await runtime.files.readFile(ownerPath);
      } catch (caught) {
        if (errorCode(caught) !== "ENOENT") throw caught;
        moved = await renameForDiagnosis(runtime, lockPath, "corrupt", token, diagnosticAttempt++);
        continue;
      }

      let owner: LockOwner;
      try {
        owner = parseOwner(ownerContents);
      } catch {
        moved = await renameForDiagnosis(runtime, lockPath, "corrupt", token, diagnosticAttempt++);
        continue;
      }

      /* A dead owner is reclaimed the moment it is observed dead: the lease added nothing to the
         liveness check (an owner whose PID was reused stays alive forever either way) and only
         made every crashed run block the next one for a whole lease. leaseUntil is kept as a
         diagnostic record of when the owner expected to be done. */
      if (!(await runtime.processes.isAlive(owner.pid))) {
        moved = await renameForDiagnosis(runtime, lockPath, "stale", token, diagnosticAttempt++);
        continue;
      }
    } finally {
      if (!moved) await removeIfPresent(runtime.files, guardPath);
    }

    await waitForRetry(runtime, identity, waitBudgetMs, deadline);
  }
}
