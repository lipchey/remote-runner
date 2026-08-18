import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { errorCode } from "../runtime/errno.js";

const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const IDENTITY = /^[0-9a-f]{24}$/u;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 512;
const MAX_QUEUE_ENTRIES = 1_024;
/* What the run threw is not an exit code, and runControllerLoop swallows the throw — so without a
   status of its own that failure has no trace at all. */
const RUN_ERROR_STATUS = 70;
/* Consumers parse the status line as space-separated `key=value`, so an instant read back from disk
   may only reach the renderer if it cannot contain a space. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface PrewarmRequest {
  readonly schemaVersion: 1;
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly sourceRoot: string;
  readonly manifestPath: string;
}

export interface PrewarmOutcome {
  readonly outcome: "ok" | "failed";
  readonly status: number;
  readonly at: string;
}

export type PrewarmState = "idle" | "queued" | "running" | "unknown" | PrewarmOutcome;

function queueRoot(home: string): string {
  if (!isAbsolute(home) || resolve(home) !== home) throw new Error("home must be an absolute path");
  return join(home, ".local", "state", "remote-runner", "prewarm");
}

async function verifiedQueueRoot(home: string, create: boolean): Promise<string> {
  const root = queueRoot(home);
  if (create) {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (caught) {
      if (errorCode(caught) !== "EEXIST") throw caught;
    }
  }
  try {
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("prewarm queue root is unsafe");
    }
  } catch (caught) {
    if (!create && errorCode(caught) === "ENOENT") return root;
    throw caught;
  }
  return root;
}

function requestBasename(request: Pick<PrewarmRequest, "consumer" | "profile" | "identity">): string {
  if (!COMPONENT.test(request.consumer)) throw new Error("prewarm consumer is invalid");
  if (!COMPONENT.test(request.profile)) throw new Error("prewarm profile is invalid");
  if (!IDENTITY.test(request.identity)) throw new Error("prewarm identity is invalid");
  /* `_` is outside COMPONENT and IDENTITY; `-` is not, so joining with it gave `a-b`/`c` and
     `a`/`b-c` one key — coalescing away a request for a profile the queue never held, and later
     answering it with the other's outcome. A pre-`_` entry no longer matches the payload it
     holds, and the claim path discards it. */
  return `${request.consumer}_${request.profile}_${request.identity}`;
}

async function validateRequest(value: unknown): Promise<PrewarmRequest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("prewarm request must be an object");
  }
  const candidate = value as Partial<Record<keyof PrewarmRequest, unknown>>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.consumer !== "string" ||
    typeof candidate.profile !== "string" ||
    typeof candidate.identity !== "string" ||
    typeof candidate.sourceRoot !== "string" ||
    typeof candidate.manifestPath !== "string"
  ) {
    throw new Error("prewarm request fields are invalid");
  }
  const request = candidate as PrewarmRequest;
  requestBasename(request);
  if (!isAbsolute(request.sourceRoot) || resolve(request.sourceRoot) !== request.sourceRoot) {
    throw new Error("prewarm source root must be canonical and absolute");
  }
  if ((await realpath(request.sourceRoot)) !== request.sourceRoot) {
    throw new Error("prewarm source root must resolve to itself");
  }
  if (!isAbsolute(request.manifestPath) || resolve(request.manifestPath) !== request.manifestPath) {
    throw new Error("prewarm manifest path must be canonical and absolute");
  }
  if ((await realpath(request.manifestPath)) !== request.manifestPath) {
    throw new Error("prewarm manifest path must resolve to itself");
  }
  const fromRoot = relative(request.sourceRoot, request.manifestPath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("prewarm manifest path escapes the source root");
  }
  return request;
}

async function entryKind(path: string): Promise<"missing" | "file" | "unknown"> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink() ? "file" : "unknown";
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return "missing";
    throw caught;
  }
}

async function inspectQueueState(root: string, basename: string): Promise<"idle" | "queued" | "running" | "unknown"> {
  const running = await entryKind(join(root, `${basename}.running`));
  if (running === "file") return "running";
  if (running === "unknown") return "unknown";
  const pending = await entryKind(join(root, `${basename}.json`));
  if (pending === "file") return "queued";
  return pending === "unknown" ? "unknown" : "idle";
}

/* One level down because `ownedEntries` caps the queue root at MAX_QUEUE_ENTRIES *before* it
   filters by suffix: siblings would wedge the controller once enough identities accumulate. The
   directory itself spends one of those slots. */
function resultsRoot(root: string): string {
  return join(root, "results");
}

async function verifiedResultsRoot(root: string, create: boolean): Promise<string | "missing" | "unsafe"> {
  const directory = resultsRoot(root);
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (caught) {
      if (errorCode(caught) !== "EEXIST") throw caught;
    }
  }
  try {
    const status = await lstat(directory);
    return status.isDirectory() && !status.isSymbolicLink() ? directory : "unsafe";
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return "missing";
    throw caught;
  }
}

async function readPrewarmResult(root: string, basename: string): Promise<PrewarmOutcome | "unknown" | undefined> {
  let contents: Buffer;
  try {
    const directory = await verifiedResultsRoot(root, false);
    if (directory === "missing") return undefined;
    if (directory === "unsafe") return "unknown";
    const path = join(directory, `${basename}.json`);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_RESULT_BYTES) return "unknown";
    contents = await readFile(path);
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return undefined;
    return "unknown";
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unknown";
    const candidate = parsed as Partial<Record<"schemaVersion" | "status" | "at", unknown>>;
    if (candidate.schemaVersion !== 1) return "unknown";
    if (typeof candidate.at !== "string" || !INSTANT.test(candidate.at)) return "unknown";
    if (new Date(candidate.at).toISOString() !== candidate.at) return "unknown";
    /* The claim marker: this request started and nothing terminal replaced it, so the previous
       run's outcome must not answer for it. */
    if (candidate.status === null) return "unknown";
    if (typeof candidate.status !== "number" || !Number.isSafeInteger(candidate.status)) return "unknown";
    return { outcome: candidate.status === 0 ? "ok" : "failed", status: candidate.status, at: candidate.at };
  } catch {
    return "unknown";
  }
}

/* Best effort: a prewarm that ran must not be reported as failed, or replayed, because its
   outcome could not be written down. */
async function recordPrewarmResult(root: string, basename: string, status: number | null, at: string): Promise<void> {
  try {
    const directory = await verifiedResultsRoot(root, true);
    if (directory === "missing" || directory === "unsafe") return;
    const generationPath = join(directory, `${basename}.generation-${randomUUID()}`);
    const contents = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, status, at }));
    await writeFile(generationPath, contents, { flag: "wx", mode: 0o600 });
    try {
      await rename(generationPath, join(directory, `${basename}.json`));
    } finally {
      await rm(generationPath, { force: true });
    }
  } catch {
    /* A claim that cannot be marked must not leave the last run's outcome readable as this one's. */
    if (status === null) await rm(join(resultsRoot(root), `${basename}.json`), { force: true }).catch(() => undefined);
  }
}

export async function inspectPrewarmRequest(
  home: string,
  request: Pick<PrewarmRequest, "consumer" | "profile" | "identity">,
): Promise<PrewarmState> {
  const root = await verifiedQueueRoot(home, false);
  const basename = requestBasename(request);
  const queued = await inspectQueueState(root, basename);
  if (queued !== "idle") return queued;
  return (await readPrewarmResult(root, basename)) ?? "idle";
}

export async function publishPrewarmRequest(home: string, value: PrewarmRequest): Promise<"published" | "coalesced"> {
  const request = await validateRequest(value);
  const root = await verifiedQueueRoot(home, true);
  const basename = requestBasename(request);
  const pendingPath = join(root, `${basename}.json`);
  const runningPath = join(root, `${basename}.running`);
  /* The queue state only — a retained result must never be able to refuse a new request. */
  const current = await inspectQueueState(root, basename);
  if (current === "queued" || current === "running") return "coalesced";
  if (current === "unknown") throw new Error("prewarm queue entry is unsafe");

  const generationPath = join(root, `${basename}.generation-${randomUUID()}`);
  const contents = new TextEncoder().encode(JSON.stringify(request));
  if (contents.byteLength > MAX_REQUEST_BYTES) throw new Error("prewarm request is too large");
  /* This write stamps the mtime the queue is served in arrival order by; `link()` preserves it, and
     a re-request that coalesces on EEXIST keeps the FIRST arrival's — refreshing it would push a
     repeatedly-requested worktree to the back of the queue forever. */
  await writeFile(generationPath, contents, { flag: "wx", mode: 0o600 });
  try {
    await link(generationPath, pendingPath);
  } catch (caught) {
    if (errorCode(caught) !== "EEXIST") throw caught;
    return "coalesced";
  } finally {
    await rm(generationPath, { force: true });
  }
  if ((await entryKind(runningPath)) === "file") {
    await rm(pendingPath, { force: true });
    return "coalesced";
  }
  return "published";
}

/* Arrival order, not FIFO: the mtime is stamped by the publish `writeFile` and only the later
   `link()` makes the request visible, so two publishers interleaving between those two calls can be
   served in the opposite order, and equal timestamps fall back to the identity-hash order this sort
   exists to remove. Both are tolerable because the queue carries best-effort prewarms only. */
async function ownedEntries(root: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_QUEUE_ENTRIES) throw new Error("prewarm queue has too many entries");
    names = entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map(({ name }) => name)
      .filter((name) => name.endsWith(".running") || name.endsWith(".json"));
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return [];
    throw caught;
  }
  const arrivals = new Map<string, number>();
  for (const name of names) {
    try {
      arrivals.set(name, (await lstat(join(root, name))).mtimeMs);
    } catch (caught) {
      /* A request another pass claimed between the readdir and here is a normal race, not an error. */
      if (errorCode(caught) !== "ENOENT") throw caught;
    }
  }
  return names
    .filter((name) => arrivals.has(name))
    .sort((left, right) => {
      const leftPriority = left.endsWith(".running") ? 0 : 1;
      const rightPriority = right.endsWith(".running") ? 0 : 1;
      return leftPriority - rightPriority || arrivals.get(left)! - arrivals.get(right)! || left.localeCompare(right);
    });
}

export async function consumeNextPrewarmRequest(
  home: string,
  run: (request: PrewarmRequest) => Promise<number>,
): Promise<"idle" | "processed" | "discarded"> {
  const root = await verifiedQueueRoot(home, false);
  for (const name of await ownedEntries(root)) {
    const claimedBasename = name.endsWith(".running")
      ? name.slice(0, -".running".length)
      : name.slice(0, -".json".length);
    const sourcePath = join(root, name);
    const runningPath = name.endsWith(".running")
      ? sourcePath
      : join(root, `${name.slice(0, -".json".length)}.running`);
    if (sourcePath !== runningPath) {
      try {
        await rename(sourcePath, runningPath);
      } catch (caught) {
        if (errorCode(caught) === "ENOENT" || errorCode(caught) === "EEXIST") continue;
        throw caught;
      }
    }
    let request: PrewarmRequest;
    try {
      const status = await lstat(runningPath);
      if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_REQUEST_BYTES) {
        await rm(runningPath, { force: true });
        return "discarded";
      }
      const contents = await readFile(runningPath);
      request = await validateRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)));
      if (requestBasename(request) !== claimedBasename) {
        throw new Error("prewarm request does not match its queue filename");
      }
    } catch {
      await rm(runningPath, { force: true });
      return "discarded";
    }
    await recordPrewarmResult(root, claimedBasename, null, new Date().toISOString());
    try {
      const status = await run(request);
      await recordPrewarmResult(root, claimedBasename, status, new Date().toISOString());
    } catch (caught) {
      await recordPrewarmResult(root, claimedBasename, RUN_ERROR_STATUS, new Date().toISOString());
      throw caught;
    } finally {
      /* Without this the claim survives the failure, and because .running entries are claimed
         first the controller re-runs that same request every pass, forever. */
      await rm(runningPath, { force: true });
    }
    return "processed";
  }
  return "idle";
}
