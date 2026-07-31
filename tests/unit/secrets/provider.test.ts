import { describe, expect, it } from "vitest";

import { runSecretProvider, type SecretProviderRuntime } from "../../../src/secrets/provider.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

class FakeRuntime implements SecretProviderRuntime {
  readonly requests: unknown[] = [];
  constructor(private readonly result: { exitCode?: number; stdout?: string; stderr?: string; outputTruncated?: boolean }) {}
  async run(request: unknown) {
    this.requests.push(request);
    return {
      exitCode: this.result.exitCode ?? 0,
      stdout: bytes(this.result.stdout ?? ""),
      stderr: bytes(this.result.stderr ?? ""),
      outputTruncated: this.result.outputTruncated ?? false,
    };
  }
}

describe("secret provider", () => {
  it("captures one bounded JSON object and accepts only allowlisted string values", async () => {
    const runtime = new FakeRuntime({ stdout: '{"NEON_DEV_DATABASE_URL":"canary"}' });
    await expect(runSecretProvider(runtime, ["node", "scripts/env.mjs"], ["NEON_DEV_DATABASE_URL"]))
      .resolves.toEqual({ NEON_DEV_DATABASE_URL: "canary" });
    expect(runtime.requests).toEqual([{
      command: "node", args: ["scripts/env.mjs"], maxOutputBytes: 128 * 1024,
    }]);
  });

  it("preserves an empty non-executable argv element without invoking a shell", async () => {
    const runtime = new FakeRuntime({ stdout: "{}" });
    await expect(runSecretProvider(runtime, ["provider", ""], [])).resolves.toEqual({});
    expect(runtime.requests).toEqual([{ command: "provider", args: [""], maxOutputBytes: 128 * 1024 }]);
  });

  it.each([
    ["unallowlisted", '{"NEON_DATABASE_URL":"production"}', false],
    ["duplicate", '{"SECRET":"one","SECRET":"two"}', false],
    ["non-string", '{"SECRET":42}', false],
    ["NUL", '{"SECRET":"canary\\u0000suffix"}', false],
    ["truncated", '{"SECRET":"canary"}', true],
  ])("rejects %s provider output without returning captured text", async (_label, stdout, outputTruncated) => {
    const runtime = new FakeRuntime({ stdout, outputTruncated });
    await expect(runSecretProvider(runtime, ["provider"], ["SECRET"])).rejects.toThrow();
  });

  it("rejects provider failure and an invalid command before exposing output", async () => {
    await expect(runSecretProvider(new FakeRuntime({ exitCode: 9, stderr: "secret-canary" }), ["provider"], ["SECRET"]))
      .rejects.toThrow("exit code 9");
    const runtime = new FakeRuntime({ stdout: "{}" });
    await expect(runSecretProvider(runtime, [], [])).rejects.toThrow("command");
    expect(runtime.requests).toEqual([]);
  });
});
