import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { nodeLockFiles } from "../../../src/node/lock-files.js";
import { createFallbackCallbacks, NodeTelegramRuntime } from "../../../src/node/notifications.js";
import type { FallbackContext, FallbackState } from "../../../src/notifications/outage.js";
import type { TelegramRuntime } from "../../../src/notifications/telegram.js";
import { acquireProfileLock } from "../../../src/runtime/lock.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const context: FallbackContext = {
  consumer: "ariadne",
  requested: "verify-full-pop-os",
  fallback: "verify-full",
  remoteLabel: "pop-os",
  topology: {
    target: "runner@pop-os",
    hostKeySha256: "SHA256:primary",
    fallback: "verify-full",
    fallbackTarget: "runner@fallback",
  },
};

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

class CountingTelegram implements TelegramRuntime {
  requests = 0;

  async currentUid(): Promise<number> {
    return 501;
  }

  async readConfigFile() {
    const contents = bytes("BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz_ABCD\nCHAT_ID=123\n");
    return { contents, uid: 501, mode: 0o600, kind: "file" as const, size: contents.byteLength };
  }

  async request() {
    this.requests += 1;
    return { status: 200, body: bytes('{"ok":true}') };
  }
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "remote-runner-fallback-"));
  temporaryRoots.push(home);
  return home;
}

function fallbackDirectory(home: string): string {
  return join(home, ".local", "state", "remote-runner", "fallback", context.consumer, context.requested);
}

function statePath(home: string): string {
  return join(fallbackDirectory(home), "state.json");
}

function callbacks(
  home: string,
  telegram: TelegramRuntime,
  stderr: string[] = [],
  patch: Partial<Parameters<typeof createFallbackCallbacks>[0]> = {},
) {
  return createFallbackCallbacks({
    home,
    context,
    configPath: join(home, "telegram.conf"),
    telegram,
    stderr: (line) => stderr.push(line),
    ...patch,
  });
}

async function holdFallbackLock(home: string): Promise<() => Promise<void>> {
  const directory = fallbackDirectory(home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return acquireProfileLock(
    {
      files: nodeLockFiles(),
      processes: { isAlive: async (pid) => pid === process.pid },
      clock: {
        now: Date.now,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
      lockDirectory: () => join(directory, "lock"),
      pid: process.pid,
      leaseDurationMs: 120_000,
      pollIntervalMs: 10,
      createToken: randomUUID,
    },
    `${context.consumer}/${context.requested}`,
    1_000,
  );
}

describe("NodeTelegramRuntime", () => {
  it("reads contents and metadata from one secure regular-file descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-telegram-"));
    const path = join(root, "telegram.conf");
    await writeFile(path, "BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nCHAT_ID=123\n");
    await chmod(path, 0o600);

    const file = await new NodeTelegramRuntime().readConfigFile(path);

    expect(file.kind).toBe("file");
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.size).toBe(file.contents.byteLength);
  });

  it("refuses to follow a symlink to the Telegram config", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-telegram-link-"));
    const target = join(root, "target.conf");
    const link = join(root, "telegram.conf");
    await writeFile(target, "BOT_TOKEN=123:abcdefghijklmnopqrstuvwxyz\nCHAT_ID=123\n");
    await symlink(target, link);

    await expect(new NodeTelegramRuntime().readConfigFile(link)).rejects.toThrow();
  });
});

describe("fallback notification callbacks", () => {
  it("twenty concurrent transitions send exactly one primary-down", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    const notifications = callbacks(home, telegram);

    await Promise.all(Array.from({ length: 20 }, () => notifications.observeUnreachable("transport")));

    expect(telegram.requests).toBe(1);
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({
      outage: { reason: "transport" },
    });
  });

  it("twenty concurrent primary child starts send exactly one primary-recovered", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    const notifications = callbacks(home, telegram);
    await notifications.observeUnreachable("transport");

    await Promise.all(Array.from({ length: 20 }, () => notifications.observePrimaryChildStarted()));

    expect(telegram.requests).toBe(2);
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({ outage: null });
  });

  it("creates the fallback directory at 0700 on first access", async () => {
    const home = await temporaryHome();

    await callbacks(home, new CountingTelegram()).observeUnreachable("transport");

    expect((await stat(fallbackDirectory(home))).mode & 0o777).toBe(0o700);
  });

  it("writes state under fallback/<consumer>/<primary>/state.json with mode 0600", async () => {
    const home = await temporaryHome();

    await callbacks(home, new CountingTelegram()).observeUnreachable("transport");

    expect((await stat(statePath(home))).mode & 0o777).toBe(0o600);
  });

  it("retires v1 outage files of the primary once", async () => {
    const home = await temporaryHome();
    const stateRoot = join(home, ".local", "state", "remote-runner", "profiles", context.consumer);
    const primary = join(stateRoot, context.requested, "identity");
    const fallback = join(stateRoot, context.fallback, "identity");
    await mkdir(primary, { recursive: true });
    await mkdir(fallback, { recursive: true });
    await writeFile(join(primary, "outage.json"), '{"queue":["legacy"]}');
    await writeFile(join(fallback, "outage.json"), '{"queue":["fallback"]}');
    const stderr: string[] = [];
    const notifications = callbacks(home, new CountingTelegram(), stderr);

    await notifications.observeReachable();
    await notifications.observeReachable();

    await expect(readFile(join(primary, "outage.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(primary, "outage.v1-retired.json"), "utf8")).resolves.toContain("legacy");
    await expect(readFile(join(fallback, "outage.json"), "utf8")).resolves.toContain("fallback");
    expect(stderr.filter((line) => line.includes("retired"))).toHaveLength(1);
  });

  it("a topology mismatch warns, resets transitions, and sends nothing", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    await callbacks(home, telegram).observeUnreachable("transport");
    const stderr: string[] = [];
    const changed = callbacks(home, telegram, stderr, {
      context: {
        ...context,
        topology: { ...context.topology, target: "runner@replacement" },
      },
    });

    await changed.observeUnreachable("transport");

    expect(telegram.requests).toBe(1);
    expect(stderr).toContain("remote-runner: fallback topology changed; state reset");
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({
      topology: { target: "runner@replacement" },
      outage: null,
      refusal: null,
      negative: null,
      lease: null,
    });
  });

  it("selects from a lock-free read when the lock is held past the budget", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    const stderr: string[] = [];
    const notifications = callbacks(home, telegram, stderr, { lockWaitMs: 0 });
    await notifications.observeUnreachable("transport");
    const release = await holdFallbackLock(home);

    await expect(notifications.selectPrimary()).resolves.toBe(false);

    expect((JSON.parse(await readFile(statePath(home), "utf8")) as FallbackState).lease).toBeNull();
    expect(stderr).toContain("remote-runner: fallback state busy");
    await release();
  });

  it("a skipped observeUnreachable is re-observed by the next probe", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    const stderr: string[] = [];
    const notifications = callbacks(home, telegram, stderr, { lockWaitMs: 0 });
    const release = await holdFallbackLock(home);

    await notifications.observeUnreachable("transport");
    expect(telegram.requests).toBe(0);
    await release();

    await notifications.observeUnreachable("transport");
    expect(telegram.requests).toBe(1);
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({ outage: { reason: "transport" } });
  });

  it("a skipped recovery is retried by the next primary child start", async () => {
    const home = await temporaryHome();
    const telegram = new CountingTelegram();
    const notifications = callbacks(home, telegram, [], { lockWaitMs: 0 });
    await notifications.observeUnreachable("transport");
    const release = await holdFallbackLock(home);

    await notifications.observePrimaryChildStarted();
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({ outage: { reason: "transport" } });
    await release();

    await notifications.observePrimaryChildStarted();
    expect(telegram.requests).toBe(2);
    expect(JSON.parse(await readFile(statePath(home), "utf8"))).toMatchObject({ outage: null });
  });
});
