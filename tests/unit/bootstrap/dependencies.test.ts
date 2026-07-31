import { describe, expect, it } from "vitest";

import { ensureDependencySetup, packageManagerFromPackageJson, type DependencySetupRuntime, type HealthySetupState } from "../../../src/bootstrap/dependencies.js";

class FakeRuntime implements DependencySetupRuntime {
  readonly calls: string[] = [];
  writes: HealthySetupState[] = [];
  constructor(public state?: HealthySetupState, private readonly failureAt?: string) {}
  async readHealthyState() { this.calls.push("read"); return this.state; }
  async runSetup(script: string, workspaceRoot: string, environment: HealthySetupState["environment"]) {
    this.calls.push(`run:${script}:${workspaceRoot}:${environment.node}`);
    return { exitCode: script === this.failureAt ? 9 : 0 };
  }
  async writeHealthyState(state: HealthySetupState) { this.calls.push("write"); this.writes.push(state); this.state = state; }
}

const environment = { node: "26.5.0-linux-x64", packageManager: "pnpm@11.9.0", uv: "0.11.32", gitleaks: "8.30.1" };
const input = {
  fingerprint: `sha256:${"a".repeat(64)}`,
  environment,
  workspaceRoot: "/workspaces/ariadne",
  setup: ["./scripts/ds-bootstrap.sh", "./scripts/prepare.sh"],
};

describe("dependency setup", () => {
  it("reads an exact package manager from the declared package.json", () => {
    expect(packageManagerFromPackageJson(new TextEncoder().encode('{"packageManager":"pnpm@11.9.0"}'))).toBe("pnpm@11.9.0");
    expect(() => packageManagerFromPackageJson(new TextEncoder().encode('{"packageManager":"pnpm@latest"}'))).toThrow("exact");
    expect(() => packageManagerFromPackageJson(new TextEncoder().encode('{"packageManager":"pnpm@11.9.0","packageManager":"pnpm@10.0.0"}'))).toThrow();
  });

  it("skips setup only when both fingerprint and full environment match", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment });
    await expect(ensureDependencySetup(runtime, input)).resolves.toEqual({ fingerprint: input.fingerprint, environment, setupRan: false });
    expect(runtime.calls).toEqual(["read"]);
  });

  it.each([
    ["fingerprint", { fingerprint: `sha256:${"b".repeat(64)}`, environment }],
    ["environment", { fingerprint: input.fingerprint, environment: { ...environment, uv: "0.11.31" } }],
  ])("runs all setup scripts and persists only after success when %s changes", async (_label, previous) => {
    const runtime = new FakeRuntime(previous);
    const result = await ensureDependencySetup(runtime, input);
    expect(result.setupRan).toBe(true);
    expect(runtime.calls).toEqual([
      "read",
      "run:./scripts/ds-bootstrap.sh:/workspaces/ariadne:26.5.0-linux-x64",
      "run:./scripts/prepare.sh:/workspaces/ariadne:26.5.0-linux-x64",
      "write",
    ]);
    expect(runtime.writes).toEqual([{ fingerprint: input.fingerprint, environment }]);
  });

  it("preserves the last healthy state and stops later setup after failure", async () => {
    const previous = { fingerprint: `sha256:${"b".repeat(64)}`, environment: { ...environment, uv: "0.11.31" } };
    const runtime = new FakeRuntime(previous, "./scripts/ds-bootstrap.sh");
    await expect(ensureDependencySetup(runtime, input)).rejects.toThrow("exit code 9");
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
    expect(runtime.calls).toHaveLength(2);
  });

  it("rejects unsafe setup scripts before reading or running state", async () => {
    const runtime = new FakeRuntime();
    await expect(ensureDependencySetup(runtime, { ...input, setup: ["../escape"] })).rejects.toThrow("safe relative");
    expect(runtime.calls).toEqual([]);
  });

  it("rejects a non-canonical workspace root before side effects", async () => {
    const runtime = new FakeRuntime();
    await expect(ensureDependencySetup(runtime, { ...input, workspaceRoot: "/workspaces/../etc" })).rejects.toThrow("canonical");
    expect(runtime.calls).toEqual([]);
  });
});
