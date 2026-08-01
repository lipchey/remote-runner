import { describe, expect, it } from "vitest";

import { SECRET_FRAME_MAGIC, encodeSecretFrame } from "../../../src/secrets/frame.js";

describe("secret frame", () => {
  it("frames only allowlisted names and keeps values out of metadata", () => {
    const canary = "postgres://secret-canary";
    const result = encodeSecretFrame({ SECOND_SECRET: "two", NEON_DEV_DATABASE_URL: canary }, [
      "NEON_DEV_DATABASE_URL",
      "SECOND_SECRET",
    ]);
    expect(result.metadata).toEqual({
      names: ["NEON_DEV_DATABASE_URL", "SECOND_SECRET"],
      bytes: result.stdin.byteLength,
    });
    expect(JSON.stringify(result.metadata)).not.toContain(canary);
    expect(result.stdin.slice(0, SECRET_FRAME_MAGIC.byteLength)).toEqual(SECRET_FRAME_MAGIC);
  });

  it.each([
    ["unallowlisted", { UNKNOWN_SECRET: "canary" }, ["KNOWN_SECRET"]],
    ["invalid name", { mixedCase: "canary" }, ["mixedCase"]],
    ["NUL value", { KNOWN_SECRET: "canary\0suffix" }, ["KNOWN_SECRET"]],
    ["oversized value", { KNOWN_SECRET: "x".repeat(64 * 1024 + 1) }, ["KNOWN_SECRET"]],
  ])("rejects %s", (_label, values, allow) => {
    expect(() => encodeSecretFrame(values, allow)).toThrow();
  });

  it("rejects duplicate or malformed allowlist entries", () => {
    expect(() => encodeSecretFrame({ SECRET: "x" }, ["SECRET", "SECRET"])).toThrow("duplicate");
    expect(() => encodeSecretFrame({ SECRET: "x" }, ["secret"])).toThrow("allowlist");
  });
});
