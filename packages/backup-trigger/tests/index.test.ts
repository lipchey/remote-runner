import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { dispatchBackup, type Dependencies, type Env } from "../src/index.js";

const env: Env = {
  GITHUB_BACKUP_DISPATCH_TOKEN: "fixture.github+[token]",
  TELEGRAM_BOT_TOKEN: "fixture-telegram-token",
  TELEGRAM_CHAT_ID: "fixture-chat-id",
};
const githubUrl = "https://api.github.com/repos/lipchey/ariadne/actions/workflows/backup.yml/dispatches";
let log: ReturnType<typeof vi.spyOn>;

function harness(outcomes: (Response | Error)[] = [], telegramOutcome?: Response | Error) {
  const messages: string[] = [];
  const fetch = vi.fn<Dependencies["fetch"]>(async (url, init) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
      if (telegramOutcome instanceof Error) throw telegramOutcome;
      return telegramOutcome ?? Response.json({ ok: true });
    }
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? new Response(null, { status: 204 });
  });
  const dependencies: Dependencies = {
    fetch,
    sleep: vi.fn(async () => {}),
    clock: {
      now: () => Date.parse("2026-10-27T12:00:00Z"),
      timeout: vi.fn(() => new AbortController().signal),
    },
  };
  return { dependencies, fetch, messages };
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("backup dispatch", () => {
  it("exports only a scheduled handler", () => {
    expect(Object.keys(worker)).toEqual(["scheduled"]);
    expect(worker.scheduled).toBeTypeOf("function");
  });

  it("sends the exact request and records 204 without Telegram", async () => {
    const { dependencies, fetch, messages } = harness();
    await dispatchBackup(env, dependencies);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(githubUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_BACKUP_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "backup-trigger",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { source: "worker" } }),
      signal: expect.any(AbortSignal),
    });
    expect(dependencies.clock.timeout).toHaveBeenCalledWith(10_000);
    expect(dependencies.sleep).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: "dispatch_ok", status: 204, attempts: 1 });
  });

  it.each([200, 201, 202, 299])("accepts HTTP %i as success", async (status) => {
    const { dependencies, messages } = harness([new Response(null, { status })]);
    await expect(dispatchBackup(env, dependencies)).resolves.toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("retries 5xx then succeeds after two attempts", async () => {
    const { dependencies, fetch, messages } = harness([new Response(null, { status: 503 })]);
    await dispatchBackup(env, dependencies);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(2000);
    expect(messages).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: "dispatch_ok", status: 204, attempts: 2 });
  });

  it("stops after three network errors, alerts once, and throws", async () => {
    const { dependencies, fetch, messages } = harness(Array.from({ length: 3 }, () => new Error("Network down")));
    await expect(dispatchBackup(env, dependencies)).rejects.toThrow("failed after 3 attempts: Network down");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(dependencies.sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(dependencies.sleep).toHaveBeenNthCalledWith(2, 8000);
    expect(dependencies.sleep).toHaveBeenCalledTimes(2);
    expect(messages).toEqual(["⚠️ Ariadne backup-trigger: backup.yml dispatch failed after 3 attempts: Network down"]);
    expect(fetch).toHaveBeenLastCalledWith(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: messages[0] }),
      signal: expect.any(AbortSignal),
    });
    expect(dependencies.clock.timeout).toHaveBeenLastCalledWith(5000);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "dispatch_failed",
      attempts: 3,
      reason: "Network down",
    });
  });

  it.each([401, 403, 404, 422])("does not retry HTTP %i and includes only GitHub's message", async (status) => {
    const { dependencies, fetch, messages } = harness([
      Response.json({ message: "Unexpected inputs provided", detail: "private raw body" }, { status }),
    ]);
    await expect(dispatchBackup(env, dependencies)).rejects.toThrow(`HTTP ${status} Unexpected inputs provided`);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.sleep).not.toHaveBeenCalled();
    expect(messages).toEqual([
      `⚠️ Ariadne backup-trigger: backup.yml dispatch failed: HTTP ${status} Unexpected inputs provided`,
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private raw body");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dispatch_failed", status, attempts: 1 });
  });

  it("bounds repeated server errors to three attempts", async () => {
    const { dependencies, fetch, messages } = harness(
      Array.from({ length: 3 }, () => Response.json({ message: "Unavailable" }, { status: 500 })),
    );
    await expect(dispatchBackup(env, dependencies)).rejects.toThrow("failed after 3 attempts: HTTP 500 Unavailable");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(messages).toHaveLength(1);
  });

  it("retries a timeout", async () => {
    const { dependencies, messages } = harness([new DOMException("Timed out", "TimeoutError")]);
    await expect(dispatchBackup(env, dependencies)).resolves.toBeUndefined();
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(2000);
    expect(messages).toEqual([]);
  });

  it.each([
    { header: "7", expected: 7000, status: 429 },
    { header: "120", expected: 30_000, status: 429 },
    { header: "Tue, 27 Oct 2026 12:00:12 GMT", expected: 12_000, status: 503 },
    { header: "Tue, 27 Oct 2026 12:10:00 GMT", expected: 30_000, status: 429 },
    { header: "Tue, 27 Oct 2026 11:59:00 GMT", expected: 0, status: 429 },
    { header: "invalid", expected: 2000, status: 503 },
  ])("honors bounded Retry-After $header on HTTP $status", async ({ header, expected, status }) => {
    const { dependencies, messages } = harness([new Response(null, { status, headers: { "Retry-After": header } })]);
    await dispatchBackup(env, dependencies);
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(expected);
    expect(messages).toEqual([]);
  });

  it.each(["not JSON", JSON.stringify({ message: { nested: "private raw body" } })])(
    "never reports a raw response body: %s",
    async (body) => {
      const { dependencies, messages } = harness([new Response(body, { status: 422 })]);
      await expect(dispatchBackup(env, dependencies)).rejects.toThrow("HTTP 422");
      expect(messages).toEqual(["⚠️ Ariadne backup-trigger: backup.yml dispatch failed: HTTP 422"]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(body);
    },
  );

  it("redacts every secret before truncating GitHub's message to 200 characters", async () => {
    const message = `${Object.values(env).join(" ")} ${"x".repeat(300)}`;
    const { dependencies, messages } = harness([Response.json({ message }, { status: 422 })]);
    let failure = "";
    try {
      await dispatchBackup(env, dependencies);
    } catch (error) {
      failure = String(error);
    }
    expect(messages[0]?.split("HTTP 422 ")[1]).toHaveLength(200);
    expect(messages[0]).toContain("[redacted]");
    for (const secret of Object.values(env)) {
      expect(`${JSON.stringify(log.mock.calls)} ${messages.join(" ")} ${failure}`).not.toContain(secret);
    }
  });

  it("redacts credentials echoed in network errors", async () => {
    const { dependencies, messages } = harness(
      Array.from({ length: 3 }, () => new Error(`Failure ${Object.values(env).join(" ")}`)),
    );
    await expect(dispatchBackup(env, dependencies)).rejects.toThrow("[redacted]");
    for (const secret of Object.values(env)) {
      expect(`${JSON.stringify(log.mock.calls)} ${messages.join(" ")}`).not.toContain(secret);
    }
  });

  it.each([
    ["throws", new Error(`Telegram unavailable ${env.TELEGRAM_BOT_TOKEN}`)],
    ["rejects", Response.json({ ok: false }, { status: 401 })],
  ] as const)("keeps the dispatch failure and logs it when Telegram %s", async (_, telegramOutcome) => {
    const { dependencies, fetch, messages } = harness(
      [Response.json({ message: "Bad credentials" }, { status: 401 })],
      telegramOutcome,
    );
    await expect(dispatchBackup(env, dependencies)).rejects.toThrow("HTTP 401 Bad credentials");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toContain("telegram_failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it.each(Object.keys(env) as (keyof Env)[])("fails before dispatch when %s is missing", async (key) => {
    const { dependencies, fetch, messages } = harness();
    const incomplete = { ...env, [key]: undefined } as unknown as Env;
    await expect(dispatchBackup(incomplete, dependencies)).rejects.toThrow(`Missing required secret: ${key}`);
    expect(fetch.mock.calls.some(([url]) => String(url) === githubUrl)).toBe(false);
    expect(dependencies.sleep).not.toHaveBeenCalled();
    expect(messages).toHaveLength(key === "GITHUB_BACKUP_DISPATCH_TOKEN" ? 1 : 0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dispatch_failed", attempts: 0 });
  });
});
