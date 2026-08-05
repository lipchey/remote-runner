import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  enrollKnownHost,
  hostKeyMatchesPin,
  NodeKnownHostsStore,
  SERVER_ALIVE_COUNT_MAX,
  SERVER_ALIVE_INTERVAL_SECONDS,
  SSH_TARGET,
  type SshProcessRuntime,
} from "../ssh/client.js";

export interface ManagedSshTransport {
  readonly changed: boolean;
  readonly directory: string;
  readonly knownHostsPath: string;
}

function assertHome(home: string): void {
  if (
    !posix.isAbsolute(home) ||
    posix.normalize(home) !== home ||
    home === "/" ||
    /[\u0000-\u001f\u007f]/u.test(home)
  ) {
    throw new Error("managed SSH home must be a canonical non-root absolute path");
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/* Mutagen drives its transport through this wrapper, so the keepalives that stop a slept laptop
   from wedging a run have to be here too — the ssh/client.ts arguments never reach it. */
function wrapper(tool: "ssh" | "scp", knownHostsPath: string): string {
  return [
    "#!/bin/sh",
    `exec /usr/bin/${tool} -o BatchMode=yes -o StrictHostKeyChecking=yes -o ${quote(`UserKnownHostsFile=${knownHostsPath}`)} -o GlobalKnownHostsFile=/dev/null -o ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS} -o ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX} "$@"`,
    "",
  ].join("\n");
}

async function replaceIfChanged(path: string, contents: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("refusing to replace a non-file managed SSH artifact");
    if ((metadata.mode & 0o777) === 0o700 && (await readFile(path, "utf8")) === contents) return false;
  } catch (caught) {
    if (!(
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { code?: unknown }).code === "ENOENT"
    ))
      throw caught;
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o700 });
    await rename(temporary, path);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw caught;
  }
  return true;
}

export async function ensureManagedSshTransport(home: string): Promise<ManagedSshTransport> {
  assertHome(home);
  const directory = join(home, ".local", "share", "remote-runner", "ssh");
  const knownHostsDirectory = join(home, ".local", "state", "remote-runner", "known_hosts");
  const knownHostsPath = join(knownHostsDirectory, "managed");
  await Promise.all([
    mkdir(directory, { recursive: true, mode: 0o700 }),
    mkdir(knownHostsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(directory, 0o700), chmod(knownHostsDirectory, 0o700)]);
  const changed = (
    await Promise.all([
      replaceIfChanged(join(directory, "ssh"), wrapper("ssh", knownHostsPath)),
      replaceIfChanged(join(directory, "scp"), wrapper("scp", knownHostsPath)),
    ])
  ).some(Boolean);
  return { changed, directory, knownHostsPath };
}

export function mutagenSshEnvironment(
  directory: string,
  existing: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (
    !posix.isAbsolute(directory) ||
    posix.normalize(directory) !== directory ||
    /[\u0000-\u001f\u007f]/u.test(directory)
  ) {
    throw new Error("managed Mutagen SSH directory must be canonical and absolute");
  }
  return { ...existing, MUTAGEN_SSH_PATH: directory };
}

function hostField(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  return trimmed.split(/\s+/u, 1)[0];
}

function managedTargetHost(target: string): string {
  if (!SSH_TARGET.test(target) || target.startsWith("-")) throw new Error("managed SSH target is invalid");
  return target.includes("@") ? target.slice(target.lastIndexOf("@") + 1) : target;
}

function namesHost(line: string, host: string): boolean {
  return hostField(line)?.split(",").includes(host) === true;
}

export function managedKnownHostsContains(contents: string, target: string, trustedFingerprint: string): boolean {
  const host = managedTargetHost(target);
  const records = contents.split(/\r?\n/u).filter((line) => namesHost(line, host));
  /* One matching record is not enough: ssh trusts EVERY key listed for a host, and appending
     beside the superseded one is exactly what this function did before it checked the pin — so
     that two-record shape is what an already-re-pinned machine has on disk. */
  return records.length > 0 && records.every((line) => hostKeyMatchesPin(line, trustedFingerprint));
}

/* Re-pinning after the box was replaced only takes effect once the records carrying the
   superseded key are gone — but a record may list further aliases, whose own pins this eviction
   is not entitled to drop. */
function withoutHost(contents: string, host: string): string {
  const kept: string[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    if (!namesHost(line, host)) {
      kept.push(line);
      continue;
    }
    const [hosts, ...rest] = line.trim().split(/\s+/u);
    const aliases = (hosts ?? "").split(",").filter((alias) => alias !== host);
    if (aliases.length > 0) kept.push([aliases.join(","), ...rest].join(" "));
  }
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

export function mergeManagedKnownHosts(existing: string, addition: string): string {
  if (existing.includes("\0") || addition.includes("\0")) throw new Error("managed known_hosts contains NUL");
  if (addition.length === 0 || !addition.endsWith("\n"))
    throw new Error("managed known_hosts addition must be line terminated");
  const existingLines = new Set(existing.split(/\r?\n/u).filter((line) => line.length > 0));
  const additions = addition.split(/\r?\n/u).filter((line) => line.length > 0);
  const missing = additions.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return existing;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${prefix}${missing.join("\n")}\n`;
}

export interface EnsureManagedKnownHostOptions {
  readonly target: string;
  readonly trustedFingerprint: string;
  readonly knownHostsPath: string;
  readonly connectTimeoutSeconds: number;
}

export async function ensureManagedKnownHost(
  processes: SshProcessRuntime,
  options: EnsureManagedKnownHostOptions,
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(options.knownHostsPath, "utf8");
  } catch (caught) {
    if (!(
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { code?: unknown }).code === "ENOENT"
    ))
      throw caught;
  }
  if (managedKnownHostsContains(existing, options.target, options.trustedFingerprint)) return;
  const host = managedTargetHost(options.target);
  const enrolledPath = `${options.knownHostsPath}.enroll-${randomUUID()}`;
  try {
    await enrollKnownHost(processes, new NodeKnownHostsStore(), {
      target: host,
      trustedFingerprint: options.trustedFingerprint,
      knownHostsPath: enrolledPath,
      connectTimeoutSeconds: options.connectTimeoutSeconds,
    });
    const addition = await readFile(enrolledPath, "utf8");
    const merged = mergeManagedKnownHosts(withoutHost(existing, host), addition);
    await new NodeKnownHostsStore().persistAtomically(options.knownHostsPath, new TextEncoder().encode(merged), 0o600);
  } finally {
    await rm(enrolledPath, { force: true });
  }
}
