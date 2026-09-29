import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  observePrimaryChildStarted,
  observeReachable,
  observeRefused,
  observeUnreachable,
  recordFallback as recordOutage,
  recordRemoteChildStarted as recordRecovery,
  selectPrimary as selectFallbackPrimary,
  type DeliveryResult,
  type FallbackContext,
  type FallbackRuntime,
  type FallbackState,
  type NotificationContext,
  type OutageRuntime,
  type OutageState,
} from "../notifications/outage.js";
import { NodeProcessRuntime } from "./process.js";
import { nodeLockFiles } from "./lock-files.js";
import {
  loadTelegramConfig,
  sendTelegramNotification,
  type SecureConfigFile,
  type TelegramRuntime,
} from "../notifications/telegram.js";
import { acquireProfileLock, LockReleaseRetryableError, LockTimeoutError } from "../runtime/lock.js";
import type { FailureClass } from "../run/prepare.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CONSUMER = /^[a-z][a-z0-9-]{0,62}$/u;
const PROFILE = /^[a-z][a-z0-9-]*$/u;

export class NodeTelegramRuntime implements TelegramRuntime {
  async currentUid(): Promise<number> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("current uid is unavailable");
    return uid;
  }

  async readConfigFile(path: string): Promise<SecureConfigFile> {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (before.size > MAX_CONFIG_BYTES) throw new Error("Telegram config exceeds the size limit");
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      const after = await handle.stat();
      if (
        bytesRead > MAX_CONFIG_BYTES ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        after.size !== bytesRead
      )
        throw new Error("Telegram config changed while reading");
      return {
        contents: buffer.subarray(0, bytesRead),
        uid: after.uid,
        mode: after.mode,
        kind: after.isFile() ? "file" : "other",
        size: after.size,
      };
    } finally {
      await handle.close();
    }
  }

  async request(request: {
    readonly method: "POST";
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly timeoutMs: number;
  }): Promise<{ readonly status: number; readonly body: Uint8Array }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: Buffer.from(request.body),
        signal: controller.signal,
      });
      if (response.body === null) return { status: response.status, body: new Uint8Array() };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Telegram response exceeds the size limit");
        }
        chunks.push(value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NodeNotificationOptions {
  readonly statePath: string;
  readonly configPath: string;
  readonly context: NotificationContext;
  readonly stderr: (line: string) => void;
  readonly telegram?: TelegramRuntime;
}

export function createNodeNotificationCallbacks(options: NodeNotificationOptions): {
  readonly recordFallback: (reason: string) => Promise<void>;
  readonly recordRemoteChildStarted: () => Promise<void>;
} {
  const telegram = options.telegram ?? new NodeTelegramRuntime();
  const runtime: OutageRuntime = {
    async readState() {
      try {
        return JSON.parse(await readFile(options.statePath, "utf8")) as OutageState;
      } catch (caught) {
        if (
          typeof caught === "object" &&
          caught !== null &&
          "code" in caught &&
          (caught as { code?: unknown }).code === "ENOENT"
        )
          return undefined;
        throw caught;
      }
    },
    async writeState(state) {
      await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${options.statePath}.tmp-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      await rename(temporary, options.statePath);
    },
    now: () => new Date().toISOString(),
    async send(event) {
      const config = await loadTelegramConfig(telegram, options.configPath);
      await sendTelegramNotification(telegram, config, event);
    },
  };

  const visible = async (
    operation: () => Promise<{ readonly delivered: boolean; readonly pending: number }>,
  ): Promise<void> => {
    try {
      const result = await operation();
      if (!result.delivered || result.pending > 0) options.stderr("remote-runner: Telegram notification pending");
    } catch {
      options.stderr("remote-runner: Telegram notification state failed");
      throw new Error("notification state failed");
    }
  };
  return {
    recordFallback: (reason) => visible(() => recordOutage(runtime, options.context, reason)),
    recordRemoteChildStarted: () => visible(() => recordRecovery(runtime, options.context)),
  };
}

export interface FallbackNotificationOptions {
  readonly home: string;
  readonly context: FallbackContext;
  readonly configPath: string;
  readonly stderr: (line: string) => void;
  readonly telegram?: TelegramRuntime;
  readonly lockWaitMs?: number;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (caught) {
    if (
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw caught;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function retirePrimaryV1(home: string, context: FallbackContext, stderr: (line: string) => void): Promise<void> {
  const root = join(home, ".local", "state", "remote-runner", "profiles", context.consumer, context.requested);
  let identities;
  try {
    identities = await readdir(root, { withFileTypes: true });
  } catch (caught) {
    if (
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw caught;
  }
  let retired = 0;
  for (const identity of identities) {
    if (!identity.isDirectory()) continue;
    try {
      await rename(join(root, identity.name, "outage.json"), join(root, identity.name, "outage.v1-retired.json"));
      retired += 1;
    } catch (caught) {
      if (
        typeof caught !== "object" ||
        caught === null ||
        !("code" in caught) ||
        (caught as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw caught;
      }
    }
  }
  if (retired > 0) stderr(`remote-runner: retired ${retired} legacy outage state file${retired === 1 ? "" : "s"}`);
}

async function releaseFallbackLock(release: () => Promise<void>, waitBudgetMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(waitBudgetMs, 1_000);
  for (;;) {
    try {
      await release();
      return;
    } catch (caught) {
      if (!(caught instanceof LockReleaseRetryableError) || Date.now() >= deadline) throw caught;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export function createFallbackCallbacks(options: FallbackNotificationOptions): {
  readonly selectPrimary: () => Promise<boolean>;
  readonly observeUnreachable: (reason: string) => Promise<void>;
  readonly observeReachable: () => Promise<void>;
  readonly observeRefused: (failureClass: FailureClass, reason: string) => Promise<void>;
  readonly observePrimaryChildStarted: () => Promise<void>;
} {
  if (!CONSUMER.test(options.context.consumer) || !PROFILE.test(options.context.requested)) {
    throw new Error("fallback namespace is invalid");
  }
  const directory = join(
    options.home,
    ".local",
    "state",
    "remote-runner",
    "fallback",
    options.context.consumer,
    options.context.requested,
  );
  const statePath = join(directory, "state.json");
  const telegram = options.telegram ?? new NodeTelegramRuntime();
  const processes = new NodeProcessRuntime();
  const runtime: FallbackRuntime = {
    readState: () => readOptionalJson(statePath),
    writeState: (state) => writeJson(statePath, state),
    nowMs: Date.now,
    send: async (event) => {
      const config = await loadTelegramConfig(telegram, options.configPath);
      await sendTelegramNotification(telegram, config, event);
    },
    warn: options.stderr,
    withLock: async (operation) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await acquireProfileLock(
        {
          files: nodeLockFiles(),
          processes,
          clock: {
            now: Date.now,
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          },
          lockDirectory: () => join(directory, "lock"),
          pid: process.pid,
          leaseDurationMs: 120_000,
          pollIntervalMs: 100,
          createToken: randomUUID,
        },
        `${options.context.consumer}/${options.context.requested}`,
        options.lockWaitMs ?? 30_000,
      );
      try {
        await retirePrimaryV1(options.home, options.context, options.stderr);
        return await operation();
      } finally {
        await releaseFallbackLock(release, options.lockWaitMs ?? 30_000);
      }
    },
  };

  const visible = async (operation: () => Promise<DeliveryResult>): Promise<void> => {
    try {
      const result = await operation();
      if (!result.delivered || result.pending > 0) options.stderr("remote-runner: Telegram notification pending");
    } catch (caught) {
      if (caught instanceof LockTimeoutError) {
        options.stderr("remote-runner: fallback state busy");
        return;
      }
      options.stderr("remote-runner: Telegram notification state failed");
      throw new Error("notification state failed");
    }
  };

  return {
    selectPrimary: async () => {
      try {
        return await selectFallbackPrimary(runtime, options.context);
      } catch (caught) {
        if (!(caught instanceof LockTimeoutError)) {
          options.stderr("remote-runner: Telegram notification state failed");
          throw new Error("notification state failed");
        }
        options.stderr("remote-runner: fallback state busy");
        return selectFallbackPrimary(
          {
            ...runtime,
            writeState: async (_state: FallbackState) => undefined,
            warn: () => undefined,
            withLock: async (operation) => operation(),
          },
          options.context,
        );
      }
    },
    observeUnreachable: (reason) => visible(() => observeUnreachable(runtime, options.context, reason)),
    observeReachable: () => visible(() => observeReachable(runtime, options.context)),
    observeRefused: (failureClass, reason) =>
      visible(() => observeRefused(runtime, options.context, failureClass, reason)),
    observePrimaryChildStarted: () => visible(() => observePrimaryChildStarted(runtime, options.context)),
  };
}
