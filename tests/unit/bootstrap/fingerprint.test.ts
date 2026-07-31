import { describe, expect, it } from "vitest";

import { dependencyFingerprint, type FingerprintRuntime } from "../../../src/bootstrap/fingerprint.js";

class FakeRuntime implements FingerprintRuntime {
  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly gitlinks: readonly { path: string; oid: string }[],
  ) {}
  async readFile(path: string) {
    const value = this.files[path];
    if (value === undefined) throw new Error(`missing ${path}`);
    return new TextEncoder().encode(value);
  }
  async listGitlinks() { return this.gitlinks; }
  async sha256(contents: Uint8Array) {
    return `fixture:${Array.from(contents).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}

const environment = { node: "26.5.0-linux-x64", packageManager: "pnpm@11.9.0", uv: "0.11.32" };

describe("dependency fingerprint", () => {
  it("binds the full environment, declared files, file names, and submodule gitlinks in sorted order", async () => {
    const one = new FakeRuntime({ "pnpm-lock.yaml": "lock", "package.json": "pkg" }, [
      { path: "vendor/z", oid: "b".repeat(40) }, { path: "vendor/a", oid: "a".repeat(40) },
    ]);
    const two = new FakeRuntime({ "pnpm-lock.yaml": "lock", "package.json": "pkg" }, [
      { path: "vendor/a", oid: "a".repeat(40) }, { path: "vendor/z", oid: "b".repeat(40) },
    ]);
    const first = await dependencyFingerprint(one, { environment, files: ["pnpm-lock.yaml", "package.json"] });
    const second = await dependencyFingerprint(two, { environment, files: ["package.json", "pnpm-lock.yaml"] });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:fixture:/u);
  });

  it("changes for file content, file identity, environment, or gitlink OID", async () => {
    const base = new FakeRuntime({ "package.json": "same", "other.json": "same" }, [{ path: "sub", oid: "a".repeat(40) }]);
    const expected = await dependencyFingerprint(base, { environment, files: ["package.json"] });
    const variants = [
      dependencyFingerprint(new FakeRuntime({ "package.json": "changed" }, [{ path: "sub", oid: "a".repeat(40) }]), { environment, files: ["package.json"] }),
      dependencyFingerprint(base, { environment, files: ["other.json"] }),
      dependencyFingerprint(base, { environment: { ...environment, uv: "0.11.33" }, files: ["package.json"] }),
      dependencyFingerprint(new FakeRuntime({ "package.json": "same" }, [{ path: "sub", oid: "b".repeat(40) }]), { environment, files: ["package.json"] }),
    ];
    for (const variant of variants) expect(await variant).not.toBe(expected);
  });

  it("accepts an explicitly declared gitlink path without reading it as a file", async () => {
    const runtime = new FakeRuntime({ "package.json": "same" }, [
      { path: "vendor/dev-standards", oid: "a".repeat(40) },
    ]);

    await expect(dependencyFingerprint(runtime, {
      environment,
      files: ["package.json", "vendor/dev-standards"],
    })).resolves.toMatch(/^sha256:fixture:/u);
  });

  it("rejects duplicate/unsafe file paths and malformed gitlinks", async () => {
    await expect(dependencyFingerprint(new FakeRuntime({ "package.json": "x" }, []), {
      environment, files: ["package.json", "package.json"],
    })).rejects.toThrow("duplicate");
    await expect(dependencyFingerprint(new FakeRuntime({}, []), { environment, files: ["../secret"] })).rejects.toThrow("safe relative");
    await expect(dependencyFingerprint(new FakeRuntime({ "package.json": "x" }, [{ path: "sub", oid: "bad" }]), {
      environment, files: ["package.json"],
    })).rejects.toThrow("gitlink");
  });
});
