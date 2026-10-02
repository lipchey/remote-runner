import { parseConfig, type Config, type Env } from "./config.js";
import { RouterCore, type Storage } from "./core.js";
import { GitHub, realDeadline } from "./github.js";
import { bearerMatches, parseHeartbeat, type Report, type Rejection } from "./heartbeat.js";
import { Telegram } from "./telegram.js";

export class RouterObject {
  private readonly core: RouterCore;
  private readonly config: Config;
  constructor(ctx: DurableObjectState, env: Env) {
    this.config = parseConfig(env);
    const storage: Storage = {
      get: (key) => ctx.storage.get(key),
      put: (key, value) => (typeof key === "string" ? ctx.storage.put(key, value) : ctx.storage.put(key)),
      delete: (key) => ctx.storage.delete(key),
      getAlarm: () => ctx.storage.getAlarm(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
    };
    this.core = new RouterCore(this.config, {
      now: () => Date.now(),
      storage,
      github: new GitHub(
        this.config,
        (input, init) => fetch(input, init),
        () => Date.now(),
      ),
      telegram: new Telegram(this.config, (input, init) => fetch(input, init)),
      deadline: realDeadline,
    });
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/heartbeat" && path !== "/reconcile") return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (path === "/reconcile") {
      await this.core.requestReconcile("cron");
      return new Response(null, { status: 202 });
    }
    if (!bearerMatches(request.headers.get("Authorization"), this.config.heartbeatSecret))
      return new Response("Unauthorized", { status: 401 });
    let rejection: Rejection | undefined;
    let report: Report | undefined;
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (Number(request.headers.get("Content-Length")) > 4096)
        rejection = { kind: "rejected", status: 413, reason: "body exceeds 4 KiB" };
      while (reader && !rejection) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 4096) rejection = { kind: "rejected", status: 413, reason: "body exceeds 4 KiB" };
        else chunks.push(chunk.value);
      }
      if (rejection) await reader?.cancel();
      else {
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const parsed = parseHeartbeat(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
          this.config,
        );
        if (parsed.kind === "rejected") rejection = parsed;
        else report = parsed.report;
      }
    } catch {
      rejection = { kind: "rejected", status: 400, reason: "invalid request body" };
    } finally {
      reader?.releaseLock();
    }
    if (rejection) {
      await this.core.rejectHeartbeat(rejection);
      return new Response(rejection.reason, { status: rejection.status });
    }
    const result = await this.core.heartbeat(report!);
    return result.kind === "ok"
      ? new Response(null, { status: 202 })
      : new Response(result.reason, { status: result.status });
  }
  async alarm(): Promise<void> {
    await this.core.reconcile();
  }
}
