import { describe, expect, it } from "vitest";

import { assertSafeRepositoryPath } from "../../../src/runtime/paths.js";

describe("assertSafeRepositoryPath", () => {
  it.each(["", ".", "./", "..", "../secret", "a/../../secret", "/tmp", "C:\\tmp", "C:secret", "C:..\\secret", "a\0b"])(
    "rejects unsafe path %j",
    (value) => expect(() => assertSafeRepositoryPath(value)).toThrow("unsafe repository path"),
  );

  it("normalizes a confined relative path", () => {
    expect(assertSafeRepositoryPath("scripts/./nested/../verify.sh")).toBe(
      "scripts/verify.sh",
    );
  });
});
