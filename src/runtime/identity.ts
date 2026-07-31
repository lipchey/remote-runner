import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export function worktreeIdentity(root: string): string {
  return createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
}
