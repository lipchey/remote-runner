import { describe, expect, it } from "vitest";

import {
  loadTelegramConfig,
  sendTelegramNotification,
  type TelegramRuntime,
} from "../../../src/notifications/telegram.js";
import type { FallbackEvent, NotificationEvent } from "../../../src/notifications/outage.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

class FakeRuntime implements TelegramRuntime {
  readonly requests: unknown[] = [];
  uid = 501;
  owner = 501;
  mode = 0o600;
  kind: "file" | "other" = "file";
  contents = 'BOT_TOKEN="123456:abcdefghijklmnopqrstuvwxyz_ABCD"\nCHAT_ID=-100123456\n';
  response = { status: 200, body: bytes('{"ok":true}') };
  async currentUid() {
    return this.uid;
  }
  async readConfigFile() {
    const contents = bytes(this.contents);
    return { contents, uid: this.owner, mode: this.mode, kind: this.kind, size: contents.byteLength };
  }
  async request(request: unknown) {
    this.requests.push(request);
    return this.response;
  }
}

describe("Telegram transport", () => {
  it("loads only the owner-only regular config without shell evaluation", async () => {
    const runtime = new FakeRuntime();
    await expect(loadTelegramConfig(runtime, "/Users/admin/.claude/.telegram-ask.conf")).resolves.toEqual({
      botToken: "123456:abcdefghijklmnopqrstuvwxyz_ABCD",
      chatId: "-100123456",
    });
  });

  it.each([
    ["wrong owner", { owner: 502 }],
    ["group readable", { mode: 0o640 }],
    ["world readable", { mode: 0o604 }],
    ["not regular", { kind: "other" as const }],
  ])("rejects %s metadata before reading", async (_label, patch) => {
    const runtime = Object.assign(new FakeRuntime(), patch);
    await expect(loadTelegramConfig(runtime, "/config")).rejects.toThrow();
  });

  it.each([
    "BOT_TOKEN=x\nCHAT_ID=123\n",
    "BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz_ABCD\nCHAT_ID=chat\n",
    "BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz_ABCD\n",
    "BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz_ABCD\nCHAT_ID=123\nEXTRA=secret\n",
    "BOT_TOKEN=one\nBOT_TOKEN=two\nCHAT_ID=123\n",
  ])("rejects malformed or non-closed config", async (contents) => {
    const runtime = new FakeRuntime();
    runtime.contents = contents;
    await expect(loadTelegramConfig(runtime, "/config")).rejects.toThrow();
  });

  it("posts one bounded Telegram message without placing token in body or errors", async () => {
    const runtime = new FakeRuntime();
    const config = await loadTelegramConfig(runtime, "/config");
    const event = {
      kind: "outage" as const,
      consumer: "ariadne",
      profile: "verify-full",
      remoteLabel: "pop-os",
      reason: "transport",
      timestamp: "2026-07-31T16:00:00.000Z",
    };
    await sendTelegramNotification(runtime, config, event);
    expect(runtime.requests).toHaveLength(1);
    const request = runtime.requests[0] as { url: URL; body: Uint8Array };
    expect(request.url.href).toContain("api.telegram.org/bot");
    expect(request.url.href).toContain(config.botToken);
    const body = new TextDecoder().decode(request.body);
    expect(body).toContain("Remote unavailable");
    /* The outage is raised before the run decides whether to fall back, and `fallback: fail`
       profiles never do — so the heading may not promise the reader a local run. */
    expect(body).not.toContain("local fallback");
    expect(body).not.toContain(config.botToken);
    expect(body).not.toContain("secret-canary");
  });

  it.each([
    ["outage", "Remote unavailable"],
    ["recovery", "Remote recovered — child started"],
  ] as const)("renders the explicit v1 %s heading", async (kind, heading) => {
    const runtime = new FakeRuntime();
    const config = await loadTelegramConfig(runtime, "/config");
    const event: NotificationEvent = {
      kind,
      consumer: "ariadne",
      profile: "verify-full",
      remoteLabel: "pop-os",
      reason: "transport",
      timestamp: "2026-07-31T16:00:00.000Z",
    };

    await sendTelegramNotification(runtime, config, event);

    const body = new TextDecoder().decode((runtime.requests[0] as { body: Uint8Array }).body);
    expect(body).toContain(heading);
  });

  it.each([
    [
      {
        kind: "primary-down",
        class: "reachability",
        reason: "transport",
      },
      "Primary remote unreachable — running on verify-full",
      "class=reachability",
    ],
    [
      {
        kind: "primary-refused",
        class: "security",
        reason: "host-key",
      },
      "Remote run refused — security",
      "class=security",
    ],
    [
      {
        kind: "primary-recovered",
        cleared: "both",
      },
      "Primary remote recovered — child started",
      "cleared=both",
    ],
  ] as const)("renders the explicit v2 $0.kind fields", async (specific, heading, detail) => {
    const runtime = new FakeRuntime();
    const config = await loadTelegramConfig(runtime, "/config");
    const event = {
      ...specific,
      consumer: "ariadne",
      requested: "verify-full-pop-os",
      fallback: "verify-full",
      remoteLabel: "pop-os",
      timestamp: "2026-07-31T16:00:00.000Z",
    } as FallbackEvent;

    await sendTelegramNotification(runtime, config, event);

    const body = new TextDecoder().decode((runtime.requests[0] as { body: Uint8Array }).body);
    expect(body).toContain(heading);
    expect(body).toContain("requested=verify-full-pop-os");
    expect(body).toContain("fallback=verify-full");
    expect(body).toContain(detail);
  });

  it("fails with a redacted error on non-success without echoing response or token", async () => {
    const runtime = new FakeRuntime();
    runtime.response = { status: 500, body: bytes("secret-canary") };
    const config = await loadTelegramConfig(runtime, "/config");
    let message = "";
    try {
      await sendTelegramNotification(runtime, config, {
        kind: "recovery",
        consumer: "ariadne",
        profile: "verify-full",
        remoteLabel: "pop-os",
        reason: "transport",
        timestamp: "2026-07-31T16:00:00.000Z",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Telegram notification failed");
    expect(message).not.toContain("secret-canary");
    expect(message).not.toContain(config.botToken);
  });
});
