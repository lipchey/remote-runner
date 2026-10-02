import { expect, it } from "vitest";
import { RouterObject } from "../src/router-object.js";
import type { Env } from "../src/config.js";
import { config, control, heartbeat, runners, start } from "./fixtures.js";
import { FakeStorage } from "./fakes.js";

export function environment(router: DurableObjectNamespace = {} as DurableObjectNamespace): Env {
  return {
    ROUTER: router,
    REPO: config.repo,
    PC_RUNNERS: config.pcRunners.join(","),
    LAPTOP_RUNNER: config.laptopRunner,
    LAPTOP_ADMISSION_LABELS: config.laptopAdmissionLabels.join(","),
    GITHUB_APP_ID: config.githubAppId,
    GITHUB_APP_INSTALLATION_ID: config.githubAppInstallationId,
    GITHUB_APP_PRIVATE_KEY: config.githubAppPrivateKey,
    HEARTBEAT_SECRET: config.heartbeatSecret,
    TELEGRAM_BOT_TOKEN: config.telegramBotToken,
    TELEGRAM_CHAT_ID: config.telegramChatId,
  };
}
function shell(storage = new FakeStorage()) {
  const waited: Promise<unknown>[] = [];
  const state = { storage, waitUntil: (work: Promise<unknown>) => waited.push(work) };
  return { object: new RouterObject(state as unknown as DurableObjectState, environment()), storage, waited };
}
function request(body: string, authorization = "Bearer secret") {
  return new Request("https://router/heartbeat", { method: "POST", body, headers: { Authorization: authorization } });
}
it("heartbeat authenticates before storage and validates schema before reading hb", async () => {
  const test = shell();
  expect((await test.object.fetch(request("{}", "Bearer wrong"))).status).toBe(401);
  expect(test.storage.reads).toEqual([]);
  expect((await test.object.fetch(request('{"extra":true}'))).status).toBe(400);
  expect(test.storage.reads).not.toContain("hb");
  expect(test.storage.values.get("lastRejected")).toMatchObject({ reason: "invalid report schema" });
});
it("heartbeat bounds streamed body at 4 KiB before parsing", async () => {
  const test = shell();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("https://router/heartbeat", {
    method: "POST",
    body,
    headers: { Authorization: "Bearer secret" },
    duplex: "half",
  } as RequestInit);
  expect((await test.object.fetch(req)).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(test.storage.reads).not.toContain("hb");
});
it("heartbeat persists accepted reports and routes reconcile requests without external fetches", async () => {
  const test = shell();
  const now = Date.now();
  expect((await test.object.fetch(request(JSON.stringify(heartbeat(now, now).report)))).status).toBe(202);
  expect(test.storage.values.get("hb")).toMatchObject({ acceptedAt: expect.any(Number), counter: now });
  expect(test.storage.alarm).not.toBeNull();
  expect((await test.object.fetch(new Request("https://router/reconcile", { method: "POST" }))).status).toBe(202);
  expect((await test.object.fetch(new Request("https://router/heartbeat"))).status).toBe(405);
  expect((await test.object.fetch(new Request("https://router/other"))).status).toBe(404);
  expect((await test.object.fetch(request(JSON.stringify(heartbeat(start).report)))).status).toBe(409);
});
it("heartbeat storage failure remains a server failure rather than a rejected report", async () => {
  class FailingStorage extends FakeStorage {
    override async put(key: string | Record<string, unknown>, value?: unknown) {
      if (key === "hb") throw new Error("storage unavailable");
      return super.put(key, value);
    }
  }
  const test = shell(new FailingStorage());
  const now = Date.now();
  await expect(test.object.fetch(request(JSON.stringify(heartbeat(now).report)))).rejects.toThrow(
    "storage unavailable",
  );
  expect(test.storage.values.has("lastRejected")).toBe(false);
});
it("item 13 end-to-end: each schema, runner, counter and timestamp rejection preserves hb and stores its reason", async () => {
  const test = shell();
  const now = Date.now();
  const hb = heartbeat(now);
  test.storage.values.set("hb", hb);
  const values = [
    { ...hb.report, extra: 1 },
    { ...hb.report, v: 2 },
    { ...hb.report, githubProbe: "true" },
    { ...hb.report, counter: "1" },
    { ...hb.report, counter: 1.5 },
    { ...hb.report, sentAt: "1" },
    { ...hb.report, runners: [] },
    { ...hb.report, runners: [hb.report.runners[0], hb.report.runners[0]] },
    { ...hb.report, runners: [{ name: "unknown", unit: "active", listener: true }] },
    { ...hb.report, runners: [{ name: "popos-1", unit: 1, listener: true }] },
    { ...hb.report, runners: [{ name: "popos-1", unit: "active", listener: "true" }] },
    { ...hb.report, runners: [{ ...hb.report.runners[0], extra: 1 }] },
    hb.report,
    { ...hb.report, counter: now - 1 },
    { ...hb.report, counter: now + 1, sentAt: now - 20_000 },
    { ...hb.report, counter: now + 1, sentAt: now + 20_000 },
  ];
  for (const value of values) {
    const response = await test.object.fetch(request(JSON.stringify(value)));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(test.storage.values.get("hb")).toEqual(hb);
    expect(test.storage.values.get("lastRejected")).toMatchObject({
      at: expect.any(Number),
      reason: await response.text(),
    });
  }
});
it("alarm calls GitHub with a Worker-safe fetch receiver", async () => {
  const original = globalThis.fetch;
  let reached = false;
  globalThis.fetch = async function (this: unknown, input) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    reached = true;
    const roster = runners().map((runner) => ({ ...runner, labels: runner.labels.map((name) => ({ name })) }));
    return new Response(JSON.stringify(String(input).endsWith("/4") ? roster[1] : { total_count: 2, runners: roster }));
  };
  try {
    const test = shell();
    test.storage.values.set("ctl", {
      ...control(),
      token: { value: "cached", expiresAt: Date.now() + 3_600_000 },
    });
    await test.object.alarm();
    expect(reached).toBe(true);
    expect(test.storage.values.get("ctl")).toMatchObject({ unknownSince: null });
  } finally {
    globalThis.fetch = original;
  }
});
it("alarm resolves after its mutation while Telegram never resolves", async () => {
  const original = globalThis.fetch;
  let added = false;
  let sending = false;
  const laptop = runners([])[1]!;
  const wire = () => ({ ...laptop, labels: laptop.labels.map((name) => ({ name })) });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      sending = true;
      return new Promise<Response>(() => {});
    }
    if (init?.method === "POST") {
      added = true;
      laptop.labels = ["ci-active"];
      return new Response("{}");
    }
    return new Response(JSON.stringify(String(input).endsWith("/4") ? wire() : { total_count: 1, runners: [wire()] }));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const test = shell();
    test.storage.values.set("ctl", {
      ...control(),
      applied: "off",
      healthySince: null,
      token: { value: "cached", expiresAt: Date.now() + 3_600_000 },
    });
    const resolved = await Promise.race([
      test.object.alarm().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 50);
      }),
    ]);
    expect(added).toBe(true);
    expect(test.storage.values.get("ctl")).toMatchObject({ applied: "on" });
    expect(sending).toBe(true);
    expect(resolved).toBe(true);
    expect(test.waited).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = original;
  }
});
