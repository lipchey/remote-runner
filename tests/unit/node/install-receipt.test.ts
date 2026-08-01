import { describe, expect, it } from "vitest";

import { formatInstallReceipt, formatInstallVersion, parseInstallReceipt } from "../../../src/node/install-receipt.js";

const receipt = {
  schemaVersion: 1 as const,
  version: "0.1.0",
  appIdentity: "a".repeat(24),
};

describe("immutable install receipt", () => {
  it("round-trips a closed versioned receipt", () => {
    expect(parseInstallReceipt(formatInstallReceipt(receipt))).toEqual(receipt);
    expect(formatInstallVersion(receipt)).toBe(`remote-runner 0.1.0 (app ${"a".repeat(24)})`);
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong schema", JSON.stringify({ ...receipt, schemaVersion: 2 })],
    ["extra field", JSON.stringify({ ...receipt, sourceRoot: "/private/source" })],
    ["non-semver version", JSON.stringify({ ...receipt, version: "main" })],
    ["invalid identity", JSON.stringify({ ...receipt, appIdentity: "xyz" })],
  ])("rejects %s", (_case, contents) => {
    expect(() => parseInstallReceipt(contents)).toThrow(/install receipt/u);
  });
});
