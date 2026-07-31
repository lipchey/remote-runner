import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProcessRequest, ProcessResult } from "../runtime/contracts.js";

const MAX_CONNECT_TIMEOUT_SECONDS = 300;
const DEFAULT_CAPTURE_BYTES = 64 * 1024;
const HOST_KEY_TYPE = /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface BoundedProcessRequest extends ProcessRequest {
  readonly maxOutputBytes: number;
}

export interface BoundedProcessResult extends ProcessResult {
  readonly outputTruncated: boolean;
}

export interface SshProcessRuntime {
  run(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
}

export interface KnownHostsStore {
  persistAtomically(path: string, contents: Uint8Array, mode: number): Promise<void>;
}

export interface KnownHostsFileSystem {
  writeExclusive(path: string, contents: Uint8Array, mode: number): Promise<void>;
  syncFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface EnrollKnownHostOptions {
  readonly target: string;
  readonly trustedFingerprint: string;
  readonly knownHostsPath: string;
  readonly connectTimeoutSeconds: number;
}

function assertText(value: string, label: string): void {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be non-empty and must not contain NUL`);
  }
}

function assertTimeout(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_CONNECT_TIMEOUT_SECONDS) {
    throw new Error(`connect timeout must be an integer from 1 to ${MAX_CONNECT_TIMEOUT_SECONDS}`);
  }
}

function assertCommand(command: readonly string[]): void {
  if (command.length === 0) throw new Error("remote command must not be empty");
  assertText(command[0] ?? "", "remote command");
  for (const argument of command.slice(1)) {
    if (argument.includes("\0")) throw new Error("remote argument must not contain NUL");
  }
}

export function sshArguments(
  target: string,
  remoteArguments: readonly string[],
  connectTimeoutSeconds: number,
  knownHostsPath: string,
): string[] {
  assertText(target, "SSH target");
  assertCommand(remoteArguments);
  assertTimeout(connectTimeoutSeconds);
  assertText(knownHostsPath, "known_hosts path");

  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
    "--",
    target,
    encodePosixCommand(remoteArguments),
  ];
}

function encodePosixArgument(argument: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export function encodePosixCommand(remoteArguments: readonly string[]): string {
  assertCommand(remoteArguments);
  return remoteArguments.map(encodePosixArgument).join(" ");
}

function assertBoundedResult(result: BoundedProcessResult, maximumBytes: number): void {
  if (
    result.outputTruncated ||
    result.stdout.byteLength > maximumBytes ||
    result.stderr.byteLength > maximumBytes
  ) {
    throw new Error("process output limit exceeded");
  }
}

export async function runSsh(
  processes: SshProcessRuntime,
  target: string,
  remoteArguments: readonly string[],
  connectTimeoutSeconds: number,
  knownHostsPath: string,
  maximumCaptureBytes = DEFAULT_CAPTURE_BYTES,
): Promise<BoundedProcessResult> {
  if (!Number.isSafeInteger(maximumCaptureBytes) || maximumCaptureBytes <= 0) {
    throw new Error("maximum capture bytes must be a positive integer");
  }
  const result = await processes.run({
    command: "ssh",
    args: sshArguments(target, remoteArguments, connectTimeoutSeconds, knownHostsPath),
    maxOutputBytes: maximumCaptureBytes,
  });
  assertBoundedResult(result, maximumCaptureBytes);
  return result;
}

interface ParsedHostKey {
  readonly line: string;
  readonly blob: Uint8Array;
}

function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (!BASE64.test(value) || value.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) return undefined;
  return decoded;
}

function parseHostKeys(output: Uint8Array): ParsedHostKey[] {
  const parsed: ParsedHostKey[] = [];
  for (const sourceLine of new TextDecoder("utf-8", { fatal: true }).decode(output).split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 3 || !HOST_KEY_TYPE.test(fields[1] ?? "")) continue;
    const hosts = fields[0] ?? "";
    if (hosts.length === 0 || /[\u0000-\u001f\u007f]/u.test(hosts)) continue;
    const blob = decodeCanonicalBase64(fields[2] ?? "");
    if (blob !== undefined) parsed.push({ line, blob });
  }
  return parsed;
}

function sha256Fingerprint(blob: Uint8Array): string {
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export async function enrollKnownHost(
  processes: SshProcessRuntime,
  store: KnownHostsStore,
  options: EnrollKnownHostOptions,
): Promise<void> {
  assertText(options.target, "SSH target");
  assertText(options.knownHostsPath, "known_hosts path");
  assertTimeout(options.connectTimeoutSeconds);
  if (!/^SHA256:[A-Za-z0-9+/]+$/u.test(options.trustedFingerprint)) {
    throw new Error("trusted host fingerprint must use SHA256 format");
  }

  const result = await processes.run({
    command: "ssh-keyscan",
    args: ["-T", String(options.connectTimeoutSeconds), "--", options.target],
    maxOutputBytes: DEFAULT_CAPTURE_BYTES,
  });
  assertBoundedResult(result, DEFAULT_CAPTURE_BYTES);
  if (result.exitCode !== 0) throw new Error("host key scan failed");

  const matching = parseHostKeys(result.stdout).filter(
    ({ blob }) => sha256Fingerprint(blob) === options.trustedFingerprint,
  );
  if (matching.length !== 1) {
    throw new Error(matching.length === 0 ? "trusted host key not found" : "ambiguous trusted host key");
  }

  await store.persistAtomically(
    options.knownHostsPath,
    new TextEncoder().encode(`${matching[0]?.line}\n`),
    0o600,
  );
}

const nodeKnownHostsFiles: KnownHostsFileSystem = {
  async writeExclusive(path, contents, mode) {
    await writeFile(path, contents, { flag: "wx", mode });
  },
  async syncFile(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async syncDirectory(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async remove(path) {
    await rm(path);
  },
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export class NodeKnownHostsStore implements KnownHostsStore {
  constructor(
    private readonly files: KnownHostsFileSystem = nodeKnownHostsFiles,
    private readonly createToken: () => string = randomUUID,
  ) {}

  async persistAtomically(path: string, contents: Uint8Array, mode: number): Promise<void> {
    assertText(path, "known_hosts path");
    if (mode !== 0o600) throw new Error("known_hosts mode must be 0600");
    const token = this.createToken();
    if (!/^[A-Za-z0-9._-]+$/u.test(token)) throw new Error("invalid known_hosts temporary token");
    const temporaryPath = `${path}.tmp-${token}`;
    let created = false;
    let renamed = false;
    try {
      await this.files.writeExclusive(temporaryPath, contents, 0o600);
      created = true;
      await this.files.syncFile(temporaryPath);
      await this.files.rename(temporaryPath, path);
      created = false;
      renamed = true;
      await this.files.syncDirectory(dirname(path));
    } catch (error) {
      if (!renamed && (created || errorCode(error) !== "EEXIST")) {
        try {
          await this.files.remove(temporaryPath);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "known_hosts persistence and cleanup failed",
          );
        }
      }
      throw error;
    }
  }
}
