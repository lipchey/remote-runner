import { isNotificationReason, type NotificationEvent } from "./outage.js";

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/u;
const CHAT_ID = /^-?\d+$/u;
const EVENT_FIELD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export interface SecureConfigFile {
  readonly contents: Uint8Array;
  readonly uid: number;
  readonly mode: number;
  readonly kind: "file" | "other";
  readonly size: number;
}

export interface TelegramRuntime {
  currentUid(): Promise<number>;
  readConfigFile(path: string): Promise<SecureConfigFile>;
  request(request: {
    readonly method: "POST";
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly timeoutMs: number;
  }): Promise<{ readonly status: number; readonly body: Uint8Array }>;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  if (value.includes('"') || value.includes("'")) throw new Error("Telegram config has malformed quoting");
  return value;
}

function parseConfig(contents: Uint8Array): TelegramConfig {
  if (contents.byteLength > MAX_CONFIG_BYTES) throw new Error("Telegram config exceeds the size limit");
  let text: string;
  try {
    text = decoder.decode(contents);
  } catch {
    throw new Error("Telegram config is not valid UTF-8");
  }
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error("Telegram config has an invalid assignment");
    const name = match[1]!;
    if (name !== "BOT_TOKEN" && name !== "CHAT_ID") throw new Error(`Telegram config has an unknown field: ${name}`);
    if (fields.has(name)) throw new Error(`Telegram config has a duplicate field: ${name}`);
    fields.set(name, unquote(match[2]!.trim()));
  }
  const botToken = fields.get("BOT_TOKEN");
  const chatId = fields.get("CHAT_ID");
  if (botToken === undefined || !BOT_TOKEN.test(botToken)) throw new Error("Telegram BOT_TOKEN is malformed");
  if (chatId === undefined || !CHAT_ID.test(chatId)) throw new Error("Telegram CHAT_ID must be numeric");
  return { botToken, chatId };
}

export async function loadTelegramConfig(runtime: TelegramRuntime, path: string): Promise<TelegramConfig> {
  const [uid, file] = await Promise.all([runtime.currentUid(), runtime.readConfigFile(path)]);
  if (file.kind !== "file") throw new Error("Telegram config must be a regular file");
  if (file.uid !== uid) throw new Error("Telegram config must be owned by the current user");
  if ((file.mode & 0o777) !== 0o600) throw new Error("Telegram config permissions must be 0600");
  if (!Number.isSafeInteger(file.size) || file.size !== file.contents.byteLength || file.size > MAX_CONFIG_BYTES) {
    throw new Error("Telegram config size is invalid");
  }
  return parseConfig(file.contents);
}

function eventMessage(event: NotificationEvent): string {
  for (const value of [event.consumer, event.profile, event.remoteLabel]) {
    if (!EVENT_FIELD.test(value)) throw new Error("notification event contains an invalid field");
  }
  if (!isNotificationReason(event.reason)) throw new Error("notification event contains an invalid reason");
  const timestamp = new Date(event.timestamp);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== event.timestamp) {
    throw new Error("notification timestamp must be canonical ISO-8601");
  }
  /* The heading may not promise a local fallback: the outage is raised before the run decides
     whether to take one, and `fallback: fail` profiles and a mid-run connection loss never do. */
  const heading = event.kind === "outage" ? "Remote unavailable" : "Remote recovered — child started";
  return [
    heading,
    `consumer=${event.consumer}`,
    `profile=${event.profile}`,
    `remote=${event.remoteLabel}`,
    `reason=${event.reason}`,
    `time=${event.timestamp}`,
  ].join("\n");
}

export async function sendTelegramNotification(
  runtime: TelegramRuntime,
  config: TelegramConfig,
  event: NotificationEvent,
): Promise<void> {
  const body = encoder.encode(JSON.stringify({ chat_id: config.chatId, text: eventMessage(event) }));
  let response: { readonly status: number; readonly body: Uint8Array };
  try {
    response = await runtime.request({
      method: "POST",
      url: new URL(`https://api.telegram.org/bot${config.botToken}/sendMessage`),
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch {
    throw new Error("Telegram notification failed");
  }
  if (response.status !== 200 || response.body.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Telegram notification failed");
  }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(response.body));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { ok?: unknown }).ok !== true
    ) {
      throw new Error("not ok");
    }
  } catch {
    throw new Error("Telegram notification failed");
  }
}
