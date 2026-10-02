import type { Env } from "./config.js";
export { RouterObject } from "./router-object.js";

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== "/heartbeat") return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    return env.ROUTER.get(env.ROUTER.idFromName("ariadne")).fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await env.ROUTER.get(env.ROUTER.idFromName("ariadne")).fetch(
      new Request("https://router/reconcile", { method: "POST" }),
    );
  },
} satisfies ExportedHandler<Env>;
