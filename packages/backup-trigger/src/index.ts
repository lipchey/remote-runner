export interface Env {
  GITHUB_BACKUP_DISPATCH_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export interface Dependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  clock: { now: () => number; timeout: (milliseconds: number) => AbortSignal };
}

const dependencies: Dependencies = {
  fetch: (input, init) => fetch(input, init),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock: { now: () => Date.now(), timeout: (milliseconds) => AbortSignal.timeout(milliseconds) },
};

function retryDelay(header: string | null, attempt: number, now: number): number {
  if (header !== null && header.trim()) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(delay)) return Math.min(30_000, Math.max(0, delay));
  }
  return attempt === 1 ? 2000 : 8000;
}

async function telegram(env: Env, text: string, runtime: Dependencies): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) return;
  let failure: number | string;
  try {
    const response = await runtime.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: runtime.clock.timeout(5000),
    });
    if (response.ok) return;
    failure = response.status;
  } catch (error) {
    failure = error instanceof Error ? error.name : "unknown";
  }
  console.log(JSON.stringify({ event: "telegram_failed", failure }));
}

export async function dispatchBackup(env: Env, runtime: Dependencies = dependencies): Promise<void> {
  const names = ["GITHUB_BACKUP_DISPATCH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
  const secrets = names
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
  const pattern = secrets.length
    ? new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : undefined;
  const redact = (text: string) => (pattern ? text.replace(pattern, "[redacted]") : text);
  const missing = names.find((name) => typeof env[name] !== "string" || !env[name].trim());
  let reason = missing ? `Missing required secret: ${missing}` : "";
  let status: number | undefined;
  let attempts = 0;
  while (!missing && attempts < 3) {
    attempts++;
    let retryAfter: string | null = null;
    try {
      const response = await runtime.fetch(
        "https://api.github.com/repos/lipchey/ariadne/actions/workflows/backup.yml/dispatches",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_BACKUP_DISPATCH_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "backup-trigger",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main", inputs: { source: "worker" } }),
          signal: runtime.clock.timeout(10_000),
        },
      );
      status = response.status;
      if (response.ok) {
        console.log(JSON.stringify({ event: "dispatch_ok", status, attempts }));
        return;
      }
      let message = "";
      try {
        const body: unknown = await response.json();
        if (body !== null && typeof body === "object" && "message" in body && typeof body.message === "string") {
          message = redact(body.message).slice(0, 200);
        }
      } catch {}
      reason = `HTTP ${status}${message ? ` ${message}` : ""}`;
      /* Retried server errors may duplicate dispatches; the workflow concurrency group queues them safely. */
      if (status !== 429 && (status < 500 || status > 599)) break;
      retryAfter = response.headers.get("Retry-After");
    } catch (error) {
      status = undefined;
      reason = redact(error instanceof Error ? error.message : "Network error").slice(0, 200);
    }
    if (attempts < 3) await runtime.sleep(retryDelay(retryAfter, attempts, runtime.clock.now()));
  }
  console.log(JSON.stringify({ event: "dispatch_failed", status, reason, attempts }));
  const failure = `backup.yml dispatch failed${attempts > 1 ? ` after ${attempts} attempts` : ""}: ${reason}`;
  await telegram(env, `⚠️ Ariadne backup-trigger: ${failure}`, runtime);
  throw new Error(failure);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env) {
    await dispatchBackup(env);
  },
} satisfies ExportedHandler<Env>;
