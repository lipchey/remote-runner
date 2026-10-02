import type { Env } from "./config.js";

export default {
  fetch() {
    return new Response("Runner router is not implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
