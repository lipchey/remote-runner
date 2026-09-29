import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";

import type { LockFileSystem } from "../runtime/lock.js";

export function nodeLockFiles(): LockFileSystem {
  return {
    mkdir: async (path) => mkdir(path, { mode: 0o700 }),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    writeFile: async (path, contents, mode) => writeFile(path, contents, { flag: "wx", mode }),
    symlink: async (target, path) => symlink(target, path),
    readlink,
    readdir,
    /* A quarantined symlink can outlive its target, so its own age controls cleanup. */
    modifiedAt: async (path) => (await lstat(path)).mtimeMs,
    rename,
    remove: async (path) => rm(path, { recursive: true }),
  };
}
