import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";

import type { BoundedProcessRequest, BoundedProcessResult, SshProcessRuntime } from "../ssh/client.js";

function mergedEnvironment(update?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return update === undefined ? { ...process.env } : { ...process.env, ...update };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

export class NodeProcessRuntime implements SshProcessRuntime {
  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
      throw new Error("maxOutputBytes must be a positive safe integer");
    }
    return new Promise((resolve) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: mergedEnvironment(request.environment),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputTruncated = false;
      let spawned = true;
      let settled = false;

      const capture = (target: Buffer[], chunk: Buffer, current: number): number => {
        const remaining = Math.max(0, request.maxOutputBytes - current);
        if (chunk.byteLength > remaining) {
          if (remaining > 0) target.push(chunk.subarray(0, remaining));
          outputTruncated = true;
          child.kill("SIGKILL");
          return request.maxOutputBytes;
        }
        target.push(chunk);
        return current + chunk.byteLength;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
      child.on("error", () => { spawned = false; });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const observedExitCode = spawned ? (code ?? signalExitCode(signal)) : 127;
        resolve({
          exitCode: outputTruncated && observedExitCode === 0 ? 75 : observedExitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          outputTruncated,
        });
      });
      child.stdin.on("error", () => undefined);
      if (request.stdin === undefined) child.stdin.end();
      else {
        const copied = Buffer.from(request.stdin);
        request.stdin.fill(0);
        child.stdin.end(copied);
      }
    });
  }

  async isAlive(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (caught) {
      return typeof caught === "object" && caught !== null && "code" in caught &&
        (caught as { readonly code?: unknown }).code === "EPERM";
    }
  }
}

export interface StreamingProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly marker: Uint8Array;
  readonly onMarker: () => Promise<void>;
  readonly stdout: (chunk: Uint8Array) => void;
  readonly stderr: (chunk: Uint8Array) => void;
}

export interface StreamingProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly markerSeen: boolean;
  readonly spawned: boolean;
}

function retainedPrefixLength(contents: Buffer, marker: Buffer): number {
  const maximum = Math.min(contents.byteLength, marker.byteLength - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (contents.subarray(contents.byteLength - length).equals(marker.subarray(0, length))) return length;
  }
  return 0;
}

export async function runStreamingProcess(
  request: StreamingProcessRequest,
): Promise<StreamingProcessResult> {
  if (request.marker.byteLength === 0) throw new Error("stream marker must not be empty");
  const marker = Buffer.from(request.marker);
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: mergedEnvironment(request.environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawned = true;
    let markerSeen = false;
    let pending = Buffer.alloc(0);
    let streamFailure: unknown;
    let markerPromise: Promise<void> = Promise.resolve();

    const failStream = (caught: unknown): void => {
      if (streamFailure !== undefined) return;
      streamFailure = caught;
      child.kill("SIGKILL");
    };
    const write = (writer: (chunk: Uint8Array) => void, chunk: Buffer): void => {
      if (chunk.byteLength === 0) return;
      try { writer(chunk); } catch (caught) { failStream(caught); }
    };
    child.stdout.on("data", (chunk: Buffer) => write(request.stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (markerSeen) {
        write(request.stderr, chunk);
        return;
      }
      const contents = Buffer.concat([pending, chunk]);
      const markerIndex = contents.indexOf(marker);
      if (markerIndex >= 0) {
        write(request.stderr, contents.subarray(0, markerIndex));
        pending = Buffer.alloc(0);
        markerSeen = true;
        markerPromise = Promise.resolve().then(request.onMarker).catch((caught) => {
          failStream(caught);
          throw caught;
        });
        write(request.stderr, contents.subarray(markerIndex + marker.byteLength));
        return;
      }
      const retained = retainedPrefixLength(contents, marker);
      write(request.stderr, contents.subarray(0, contents.byteLength - retained));
      pending = contents.subarray(contents.byteLength - retained);
    });
    child.stderr.on("end", () => {
      if (!markerSeen) write(request.stderr, pending);
      pending = Buffer.alloc(0);
    });
    child.on("error", () => { spawned = false; });
    child.on("close", (code, signal) => {
      void markerPromise.then(() => {
        if (streamFailure !== undefined) reject(streamFailure);
        else resolve({
          exitCode: spawned ? (code ?? signalExitCode(signal)) : 127,
          signal,
          markerSeen,
          spawned,
        });
      }, reject);
    });
    child.stdin.on("error", () => undefined);
    if (request.stdin === undefined) child.stdin.end();
    else {
      const copied = Buffer.from(request.stdin);
      request.stdin.fill(0);
      child.stdin.end(copied);
    }
  });
}
