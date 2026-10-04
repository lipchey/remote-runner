import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLog } from "../src/log.js";

afterEach(() => vi.restoreAllMocks());

describe("structured logs", () => {
  it("logs one object and scrubs decoded strings without changing the input", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pem =
      "-----BEGIN PRIVATE KEY-----\nPEM_BODY_SENTINEL_1234567890\nSECOND_BODY_SENTINEL_123456\n-----END PRIVATE KEY-----";
    const secrets = [
      "heartbeat-sentinel",
      'bot-"sentinel\\value',
      pem,
      "installation-sentinel",
      "",
      "overlap",
      "overlap-long",
    ];
    const fields = {
      nested: [
        { text: `heartbeat-sentinel bot-"sentinel\\value installation-sentinel ${pem}` },
        "PEM_BODY_SENTINEL_1234567890 SECOND_BODY_SENTINEL_123456 overlap-long overlap",
      ],
      number: 12,
      ok: true,
      absent: null,
      unrelated: "keep me",
    };
    const original = JSON.stringify(fields);
    writeLog("reconcile", fields, secrets);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toEqual({
      event: "reconcile",
      nested: [{ text: "[redacted] [redacted] [redacted] [redacted]" }, "[redacted] [redacted] [redacted] [redacted]"],
      number: 12,
      ok: true,
      absent: null,
      unrelated: "keep me",
    });
    expect(JSON.stringify(fields)).toBe(original);
  });

  it("redacts credential shapes that are not configured secrets", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.c2lnbmF0dXJlLXNlbnRpbmVs";
    writeLog(
      "reconcile",
      {
        reason: `GitHub fetch failed: authorization: Bearer ${jwt}; token ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`,
        url: "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
        runner: "popos-1",
      },
      [],
    );
    expect(log.mock.calls[0]?.[0]).toEqual({
      event: "reconcile",
      reason: "GitHub fetch failed: authorization: [redacted]; token [redacted]",
      url: "https://api.telegram.org/bot[redacted]/sendMessage",
      runner: "popos-1",
    });
  });

  it("falls back without exposing data or throwing when a record cannot be logged", () => {
    const log = vi
      .spyOn(console, "log")
      .mockImplementationOnce(() => {
        throw new Error("console secret");
      })
      .mockImplementation(() => {});
    expect(() => writeLog("telegram", { ok: true }, [])).not.toThrow();
    expect(log.mock.calls[1]?.[0]).toEqual({ event: "telegram", logError: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeLog("reconcile_error", circular, [])).not.toThrow();
    expect(log.mock.calls.at(-1)?.[0]).toEqual({ event: "reconcile_error", logError: true });
    log.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => writeLog("telegram", {}, [])).not.toThrow();
  });
});
