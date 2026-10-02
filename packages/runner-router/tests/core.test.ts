import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RouterCore, type Outbox } from "../src/core.js";
import type { Control, Runner } from "../src/decide.js";
import { GitHub, type Deadline, type Fetch } from "../src/github.js";
import { type Heartbeat } from "../src/heartbeat.js";
import { config, control, heartbeat, runners, start } from "./fixtures.js";
import { deferred, FakeFetch, FakeGitHub, FakeStorage, FakeTelegram } from "./fakes.js";

function setup(options: { cold?: boolean; both?: boolean } = {}) {
  let time = start;
  const storage = new FakeStorage();
  const github = new FakeGitHub();
  const telegram = new FakeTelegram();
  const deadline: Deadline = { timeout: () => new AbortController().signal };
  const settings = options.both ? { ...config, laptopAdmissionLabels: ["ci-active", "popos"] as const } : config;
  if (!options.cold) {
    storage.values.set("ctl", control());
    storage.values.set("hb", heartbeat());
  }
  const ports = { now: () => time, storage, github, telegram, deadline };
  const core = new RouterCore(settings, ports);
  return {
    core,
    ports,
    settings,
    storage,
    github,
    telegram,
    setTime: (now: number) => {
      time = now;
    },
  };
}
async function ctl(storage: FakeStorage) {
  return (await storage.get<Control>("ctl"))!;
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function mature(test: ReturnType<typeof setup>) {
  test.setTime(start + 120_000);
  test.storage.values.set("ctl", { ...control(), lastKnownEvalAt: start + 119_000 });
  test.storage.values.set("hb", heartbeat(start + 120_000));
}

it("item 2: a late alarm uses current now and enables fallback", async () => {
  const test = setup();
  test.github.roster = runners([]);
  test.storage.values.set("ctl", { ...control(), applied: "off", healthySince: start - 120_001 });
  test.storage.values.set("hb", heartbeat(start, start - 120_001));
  test.storage.alarm = start + 30_000;
  test.setTime(start + 70_000);
  await test.core.reconcile();
  expect(test.github.calls).toContain("add:4:ci-active");
  expect((await ctl(test.storage)).applied).toBe("on");
  expect((await ctl(test.storage)).healthySince).toBeNull();
});
it("item 3: lease expiry enables fallback even with a healthy roster", async () => {
  const test = setup();
  test.github.roster = runners([]);
  test.storage.values.set("ctl", { ...control(), applied: "off", healthySince: start - 120_001 });
  test.storage.values.set("hb", heartbeat(start, start - 120_001));
  test.setTime(start + 30_000);
  await test.core.reconcile();
  expect(test.github.calls).toContain("add:4:ci-active");
  expect(await ctl(test.storage)).toMatchObject({ applied: "on", healthySince: null });
});
it("item 6: unknown never mutates for roster errors, timeout, incomplete pages, token failure, repeated 401 or cooldown", async () => {
  for (const reason of [
    "roster error",
    "timeout",
    "incomplete pagination",
    "token failure",
    "401 twice",
    "429 cooldown",
  ]) {
    const test = setup();
    test.github.listResult =
      reason === "429 cooldown" ? { kind: "cooldown", reason, until: start + 60_000 } : { kind: "unknown", reason };
    await test.core.reconcile();
    expect(test.github.calls).toEqual(["list"]);
    expect(await ctl(test.storage)).toMatchObject({ applied: "on", healthySince: null, unknownSince: start });
    expect(test.storage.alarm).toBe(start + (reason === "429 cooldown" ? 60_000 : 10_000));
  }
});
it("item 9: concurrent reconciles serialize GitHub mutations", async () => {
  const test = setup();
  test.github.roster = runners([]);
  const entered = deferred();
  const release = deferred();
  test.github.onAdd = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = test.core.reconcile();
  await entered.promise;
  const second = test.core.reconcile();
  await Promise.resolve();
  expect(test.github.calls).toEqual(["list", "add:4:ci-active"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(test.github.calls).toEqual(["list", "add:4:ci-active", "get:4", "list", "get:4"]);
});
it("item 10: a throwing pass retains the earliest pending alarm deadline", async () => {
  const test = setup();
  test.storage.values.set("ctl", { ...control(), retryAt: start + 5_000 });
  test.storage.failAtomic = true;
  await expect(test.core.reconcile()).rejects.toThrow("atomic failure");
  expect(test.storage.alarm).toBe(start + 5_000);
});
it("item 11: cold start enables fallback when known, never mutates when unknown, and alerts after five minutes across restart", async () => {
  const known = setup({ cold: true });
  known.github.roster = runners([]);
  await known.core.reconcile();
  await settle();
  expect(known.github.calls).toContain("add:4:ci-active");
  const test = setup({ cold: true });
  test.github.listResult = { kind: "unknown", reason: "offline" };
  await test.core.reconcile();
  await settle();
  expect(test.github.calls).toEqual(["list"]);
  expect((await ctl(test.storage)).createdAt).toBe(start);
  test.setTime(start + 299_999);
  const restarted = new RouterCore(config, test.ports);
  await restarted.reconcile();
  await settle();
  expect(test.telegram.messages.filter((text) => text.includes("No accepted heartbeat"))).toHaveLength(0);
  test.setTime(start + 300_000);
  await restarted.reconcile();
  await settle();
  await restarted.reconcile();
  await settle();
  expect(test.telegram.messages.filter((text) => text.includes("No accepted heartbeat"))).toHaveLength(1);
});
it("item 12: a re-registered laptop is found by name and its new id is repaired", async () => {
  const test = setup();
  test.storage.values.delete("hb");
  test.github.roster = runners([], 99);
  await test.core.reconcile();
  expect(test.github.calls).toContain("add:99:ci-active");
});
it("item 13 storage: every rejected report preserves hb and records lastRejected", async () => {
  const test = setup();
  const previous = structuredClone(test.storage.values.get("hb"));
  expect((await test.core.heartbeat(heartbeat().report)).kind).toBe("rejected");
  expect(test.storage.values.get("hb")).toEqual(previous);
  expect(test.storage.values.get("lastRejected")).toMatchObject({ at: start, reason: "counter did not increase" });
  await test.core.rejectHeartbeat({ kind: "rejected", status: 400, reason: "invalid report schema" });
  expect(test.storage.values.get("lastRejected")).toEqual({ at: start, reason: "invalid report schema" });
});
it("race: a heartbeat accepted during the roster await makes wake schedule an immediate second pass", async () => {
  const test = setup();
  const entered = deferred();
  const release = deferred();
  test.github.onList = async () => {
    entered.resolve();
    await release.promise;
  };
  const pass = test.core.reconcile();
  await entered.promise;
  test.setTime(start + 1_000);
  expect(await test.core.heartbeat(heartbeat(start + 1_000).report)).toEqual({ kind: "ok" });
  release.resolve();
  await pass;
  expect(test.storage.alarm).toBe(start + 1_000);
  test.github.onList = undefined;
  await test.core.reconcile();
  expect(test.github.calls.filter((call) => call === "list")).toHaveLength(2);
});
it("race: a lease that expires during the roster await never turns fallback OFF", async () => {
  for (const present of [true, false]) {
    const test = setup();
    mature(test);
    if (!present) test.github.roster = runners().slice(0, 1);
    test.github.onList = async () => {
      test.setTime(start + 150_000);
    };
    await test.core.reconcile();
    expect(test.github.calls.some((call) => call.startsWith("remove"))).toBe(false);
    expect((await ctl(test.storage)).applied).toBe("on");
    expect(await ctl(test.storage)).toMatchObject({ healthySince: null, lastKnownEvalAt: start + 150_000 });
  }
});
it("race: an unhealthy report immediately before removal aborts OFF", async () => {
  const test = setup();
  mature(test);
  let reads = 0;
  test.storage.onRead = (key) => {
    if (key === "hb" && ++reads === 2) {
      test.storage.values.set("hb", {
        ...heartbeat(start + 120_000),
        reportHealthySince: null,
        report: { ...heartbeat(start + 120_000).report, githubProbe: false },
      });
    }
  };
  await test.core.reconcile();
  expect(test.github.calls.some((call) => call.startsWith("remove"))).toBe(false);
  expect((await ctl(test.storage)).healthySince).toBeNull();
});
it("race: fresh health is checked before every removal including between compatibility labels", async () => {
  const test = setup({ both: true });
  mature(test);
  test.github.roster = runners(["ci-active", "popos"]);
  test.github.onRemove = async () => {
    test.storage.values.set("hb", { ...heartbeat(start + 120_000), reportHealthySince: null });
  };
  test.storage.onRead = (key) => {
    const hb = test.storage.values.get("hb") as Heartbeat;
    if (key === "hb" && hb?.reportHealthySince === null) hb.report.githubProbe = false;
  };
  await test.core.reconcile();
  expect(test.github.calls.filter((call) => call.startsWith("remove"))).toEqual(["remove:4:ci-active"]);
});
it("robustness: partial removal and a 404 retry converge using re-read applied state", async () => {
  const test = setup({ both: true });
  mature(test);
  const fake = new FakeFetch();
  const github = new GitHub(test.settings, fake.fetch, test.ports.now, test.ports.deadline);
  test.storage.values.set("ctl", {
    ...control(),
    lastKnownEvalAt: start + 119_000,
    token: { value: "cached", expiresAt: start + 3_600_000 },
  });
  const core = new RouterCore(test.settings, { ...test.ports, github });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const wire = (runner: Runner) => ({ ...runner, labels: runner.labels.map((name) => ({ name })) });
  const roster = () => json({ total_count: 2, runners: runners(["ci-active", "popos"]).map(wire) });
  const actual = (labels: string[]) => json(wire(runners(labels)[1]!));
  fake.responses = [roster(), new Response(null, { status: 204 }), json({}, 500), actual(["popos"])];
  await core.reconcile();
  await settle();
  expect((await ctl(test.storage)).applied).toBe("on");
  expect((await ctl(test.storage)).healthySince).toBeNull();
  for (const elapsed of [130_000, 160_000, 190_000, 220_000]) {
    test.setTime(start + elapsed);
    test.storage.values.set("hb", heartbeat(start + elapsed));
    fake.responses = [roster(), actual(["popos"])];
    await core.reconcile();
    await settle();
  }
  test.setTime(start + 250_000);
  test.storage.values.set("hb", heartbeat(start + 250_000));
  fake.responses = [roster(), json({}, 404), new Response(null, { status: 204 }), actual([])];
  await core.reconcile();
  await settle();
  expect((await ctl(test.storage)).applied).toBe("off");
  expect(fake.calls.filter((call) => call.init.method === "DELETE").map((call) => call.url.split("/").at(-1))).toEqual([
    "ci-active",
    "popos",
    "ci-active",
    "popos",
  ]);
  expect(test.telegram.messages.filter((text) => text.includes("Fallback OFF"))).toHaveLength(1);
});
it("robustness: a lost POST response is re-read and queues exactly one applied transition", async () => {
  const test = setup({ cold: true });
  test.github.roster = runners([]);
  test.github.addResult = { kind: "unknown", reason: "response lost" };
  await test.core.reconcile();
  await settle();
  await test.core.reconcile();
  await settle();
  expect((await ctl(test.storage)).applied).toBe("on");
  expect(test.telegram.messages.filter((text) => text.includes("Fallback ON"))).toHaveLength(1);
});
it("robustness: a shared 15-second deadline cancels hung pagination deterministically", async () => {
  vi.useFakeTimers();
  try {
    const test = setup();
    let requests = 0;
    const fakeFetch: Fetch = async (_url, init) => {
      requests++;
      if (requests < 4) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return new Response(
          JSON.stringify({
            total_count: 4,
            runners: [{ id: requests, name: `popos-${requests}`, status: "online", busy: false, labels: [] }],
          }),
          {
            headers: {
              Link: `<https://api.github.com/repos/lipchey/ariadne/actions/runners?per_page=100&page=${requests + 1}>; rel="next"`,
            },
          },
        );
      }
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const deadline = {
      timeout: (ms: number) => {
        const abort = new AbortController();
        setTimeout(() => abort.abort(), ms);
        return abort.signal;
      },
    };
    const github = new GitHub(config, fakeFetch, () => start, deadline);
    const cachedToken = { value: "cached", expiresAt: start + 3_600_000 };
    test.storage.values.set("ctl", { ...control(), token: cachedToken });
    const core = new RouterCore(config, { ...test.ports, github, deadline });
    const pass = core.reconcile();
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    void pass.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect(requests).toBe(4);
    expect((await ctl(test.storage)).unknownSince).toBe(start);
  } finally {
    vi.useRealTimers();
  }
});
it("robustness: Telegram backlog flushes outside the mutex and never delays mutation", async () => {
  const test = setup();
  test.github.roster = runners([]);
  test.storage.values.set("outbox", { messages: [{ id: 1, text: "backlog" }], nextId: 2, dropped: 0 });
  const entered = deferred();
  const release = deferred();
  test.telegram.onSend = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = test.core.reconcile();
  await entered.promise;
  test.github.roster = runners([], 99);
  const second = test.core.reconcile();
  for (let step = 0; step < 30; step++) await Promise.resolve();
  expect(test.github.calls).toContain("add:99:ci-active");
  release.resolve();
  await Promise.all([first, second]);
});
it("robustness: atomic ctl/outbox failure leaves both unchanged and still plans an alarm", async () => {
  const test = setup();
  mature(test);
  const before = await ctl(test.storage);
  const outbox: Outbox = { messages: [{ id: 1, text: "pending" }], nextId: 2, dropped: 0 };
  test.storage.values.set("outbox", outbox);
  test.storage.failAtomic = true;
  await expect(test.core.reconcile()).rejects.toThrow("atomic failure");
  expect(await ctl(test.storage)).toEqual(before);
  expect(test.storage.values.get("outbox")).toEqual(outbox);
  expect(test.storage.alarm).not.toBeNull();
});
it("heartbeat cooldown skips wake while cron requests wake and the pass honors cooldown", async () => {
  const test = setup();
  test.storage.values.set("ctl", { ...control(), cooldownUntil: start + 90_000 });
  expect(await test.core.heartbeat(heartbeat(start, start).report)).toMatchObject({ kind: "rejected" });
  test.setTime(start + 1_000);
  await test.core.heartbeat(heartbeat(start + 1_000).report);
  expect(test.storage.values.has("wake")).toBe(false);
  await test.core.requestReconcile("cron");
  expect(test.storage.alarm).toBe(start + 1_000);
  await test.core.reconcile();
  expect(test.github.calls).toEqual([]);
  expect(test.storage.alarm).toBe(start + 61_000);
});
it("alarms retain an earlier request and plan the earliest future deadline with a minute cap", async () => {
  const test = setup();
  test.storage.alarm = start - 1;
  await test.core.requestReconcile("cron");
  expect(test.storage.alarm).toBe(start - 1);
  await test.core.reconcile();
  expect(test.storage.alarm).toBe(start + 30_000);
  mature(test);
  test.storage.values.set("ctl", { ...control(), healthySince: start + 10_000, lastKnownEvalAt: start + 119_000 });
  await test.core.reconcile();
  expect(test.storage.alarm).toBe(start + 130_000);
});
it("alerts emit once per episode with recovery, rejected-report context and Worker timestamps", async () => {
  const test = setup({ cold: true });
  test.github.roster = runners();
  test.github.roster[1]!.status = "offline";
  await test.core.reconcile();
  await settle();
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages.filter((text) => text.includes("Laptop offline or absent"))).toHaveLength(1);
  test.github.roster[1]!.status = "online";
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages.some((text) => text.includes("Laptop recovered"))).toBe(true);
  test.github.listResult = { kind: "unknown", reason: "failed" };
  await test.core.reconcile();
  await settle();
  test.setTime(start + 180_000);
  await test.core.reconcile();
  await settle();
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages.filter((text) => text.includes("GitHub unknown for"))).toHaveLength(1);
  await test.core.rejectHeartbeat({ kind: "rejected", status: 400, reason: "bad counter" });
  test.setTime(start + 300_000);
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages.some((text) => text.includes("bad counter"))).toBe(true);
  test.github.listResult = undefined;
  await test.core.heartbeat(heartbeat(start + 300_000).report);
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages.some((text) => text.includes("GitHub recovered"))).toBe(true);
  expect(test.telegram.messages.some((text) => text.includes("Heartbeat recovered"))).toBe(true);
  expect(test.telegram.messages.every((text) => /^\[\d{4}-\d\d-\d\dT/.test(text))).toBe(true);
});
it("outbox drops and counts oldest entries at 64, flushes at most five and stops on first failure", async () => {
  const test = setup({ cold: true });
  test.github.roster = runners([]);
  test.storage.values.set("outbox", {
    messages: Array.from({ length: 64 }, (_, id) => ({ id, text: `old ${id}` })),
    nextId: 64,
    dropped: 0,
  });
  test.telegram.fail = true;
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages).toEqual(["old 1"]);
  expect(test.storage.values.get("outbox")).toMatchObject({ dropped: 1 });
  expect((await test.storage.get<Outbox>("outbox"))!.messages).toHaveLength(64);
  test.telegram.fail = false;
  test.telegram.messages = [];
  await test.core.reconcile();
  await settle();
  expect(test.telegram.messages).toHaveLength(5);
  expect((await test.storage.get<Outbox>("outbox"))!.messages).toHaveLength(59);
});
it("a mutation cooldown stops further GitHub calls immediately", async () => {
  const test = setup({ cold: true });
  test.github.roster = runners([]);
  test.github.addResult = { kind: "cooldown", until: start + 120_000, reason: "429" };
  await test.core.reconcile();
  expect(test.github.calls).toEqual(["list", "add:4:ci-active"]);
  expect((await ctl(test.storage)).cooldownUntil).toBe(start + 120_000);
});
it("mature PC health with an absent laptop never plans a hot-loop alarm", async () => {
  for (const healthySince of [start - 1, start + 5_000]) {
    const test = setup();
    mature(test);
    test.github.roster = runners().slice(0, 1);
    test.storage.values.set("ctl", { ...control(), healthySince, lastKnownEvalAt: start + 119_000 });
    test.telegram.fail = true;
    await test.core.reconcile();
    expect((await ctl(test.storage)).alerts.laptopMissing).toBe(true);
    expect(test.storage.alarm).toBeGreaterThanOrEqual(start + 130_000);
  }
});
it("verification cooldown overrides an unknown mutation result", async () => {
  const test = setup();
  test.storage.values.delete("hb");
  test.github.roster = runners([]);
  test.github.addResult = { kind: "unknown", reason: "500" };
  test.github.getResult = { kind: "cooldown", until: start + 120_000, reason: "429" };
  await test.core.reconcile();
  expect(await ctl(test.storage)).toMatchObject({ cooldownUntil: start + 120_000, retryAt: null });
});
it("a lease expiring while Telegram flushes schedules immediate reconciliation", async () => {
  const test = setup();
  test.setTime(start + 29_000);
  test.storage.values.set("outbox", { messages: [{ id: 1, text: "pending" }], nextId: 2, dropped: 0 });
  test.telegram.onSend = async () => {
    test.setTime(start + 30_000);
  };
  await test.core.reconcile();
  await settle();
  expect(test.storage.alarm).toBe(start + 30_000);
});
it("consecutive mutation failures retain the unknown episode until a fully known pass recovers", async () => {
  const test = setup();
  test.storage.values.delete("hb");
  test.github.addResult = { kind: "unknown", reason: "response lost" };
  for (const elapsed of [1000, 61_000, 121_000, 181_000]) {
    test.setTime(start + elapsed);
    test.github.roster = runners([]);
    await test.core.reconcile();
    await settle();
    expect((await ctl(test.storage)).unknownSince).toBe(start + 1000);
    expect((await ctl(test.storage)).lastKnownEvalAt).toBe(start);
  }
  expect(test.telegram.messages.filter((text) => text.includes("GitHub unknown for"))).toHaveLength(1);
  test.github.addResult = undefined;
  await test.core.reconcile();
  await settle();
  expect((await ctl(test.storage)).unknownSince).toBeNull();
  expect(test.telegram.messages.some((text) => text.includes("GitHub recovered"))).toBe(true);
});
it("a failed atomic commit retains an earlier durable retry deadline", async () => {
  const test = setup();
  mature(test);
  const before = {
    ...control(),
    healthySince: start + 20_000,
    retryAt: start + 125_000,
    lastKnownEvalAt: start + 119_000,
  };
  test.storage.values.set("ctl", before);
  test.storage.failAtomic = true;
  await expect(test.core.reconcile()).rejects.toThrow("atomic failure");
  expect(test.storage.values.get("ctl")).toEqual(before);
  expect(test.storage.alarm).toBe(start + 125_000);
});
it("outbox acknowledgement preserves messages appended by a concurrent reconcile", async () => {
  const test = setup();
  const committing = deferred();
  const commit = deferred();
  const ack = deferred();
  class PausingStorage extends FakeStorage {
    pauseCommit = false;
    override async put(key: string | Record<string, unknown>, value?: unknown) {
      if (key === "outbox") await ack.promise;
      if (typeof key !== "string" && this.pauseCommit) {
        this.pauseCommit = false;
        committing.resolve();
        await commit.promise;
      }
      await super.put(key, value);
    }
  }
  const storage = new PausingStorage();
  storage.values = test.storage.values;
  storage.values.set("outbox", { messages: [{ id: 1, text: "backlog" }], nextId: 2, dropped: 0 });
  const core = new RouterCore(config, { ...test.ports, storage });
  const entered = deferred();
  const release = deferred();
  test.telegram.onSend = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = core.reconcile();
  await entered.promise;
  mature(test);
  storage.pauseCommit = true;
  const second = core.reconcile();
  await committing.promise;
  test.telegram.onSend = async () => {
    test.telegram.fail = true;
  };
  release.resolve();
  await settle();
  commit.resolve();
  await Promise.all([first, second]);
  ack.resolve();
  await settle();
  expect((await storage.get<Outbox>("outbox"))!.messages.map((message) => message.text)).toEqual([
    expect.stringContaining("Fallback OFF"),
  ]);
});
it("adapter failures for all item 6 cases reach an unknown core verdict without any label HTTP mutation", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers });
  const wire = (runner: Runner) => ({ ...runner, labels: runner.labels.map((name) => ({ name })) });
  const cases = [
    { name: "roster error", responses: [json({}, 500)] },
    { name: "timeout", responses: [new Error("fetch aborted")] },
    { name: "incomplete pagination", responses: [json({ total_count: 2, runners: [wire(runners()[0]!)] })] },
    { name: "token failure", responses: [] },
    {
      name: "401 twice",
      responses: [
        json({}, 401),
        json({ token: "retry", expires_at: new Date(start + 3_600_000).toISOString() }),
        json({}, 401),
      ],
    },
    { name: "429 cooldown", responses: [json({}, 429, { "retry-after": "60" })] },
  ];
  for (const scenario of cases) {
    const test = setup();
    const fake = new FakeFetch();
    fake.responses = scenario.responses;
    const settings = { ...config, githubAppPrivateKey: scenario.name === "token failure" ? "invalid" : key };
    const github = new GitHub(settings, fake.fetch, test.ports.now, test.ports.deadline);
    test.storage.values.set("ctl", {
      ...control(),
      token: scenario.name === "token failure" ? null : { value: "cached", expiresAt: start + 3_600_000 },
    });
    await new RouterCore(settings, { ...test.ports, github }).reconcile();
    expect((await ctl(test.storage)).unknownSince, scenario.name).toBe(start);
    expect(
      fake.calls.filter((call) => call.url.includes("/labels")),
      scenario.name,
    ).toEqual([]);
  }
});
