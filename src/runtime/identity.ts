import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/* Separate from `worktreeIdentity` so an identity can also be recomputed from a path that is already
   canonical — including one that no longer exists, which `realpathSync` cannot resolve. */
export function pathIdentity(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);
}

export function worktreeIdentity(root: string): string {
  return pathIdentity(realpathSync(root));
}
