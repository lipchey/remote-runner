import { expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/config.js";

class FakeNamespace {
  names: string[] = [];
  requests: Request[] = [];
  idFromName(name: string) {
    this.names.push(name);
    return "id";
  }
  get(id: string) {
    expect(id).toBe("id");
    return {
      fetch: async (request: Request) => {
        this.requests.push(request);
        return new Response("accepted", { status: 202 });
      },
    };
  }
}
it("Worker routes only POST heartbeat to the ariadne object and returns 404/405 otherwise", async () => {
  const namespace = new FakeNamespace();
  const env = { ROUTER: namespace } as unknown as Env;
  const request = new Request("https://worker/heartbeat", { method: "POST", body: "{}" });
  expect((await worker.fetch(request, env)).status).toBe(202);
  expect(namespace.names).toEqual(["ariadne"]);
  expect(namespace.requests[0]).toBe(request);
  expect((await worker.fetch(new Request("https://worker/other", { method: "POST" }), env)).status).toBe(404);
  expect((await worker.fetch(new Request("https://worker/heartbeat"), env)).status).toBe(405);
  expect(namespace.requests).toHaveLength(1);
});
it("scheduled requests a reconcile through the same ariadne object", async () => {
  const namespace = new FakeNamespace();
  const env = { ROUTER: namespace } as unknown as Env;
  await worker.scheduled({} as ScheduledController, env);
  expect(namespace.names).toEqual(["ariadne"]);
  expect(namespace.requests).toHaveLength(1);
  expect(namespace.requests[0]!.method).toBe("POST");
  expect(new URL(namespace.requests[0]!.url).pathname).toBe("/reconcile");
});
