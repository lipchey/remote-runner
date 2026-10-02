import { expect, it, vi } from "vitest";
import { Telegram } from "../src/telegram.js";
import { config } from "./fixtures.js";

it("sendMessage posts plain text and returns ok only for HTTP and API success", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses = [
    new Response('{"ok":true}'),
    new Response('{"ok":false}'),
    new Response('{"ok":true}', { status: 500 }),
    new Response("invalid"),
  ];
  const telegram = new Telegram(config, async (url, init) => {
    calls.push({ url, init });
    return responses.shift()!;
  });
  expect(await telegram.send("hello <world>")).toBe(true);
  expect(calls[0]!.url).toBe("https://api.telegram.org/botbot-token/sendMessage");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chat_id: "chat", text: "hello <world>" });
  for (let index = 0; index < 3; index++) expect(await telegram.send("hello")).toBe(false);
});
it("sendMessage fails after a deterministic five-second timeout", async () => {
  vi.useFakeTimers();
  try {
    const telegram = new Telegram(
      config,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
      {
        timeout: (ms) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), ms);
          return controller.signal;
        },
      },
    );
    const send = telegram.send("hello");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await send).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
