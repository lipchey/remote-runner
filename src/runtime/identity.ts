import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** This state belongs to the client installation, never to a synchronized checkout. */
export function resolveClientIdentity(home: string): string {
  const directory = join(home, ".local", "state", "remote-runner");
  const path = join(directory, "client-id");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.size > 128) throw new Error("invalid remote-runner client identity file");
      const identity = readFileSync(descriptor, "utf8").trim();
      if (!CLIENT_ID.test(identity))
        throw new Error("invalid remote-runner client identity; restore the client-id file rather than replacing it");
      return identity;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.client-id-${randomUUID()}`);
  writeFileSync(temporary, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
  try {
    // Publish complete bytes once; simultaneous first runs must all adopt the winning ID.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temporary);
  }
  return resolveClientIdentity(home);
}

export function clientNamespace(clientId: string): string {
  if (!clientId) throw new Error("client identity is required");
  return createHash("sha256").update(clientId).digest("hex").slice(0, 24);
}

/* Separate from `worktreeIdentity` so an identity can also be recomputed from a path that is already
   canonical — including one that no longer exists, which `realpathSync` cannot resolve. */
export function pathIdentity(canonicalRoot: string, clientId: string): string {
  if (!clientId) throw new Error("client identity is required");
  return createHash("sha256")
    .update(JSON.stringify([clientId, canonicalRoot]))
    .digest("hex")
    .slice(0, 24);
}

export function worktreeIdentity(root: string, clientId: string): string {
  return pathIdentity(realpathSync(root), clientId);
}
