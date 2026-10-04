import { afterEach, describe, expect, it, vi } from "vitest";

const moduleUrl = new URL("../../scripts/logs.mjs", import.meta.url);
const { parseArgs, queryBody, queryLogs, eventRecord, renderEvent, main } = await import(moduleUrl.href);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const from = Date.UTC(2026, 9, 4, 9);
const to = from + 3_600_000;
const event = {
  $metadata: { id: "first", timestamp: from, service: "runner-router" },
  source: {
    message: [
      {
        event: "reconcile",
        at: from,
        kind: "known",
        desired: "off",
        applied: "on",
        pcHealthy: true,
        heartbeat: { ageS: 2 },
        mutations: [{ op: "remove", labels: ["ci-active"], result: "unknown" }],
        unknownReason: "response\nlost",
      },
    ],
  },
};

describe("Workers Logs reader", () => {
  it("parses defaults, duration units, event and JSON flags", () => {
    expect(parseArgs([])).toEqual({ sinceMs: 3_600_000, event: null, json: false });
    expect(parseArgs(["--since", "15m", "--event", "reconcile", "--json"])).toEqual({
      sinceMs: 900_000,
      event: "reconcile",
      json: true,
    });
    expect(parseArgs(["--since", "2h"]).sinceMs).toBe(7_200_000);
    expect(parseArgs(["--since", "3d"]).sinceMs).toBe(259_200_000);
  });

  it.each([
    ["--unknown"],
    ["--since"],
    ["--since", "0m"],
    ["--since", "-1h"],
    ["--since", "1w"],
    ["--since", "1.5h"],
    ["--since", "999999999999999999999d"],
    ["--event"],
    ["--event", "--json"],
  ])("rejects %j before vault access", async (...args: string[]) => {
    const readSecret = vi.fn(() => {
      throw new Error("vault must not be read");
    });
    await expect(main(args, readSecret)).rejects.toThrow("Invalid arguments");
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each([false, true])("prints event-filtered output (JSON=%s) using only reader vault keys", async (json) => {
    const readSecret = vi.fn((key: string) => (key.endsWith("TOKEN") ? "reader-secret" : "account"));
    const pages = [
      [event, { $metadata: { id: "last", timestamp: from }, source: { event: "telegram", id: 7, ok: true } }],
      [],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: { events: { events: pages.shift() } } }))),
    );
    vi.spyOn(Date, "now").mockReturnValue(to);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--event", "reconcile", ...(json ? ["--json"] : [])], readSecret);
    expect(readSecret.mock.calls).toEqual([
      ["CLOUDFLARE_REMOTE_RUNNER_TOKEN"],
      ["CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID"],
    ]);
    expect(output).toHaveBeenCalledTimes(1);
    if (json) expect(JSON.parse(output.mock.calls[0]?.[0])).toEqual([event]);
    else expect(output.mock.calls[0]?.[0]).toContain("reconcile known off→on");
  });

  it("builds the verified service filter and cursor body", () => {
    expect(queryBody({ from, to, queryId: "query", offset: "cursor" })).toEqual({
      queryId: "query",
      timeframe: { from, to },
      view: "events",
      limit: 2000,
      offset: "cursor",
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "runner-router" }],
        filterCombination: "and",
      },
    });
    expect(queryBody({ from, to, queryId: "query" })).not.toHaveProperty("offset");
  });

  it("paginates two pages to an empty result with a fixed timeframe and query ID", async () => {
    const last = { $metadata: { id: "second", timestamp: to }, source: { event: "telegram", id: 7, ok: false } };
    const pages = [[event], [last], []];
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ success: true, result: { events: { events: pages.shift() } } })),
    );
    expect(
      await queryLogs({ token: "reader-secret", accountId: "account", sinceMs: 3_600_000, now: to, fetch }),
    ).toEqual([event, last]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    const bodies = calls.map(([url, init]) => {
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account/workers/observability/telemetry/query");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ Authorization: "Bearer reader-secret", "Content-Type": "application/json" });
      return JSON.parse(String(init.body)) as { timeframe: unknown; queryId: string; offset?: string };
    });
    expect(bodies.map((body) => body.timeframe)).toEqual(Array.from({ length: 3 }, () => ({ from, to })));
    expect(new Set(bodies.map((body) => body.queryId)).size).toBe(1);
    expect(bodies.map((body) => body.offset)).toEqual([undefined, "first", "second"]);
  });

  it("returns an empty result without requesting another page", async () => {
    const fetch = vi.fn(async () => new Response('{"success":true,"result":{"events":{"events":[]}}}'));
    expect(await queryLogs({ token: "secret", accountId: "account", sinceMs: 60_000, now: to, fetch })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops a repeated pagination cursor instead of looping", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { events: { events: [event] } } })));
    await expect(queryLogs({ token: "secret", accountId: "account", sinceMs: 60_000, now: to, fetch })).rejects.toThrow(
      "pagination did not advance",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "network", "json", "shape"])(
    "reports %s API failure without leaking the reader token",
    async (mode) => {
      const token = "READER_TOKEN_SENTINEL_417";
      const fetch = async () => {
        if (mode === "network") throw new Error(`request ${token} failed`);
        if (mode === "http")
          return new Response(JSON.stringify({ success: false, errors: [{ message: token }] }), { status: 403 });
        if (mode === "json") return new Response(token);
        return new Response(JSON.stringify({ result: token }));
      };
      const failure = await queryLogs({ token, accountId: "account", sinceMs: 60_000, now: to, fetch }).catch(
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("Cloudflare logs query failed");
      expect(failure.message).not.toContain(token);
    },
  );

  it("extracts source objects, nested records, logged objects and JSON metadata messages", () => {
    const record = { event: "heartbeat_rejected", status: 401, reason: "bearer mismatch" };
    expect(eventRecord({ source: record })).toEqual(record);
    expect(eventRecord(event)).toEqual(event.source.message[0]);
    expect(eventRecord(record)).toEqual(record);
    expect(eventRecord({ $metadata: { message: JSON.stringify(record) } })).toEqual(record);
    expect(eventRecord({ $metadata: { message: "invocation" } })).toBeNull();
  });

  it("renders a Kyiv-time incident line from the fixture and handles invocation records", () => {
    const line = renderEvent(event);
    expect(line).toContain("12:00:00 (Київ)");
    expect(line).toContain("reconcile known off→on pcHealthy=true hb=2s");
    expect(line).toContain("remove(ci-active):unknown");
    expect(line).toContain("response lost");
    expect(line).not.toContain("\n");
    expect(renderEvent({ $metadata: { timestamp: from } })).toContain("invocation");
  });
});
