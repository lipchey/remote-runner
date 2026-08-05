import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { errorCode } from "../runtime/errno.js";

const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const IDENTITY = /^[0-9a-f]{24}$/u;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_QUEUE_ENTRIES = 1_024;

export interface PrewarmRequest {
  readonly schemaVersion: 1;
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly sourceRoot: string;
  readonly manifestPath: string;
}

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
  return `${request.consumer}-${request.profile}-${request.identity}`;
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

export async function inspectPrewarmRequest(
  home: string,
  request: Pick<PrewarmRequest, "consumer" | "profile" | "identity">,
): Promise<"idle" | "queued" | "running" | "unknown"> {
  const root = await verifiedQueueRoot(home, false);
  const basename = requestBasename(request);
  const running = await entryKind(join(root, `${basename}.running`));
  if (running === "file") return "running";
  if (running === "unknown") return "unknown";
  const pending = await entryKind(join(root, `${basename}.json`));
  if (pending === "file") return "queued";
  return pending === "unknown" ? "unknown" : "idle";
}

export async function publishPrewarmRequest(home: string, value: PrewarmRequest): Promise<"published" | "coalesced"> {
  const request = await validateRequest(value);
  const root = await verifiedQueueRoot(home, true);
  const basename = requestBasename(request);
  const pendingPath = join(root, `${basename}.json`);
  const runningPath = join(root, `${basename}.running`);
  const current = await inspectPrewarmRequest(home, request);
  if (current === "queued" || current === "running") return "coalesced";
  if (current === "unknown") throw new Error("prewarm queue entry is unsafe");

  const generationPath = join(root, `${basename}.generation-${randomUUID()}`);
  const contents = new TextEncoder().encode(JSON.stringify(request));
  if (contents.byteLength > MAX_REQUEST_BYTES) throw new Error("prewarm request is too large");
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

async function ownedEntries(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_QUEUE_ENTRIES) throw new Error("prewarm queue has too many entries");
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map(({ name }) => name)
      .filter((name) => name.endsWith(".running") || name.endsWith(".json"))
      .sort((left, right) => {
        const leftPriority = left.endsWith(".running") ? 0 : 1;
        const rightPriority = right.endsWith(".running") ? 0 : 1;
        return leftPriority - rightPriority || left.localeCompare(right);
      });
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") return [];
    throw caught;
  }
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
    try {
      await run(request);
    } finally {
      /* Without this the claim survives the failure, and because .running entries are claimed
         first the controller re-runs that same request every pass, forever. */
      await rm(runningPath, { force: true });
    }
    return "processed";
  }
  return "idle";
}
