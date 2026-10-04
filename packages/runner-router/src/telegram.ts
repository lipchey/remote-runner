import type { Config } from "./config.js";
import type { TelegramPort } from "./core.js";
import { realDeadline, type Deadline, type Fetch } from "./github.js";
import { configSecrets, writeLog } from "./log.js";

export class Telegram implements TelegramPort {
  constructor(
    private readonly config: Config,
    private readonly fetch: Fetch,
    private readonly deadline: Deadline = realDeadline,
  ) {}
  async send(text: string): Promise<boolean> {
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.config.telegramChatId, text }),
        signal: this.deadline.timeout(5000),
      });
      const body: unknown = await response.json();
      const ok = response.ok && typeof body === "object" && body !== null && "ok" in body && body.ok === true;
      if (!ok) writeLog("telegram_error", { status: response.status }, configSecrets(this.config));
      return ok;
    } catch (error) {
      writeLog(
        "telegram_error",
        { error: error instanceof Error ? error.message : String(error) },
        configSecrets(this.config),
      );
      return false;
    }
  }
}
