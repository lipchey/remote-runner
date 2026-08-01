import { posix, win32 } from "node:path";

export function assertSafeRepositoryPath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value) ||
    posix.isAbsolute(portable) ||
    win32.isAbsolute(value) ||
    normalized === "." ||
    normalized === "./" ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`unsafe repository path: ${value}`);
  }

  return normalized;
}
