import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

import {
  recordFallback as recordOutage,
  recordRemoteChildStarted as recordRecovery,
  type NotificationContext,
  type OutageRuntime,
  type OutageState,
} from "../notifications/outage.js";
import {
  loadTelegramConfig,
  sendTelegramNotification,
  type SecureConfigFile,
  type TelegramRuntime,
} from "../notifications/telegram.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

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
  readonly telegram?: NodeTelegramRuntime;
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
