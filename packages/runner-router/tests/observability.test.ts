import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterCore } from "../src/core.js";
import type { Deadline } from "../src/github.js";
import { RouterObject } from "../src/router-object.js";
import { Telegram } from "../src/telegram.js";
import { FakeGitHub, FakeStorage, FakeTelegram } from "./fakes.js";
import { config, control, heartbeat, runners, start } from "./fixtures.js";

const deadline: Deadline = { timeout: () => new AbortController().signal };

afterEach(() => vi.restoreAllMocks());

function setup() {
  let now = start;
  const storage = new FakeStorage();
  const github = new FakeGitHub();
  const telegram = new FakeTelegram();
  storage.values.set("ctl", control());
  storage.values.set("hb", heartbeat());
  const settings = { ...config, laptopAdmissionLabels: ["ci-active", "popos"] as const };
  const ports = { now: () => now, storage, github, telegram, deadline };
  const core = new RouterCore(settings, ports);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    storage,
    github,
    telegram,
    settings,
    ports,
    core,
    log,
    setTime: (at: number) => {
      now = at;
    },
    records: (event: string) =>
      log.mock.calls.map(([record]) => record as Record<string, unknown>).filter((record) => record.event === event),
  };
}

describe("router observability", () => {
  it("emits one complete reconcile record with successful additions and queued messages", async () => {
    const test = setup();
    test.storage.values.set("ctl", { ...control(), applied: "off" });
    test.storage.values.set("hb", heartbeat(start - 31_000));
    test.github.roster = runners([]);
    await test.core.reconcile();
    await test.core.flushed;
    expect(test.records("reconcile")).toHaveLength(1);
    expect(test.records("reconcile")[0]).toEqual({
      event: "reconcile",
      at: start,
      kind: "known",
      desired: "on",
      applied: "on",
      previousApplied: "off",
      pcHealthy: false,
      offAuthorized: false,
      healthySince: null,
      healthyForS: null,
      unknownSince: null,
      cooldownUntil: null,
      retryAt: null,
      heartbeat: { ageS: 31, counter: start - 31_000, githubProbe: true, probeFailures: 0, reportHealthySince: start },
      pcRunners: [
        { name: "popos-1", unit: "active", listener: true, status: "online", busy: false, labels: ["ci-active"] },
        { name: "popos-2", unit: null, listener: null, status: null, busy: null, labels: [] },
        { name: "popos-3", unit: null, listener: null, status: null, busy: null, labels: [] },
      ],
      laptop: { id: 4, status: "online", busy: false, labels: [] },
      readback: { kind: "ok", status: "online", labels: ["ci-active", "popos"] },
      mutations: [{ op: "add", labels: ["ci-active", "popos"], result: "ok" }],
      decisions: [
        {
          at: start,
          hbCounter: start - 31_000,
          hbAcceptedAt: start - 31_000,
          kind: "known",
          desired: "on",
          pcHealthy: false,
          offAuthorized: false,
          healthySince: null,
          lastKnownEvalAt: start,
        },
      ],
      unknownReason: null,
      alerts: { laptopMissing: false, unknown: false, noHeartbeat: false },
      queued: [{ id: 1, text: expect.any(String) }],
      outbox: { pending: 1, dropped: 0 },
      durationMs: 0,
    });
    expect(test.github.calls).toEqual(["list", "add:4:ci-active,popos", "get:4"]);
    expect(test.records("telegram")).toEqual([{ event: "telegram", id: 1, ok: true }]);
  });

  it("captures every removal decision and a failed mutation as the final unknown outcome", async () => {
    const test = setup();
    const now = start + 120_000;
    test.setTime(now);
    test.storage.values.set("ctl", { ...control(), lastKnownEvalAt: now - 1_000 });
    test.storage.values.set("hb", heartbeat(now));
    test.github.roster = runners(["ci-active", "popos"]);
    test.github.removeResults = [
      { kind: "ok", value: undefined },
      { kind: "unknown", reason: "remove response lost" },
    ];
    await test.core.reconcile();
    await test.core.flushed;
    const record = test.records("reconcile")[0];
    expect(record).toMatchObject({
      kind: "unknown",
      desired: "off",
      applied: "on",
      previousApplied: "on",
      pcHealthy: false,
      offAuthorized: true,
      healthySince: null,
      healthyForS: null,
      unknownSince: now,
      retryAt: now + 10_000,
      laptop: { id: 4, labels: ["ci-active", "popos"] },
      readback: { kind: "ok", status: "online", labels: ["popos"] },
      unknownReason: "remove response lost",
      mutations: [
        { op: "remove", labels: ["ci-active"], result: "ok" },
        { op: "remove", labels: ["popos"], result: "unknown", reason: "remove response lost" },
      ],
    });
    expect(record?.decisions).toEqual(
      Array.from({ length: 3 }, () => ({
        at: now,
        hbCounter: now,
        hbAcceptedAt: now,
        kind: "known",
        desired: "off",
        pcHealthy: true,
        offAuthorized: true,
        healthySince: start,
        lastKnownEvalAt: now,
      })),
    );
    expect(test.github.calls).toEqual(["list", "remove:4:ci-active", "remove:4:popos", "get:4"]);
  });

  it("records a fresh pre-removal decision that stops the second removal", async () => {
    const test = setup();
    const now = start + 120_000;
    test.setTime(now);
    test.storage.values.set("ctl", { ...control(), lastKnownEvalAt: now - 1_000 });
    test.storage.values.set("hb", heartbeat(now));
    test.github.roster = runners(["ci-active", "popos"]);
    test.github.onRemove = async () => {
      const fresh = heartbeat(now + 1_000, null);
      fresh.report.runners[0]!.listener = false;
      test.storage.values.set("hb", fresh);
      test.setTime(now + 1_000);
    };
    await test.core.reconcile();
    await test.core.flushed;
    const record = test.records("reconcile")[0];
    expect(record).toMatchObject({
      kind: "known",
      desired: "on",
      offAuthorized: false,
      applied: "on",
      pcHealthy: false,
    });
    expect(record?.decisions).toEqual([
      expect.objectContaining({ desired: "off", hbCounter: now }),
      expect.objectContaining({ desired: "off", hbCounter: now }),
      expect.objectContaining({
        desired: "on",
        hbCounter: now + 1_000,
        hbAcceptedAt: now + 1_000,
        offAuthorized: false,
      }),
    ]);
    expect(test.github.calls).toEqual(["list", "remove:4:ci-active", "get:4"]);
  });

  it("logs heartbeat rejection and one failed Telegram attempt without repeating text", async () => {
    const test = setup();
    expect(await test.core.heartbeat(heartbeat().report)).toMatchObject({ kind: "rejected", status: 409 });
    test.telegram.fail = true;
    test.storage.values.set("outbox", { messages: [{ id: 7, text: "old queued text" }], nextId: 8, dropped: 0 });
    await test.core.reconcile();
    await test.core.flushed;
    expect(test.records("heartbeat_rejected")).toEqual([
      { event: "heartbeat_rejected", status: 409, reason: "counter did not increase" },
    ]);
    expect(test.records("telegram")).toEqual([{ event: "telegram", id: 7, ok: false }]);
    expect(JSON.stringify(test.records("telegram"))).not.toContain("old queued text");
  });

  it("logs the partial trace and rethrows the original storage rejection", async () => {
    const test = setup();
    const failure = new Error("atomic storage failure");
    const put = test.storage.put.bind(test.storage);
    vi.spyOn(test.storage, "put").mockImplementation(async (key, value) => {
      if (typeof key !== "string") throw failure;
      return put(key, value);
    });
    await expect(test.core.reconcile()).rejects.toBe(failure);
    expect(test.records("reconcile")).toEqual([]);
    expect(test.records("reconcile_error")).toEqual([
      expect.objectContaining({
        event: "reconcile_error",
        error: failure.message,
        decisions: [expect.objectContaining({ desired: "on" })],
        mutations: [{ op: "add", labels: ["popos"], result: "ok" }],
      }),
    ]);
    expect(test.storage.alarm).not.toBeNull();
  });

  it("logs a rejected flush without changing its swallowed rejection", async () => {
    const test = setup();
    test.storage.values.set("outbox", { messages: [{ id: 7, text: "queued" }], nextId: 8, dropped: 0 });
    test.telegram.onSend = async () => {
      test.storage.onRead = (key) => {
        if (key === "outbox") {
          test.storage.onRead = undefined;
          throw new Error("ack storage failure");
        }
      };
    };
    await test.core.reconcile();
    await expect(test.core.flushed).resolves.toBeUndefined();
    expect(test.records("telegram")).toEqual([{ event: "telegram", id: 7, ok: true }]);
    expect(test.records("flush_error")).toEqual([{ event: "flush_error", error: "ack storage failure" }]);
  });

  it("logs real Telegram HTTP failure status", async () => {
    const test = setup();
    const telegram = new Telegram(test.settings, async () => new Response('{"ok":false}', { status: 429 }), deadline);
    expect(await telegram.send("message")).toBe(false);
    expect(test.records("telegram_error")).toEqual([{ event: "telegram_error", status: 429 }]);
  });

  it("scrubs a secret that straddles the Telegram truncation budget", async () => {
    const secret = "STRADDLE_SENTINEL_0123456789abcdef0123456789abcdef";
    for (let pad = 3880; pad < 4000; pad += 7) {
      const test = setup();
      const core = new RouterCore({ ...test.settings, heartbeatSecret: secret }, test.ports);
      test.storage.values.set("ctl", { ...control(), unknownSince: start - 180_000 });
      test.github.listResult = { kind: "unknown", reason: `${"x".repeat(pad)}${secret}` };
      await core.reconcile();
      const [record] = test.records("reconcile");
      expect((record?.queued as unknown[]).length).toBe(1);
      expect(JSON.stringify(record)).not.toContain(secret.slice(0, 16));
      vi.restoreAllMocks();
    }
  });

  it("secret sentinel covers rotated tokens, real Telegram, and RouterObject authorization", async () => {
    const captures: unknown[][] = [];
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captures.push(args);
      });
    const markers = [
      "HEARTBEAT_SENTINEL_714",
      "BOT_SENTINEL_829",
      "PEM_BODY_SENTINEL_936474",
      "TOKEN_A_SENTINEL_145",
      "TOKEN_B_SENTINEL_256",
      "AUTHORIZATION_SENTINEL_367",
    ];
    const [heartbeatSecret, botToken, pemLine, tokenA, tokenB, authorization] = markers as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const settings = {
      ...config,
      heartbeatSecret,
      telegramBotToken: botToken,
      githubAppPrivateKey: `-----BEGIN PRIVATE KEY-----\n${pemLine}\n-----END PRIVATE KEY-----`,
    };
    const storage = new FakeStorage();
    storage.values.set("ctl", {
      ...control(),
      unknownSince: start - 180_000,
      token: { value: tokenA, expiresAt: start + 10_000 },
    });
    const github = new FakeGitHub();
    github.onList = async () => {
      github.token = { value: tokenB, expiresAt: start + 100_000 };
    };
    github.listResult = { kind: "unknown", reason: markers.slice(0, 5).join(" ") };
    const telegram = new Telegram(
      settings,
      async (url) => {
        throw new Error(`fetch failed: ${url}`);
      },
      deadline,
    );
    const core = new RouterCore(settings, { now: () => start, storage, github, telegram, deadline });
    await core.rejectHeartbeat({ kind: "rejected", status: 400, reason: markers.slice(0, 4).join(" ") });
    await core.reconcile();
    await core.flushed;
    const state = { storage: new FakeStorage(), waitUntil: () => {} } as unknown as DurableObjectState;
    const object = new RouterObject(state, {
      ROUTER: {} as DurableObjectNamespace,
      REPO: settings.repo,
      PC_RUNNERS: settings.pcRunners.join(","),
      LAPTOP_RUNNER: settings.laptopRunner,
      LAPTOP_ADMISSION_LABELS: settings.laptopAdmissionLabels.join(","),
      GITHUB_APP_ID: settings.githubAppId,
      GITHUB_APP_INSTALLATION_ID: settings.githubAppInstallationId,
      HEARTBEAT_SECRET: heartbeatSecret,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_CHAT_ID: settings.telegramChatId,
      GITHUB_APP_PRIVATE_KEY: settings.githubAppPrivateKey,
    });
    const response = await object.fetch(
      new Request("https://router.test/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${authorization}` },
      }),
    );
    expect(response.status).toBe(401);
    const records = captures
      .flat()
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
    expect(records.map((record) => record.event)).toEqual(
      expect.arrayContaining(["heartbeat_rejected", "reconcile", "telegram_error", "telegram"]),
    );
    expect(records.filter((record) => record.event === "heartbeat_rejected")).toHaveLength(2);
    expect(records).toContainEqual({ event: "heartbeat_rejected", status: 401, reason: "bearer mismatch" });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "reconcile",
        kind: "unknown",
        queued: [expect.objectContaining({ id: 1, text: expect.any(String) })],
      }),
    );
    const output = JSON.stringify(captures);
    for (const marker of markers) expect(output).not.toContain(marker);
  });
});
