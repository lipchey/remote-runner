import { generateKeyPairSync } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { appJwt, GitHub } from "../src/github.js";
import { config, runners, start } from "./fixtures.js";
import { FakeFetch } from "./fakes.js";

let pkcs1: string;
let pkcs8: string;
let publicKey: string;
beforeAll(() => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pkcs1 = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  pkcs8 = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
});
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
function wireRunner(index = 0) {
  const runner = runners()[index]!;
  return { ...runner, labels: runner.labels.map((name) => ({ name })) };
}
function cached(fake: FakeFetch, now = () => start) {
  const github = new GitHub(config, fake.fetch, now);
  github.token = { value: "cached", expiresAt: start + 3_600_000 };
  return github;
}

it("robustness: PKCS#1 wraps to PKCS#8 and both import through WebCrypto for RS256 JWTs", async () => {
  const key = await crypto.subtle.importKey(
    "spki",
    Buffer.from(publicKey.replace(/-----[^-]+-----|\s/g, ""), "base64"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const pem of [pkcs1, pkcs8]) {
    const jwt = await appJwt({ ...config, githubAppPrivateKey: pem }, start);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: start / 1000 - 60,
      exp: start / 1000 + 540,
      iss: "123",
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        Buffer.from(signature!, "base64url"),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  }
});
it("roster follows Link pagination with per_page=100 and validates total_count", async () => {
  const fake = new FakeFetch();
  fake.responses = [
    response({ total_count: 2, runners: [wireRunner()] }, 200, {
      Link: '<https://api.github.com/repos/lipchey/ariadne/actions/runners?per_page=100&page=2>; rel="next"',
    }),
    response({ total_count: 2, runners: [wireRunner(1)] }),
  ];
  expect(await cached(fake).list(new AbortController().signal)).toEqual({ kind: "ok", value: runners() });
  expect(fake.calls.map((call) => new URL(call.url).searchParams.get("per_page"))).toEqual(["100", "100"]);
  for (const page of [
    { total_count: 3, runners: [wireRunner()] },
    { total_count: 1, runners: [{}] },
    { total_count: -1, runners: [] },
  ]) {
    fake.responses = [response(page)];
    expect((await cached(fake).list(new AbortController().signal)).kind).toBe("unknown");
  }
});
it("pagination refuses foreign next URLs and repeated pages", async () => {
  for (const next of [
    "https://attacker.invalid/runners?page=2",
    "https://api.github.com/repos/lipchey/ariadne/actions/runners?per_page=100",
  ]) {
    const fake = new FakeFetch();
    fake.responses = [response({ total_count: 2, runners: [wireRunner()] }, 200, { Link: `<${next}>; rel="next"` })];
    expect((await cached(fake).list(new AbortController().signal)).kind).toBe("unknown");
    expect(fake.calls).toHaveLength(1);
  }
});
it("roster accepts GitHub repository-id pagination links", async () => {
  const fake = new FakeFetch();
  fake.responses = [
    response({ total_count: 2, runners: [wireRunner()] }, 200, {
      Link: '<https://api.github.com/repositories/123/actions/runners?per_page=100&page=2>; rel="next"',
    }),
    response({ total_count: 2, runners: [wireRunner(1)] }),
  ];
  expect(await cached(fake).list(new AbortController().signal)).toEqual({ kind: "ok", value: runners() });
});
it("tokens refresh at expiry minus five minutes and a 401 refreshes exactly once", async () => {
  const fake = new FakeFetch();
  const github = new GitHub({ ...config, githubAppPrivateKey: pkcs1 }, fake.fetch, () => start);
  github.token = { value: "old", expiresAt: start + 300_000 };
  fake.responses = [
    response({ token: "new", expires_at: new Date(start + 3_600_000).toISOString() }),
    response({}, 401),
    response({ token: "retry", expires_at: new Date(start + 3_600_000).toISOString() }),
    response({ total_count: 0, runners: [] }),
  ];
  expect((await github.list(new AbortController().signal)).kind).toBe("ok");
  expect(github.token?.value).toBe("retry");
  expect(fake.calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(2);
  fake.responses = [
    response({}, 401),
    response({ token: "once", expires_at: new Date(start + 3_600_000).toISOString() }),
    response({}, 401),
  ];
  expect((await github.list(new AbortController().signal)).kind).toBe("unknown");
  expect(github.token).toBeNull();
});
it("403/429 rate limits become cooldowns of at least 60 seconds", async () => {
  for (const [status, headers, delay] of [
    [429, { "retry-after": "5" }, 60_000],
    [403, { "retry-after": "90" }, 90_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1120" }, 120_000],
    [429, {}, 60_000],
    [429, { "retry-after": new Date(start + 120_000).toUTCString() }, 120_000],
  ] as const) {
    const fake = new FakeFetch();
    fake.responses = [response({}, status, headers)];
    expect(await cached(fake).list(new AbortController().signal)).toMatchObject({
      kind: "cooldown",
      until: start + delay,
    });
  }
  const fake = new FakeFetch();
  fake.responses = [response({}, 403)];
  expect((await cached(fake).list(new AbortController().signal)).kind).toBe("unknown");
});
it("labels add in one POST, DELETE 404 is absent, and GET re-reads the runner", async () => {
  const fake = new FakeFetch();
  const github = cached(fake);
  const laptop = runners()[1]!;
  fake.responses = [response({}), response({}, 404), response(wireRunner(1))];
  expect((await github.add(laptop, ["ci-active"], new AbortController().signal)).kind).toBe("ok");
  expect((await github.remove(laptop, "ci-active", new AbortController().signal)).kind).toBe("ok");
  expect(await github.get(laptop, new AbortController().signal)).toEqual({ kind: "ok", value: laptop });
  expect(fake.calls.map((call) => call.init.method)).toEqual(["POST", "DELETE", "GET"]);
  expect(JSON.parse(String(fake.calls[0]!.init.body))).toEqual({ labels: ["ci-active"] });
});
it("secondary rate limits use reset only when the primary quota is exhausted", async () => {
  for (const remaining of ["10", "0"]) {
    const fake = new FakeFetch();
    fake.responses = [
      response({}, 429, {
        "retry-after": "60",
        "x-ratelimit-remaining": remaining,
        "x-ratelimit-reset": String((start + 3_600_000) / 1000),
      }),
    ];
    expect(await cached(fake).list(new AbortController().signal)).toMatchObject({
      kind: "cooldown",
      until: start + (remaining === "0" ? 3_600_000 : 60_000),
    });
  }
});
it("robustness: mutations throw for other registrations or out-of-allowlist labels", async () => {
  const fake = new FakeFetch();
  const github = cached(fake);
  const signal = new AbortController().signal;
  await expect(github.add(runners()[0]!, ["ci-active"], signal)).rejects.toThrow();
  await expect(github.remove(runners()[0]!, "ci-active", signal)).rejects.toThrow();
  await expect(github.add(runners()[1]!, ["Linux"], signal)).rejects.toThrow();
  await expect(github.remove(runners()[1]!, "popos", signal)).rejects.toThrow();
  expect(fake.calls).toHaveLength(0);
});
it("each fetch combines the shared deadline with a five-second timeout and never starts after abort", async () => {
  vi.useFakeTimers();
  try {
    const fake = new FakeFetch();
    fake.responses = [
      async (init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    ];
    const github = new GitHub(config, fake.fetch, () => start, {
      timeout: (ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      },
    });
    github.token = { value: "cached", expiresAt: start + 3_600_000 };
    const controller = new AbortController();
    const pending = github.list(controller.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).kind).toBe("unknown");
    controller.abort();
    expect((await github.list(controller.signal)).kind).toBe("unknown");
    expect(fake.calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("uses a redirect mode workerd accepts", async () => {
  const fake = new FakeFetch();
  fake.responses.push(response({ total_count: 1, runners: [wireRunner()] }));
  await cached(fake).list(new AbortController().signal);
  expect(fake.calls[0]!.init.redirect).toBe("manual");
});
