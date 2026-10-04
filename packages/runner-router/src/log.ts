import type { Config } from "./config.js";

export function configSecrets(config: Config): string[] {
  return [config.heartbeatSecret, config.telegramBotToken, config.githubAppPrivateKey];
}

/* Runtime-minted credentials (App JWT, rotated installation token) are not in the secret list
   but can arrive in echoed error text. */
const CREDENTIAL_SHAPES =
  /Bearer\s+[^\s;,"']+|\bgh[a-z]_[A-Za-z0-9_]{20,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\d{6,}:[\w-]{30,}/g;

function scrub(value: unknown, pattern: RegExp | undefined): unknown {
  if (typeof value === "string")
    return (pattern ? value.replace(pattern, () => "[redacted]") : value).replace(CREDENTIAL_SHAPES, "[redacted]");
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, pattern));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry, pattern)]));
  return value;
}

export function writeLog(event: string, fields: Record<string, unknown>, secrets: readonly string[]): void {
  try {
    const values = [
      ...new Set(secrets.flatMap((secret) => [secret, ...secret.split(/\r?\n/).filter((line) => line.length >= 16)])),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const pattern = values.length
      ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
      : undefined;
    console.log(JSON.parse(JSON.stringify(scrub({ event, ...fields }, pattern))));
  } catch {
    try {
      console.log({ event, logError: true });
    } catch {}
  }
}
