export interface LockFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
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

function errorCode(caught: unknown): string | undefined {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { code?: unknown }).code)
    : undefined;
}

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

async function publishInitializedLock(
  runtime: LockRuntime,
  lockPath: string,
  token: string,
): Promise<boolean> {
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
    await runtime.files.writeFile(
      generationOwnerPath,
      encoder.encode(JSON.stringify(owner)),
      0o600,
    );
    await runtime.files.symlink(generationPath, lockPath);
    return true;
  } catch (caught) {
    await removeIfPresent(runtime.files, generationPath);
    if (isPublishCollision(caught)) return false;
    throw caught;
  }
}

type GuardResult = "acquired" | "busy" | "missing";

async function acquireOperationGuard(
  runtime: LockRuntime,
  guardPath: string,
): Promise<GuardResult> {
  try {
    await runtime.files.mkdir(guardPath);
    return "acquired";
  } catch (caught) {
    if (errorCode(caught) === "EEXIST") return "busy";
    if (errorCode(caught) === "ENOENT") return "missing";
    throw caught;
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
    if (guard === "missing") continue;
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
        moved = await renameForDiagnosis(
          runtime,
          lockPath,
          "corrupt",
          token,
          diagnosticAttempt++,
        );
        continue;
      }

      let owner: LockOwner;
      try {
        owner = parseOwner(ownerContents);
      } catch {
        moved = await renameForDiagnosis(
          runtime,
          lockPath,
          "corrupt",
          token,
          diagnosticAttempt++,
        );
        continue;
      }

      const now = runtime.clock.now();
      if (now >= owner.leaseUntil && !(await runtime.processes.isAlive(owner.pid))) {
        moved = await renameForDiagnosis(
          runtime,
          lockPath,
          "stale",
          token,
          diagnosticAttempt++,
        );
        continue;
      }
    } finally {
      if (!moved) await removeIfPresent(runtime.files, guardPath);
    }

    await waitForRetry(runtime, identity, waitBudgetMs, deadline);
  }
}
