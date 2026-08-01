import { describe, expect, it } from "vitest";

import {
  ensureDependencySetup,
  packageManagerFromPackageJson,
  type DependencySetupRuntime,
  type HealthySetupState,
} from "../../../src/bootstrap/dependencies.js";

class FakeRuntime implements DependencySetupRuntime {
  readonly calls: string[] = [];
  writes: HealthySetupState[] = [];
  constructor(
    public state?: HealthySetupState,
    private readonly failureAt?: string,
    private readonly ensureExitCodes: number[] = [],
    private readonly artifactExitCodes: number[] = [],
  ) {}
  async readHealthyState() {
    this.calls.push("read");
    return this.state;
  }
  async runSetup(script: string, workspaceRoot: string, environment: HealthySetupState["environment"]) {
    this.calls.push(`run:${script}:${workspaceRoot}:${environment.node}`);
    return { exitCode: script === this.failureAt ? 9 : 0 };
  }
  async runEnsure(command: readonly string[], workspaceRoot: string, environment: HealthySetupState["environment"]) {
    this.calls.push(`ensure:${JSON.stringify(command)}:${workspaceRoot}:${environment.node}`);
    return { exitCode: this.ensureExitCodes.shift() ?? 0 };
  }
  async checkArtifact(artifact: string, workspaceRoot: string) {
    this.calls.push(`artifact:${artifact}:${workspaceRoot}`);
    return { exitCode: this.artifactExitCodes.shift() ?? 0 };
  }
  async writeHealthyState(state: HealthySetupState) {
    this.calls.push("write");
    this.writes.push(state);
    this.state = state;
  }
}

const environment = { node: "26.5.0-linux-x64", packageManager: "pnpm@11.9.0", uv: "0.11.32", gitleaks: "8.30.1" };
const input = {
  fingerprint: `sha256:${"a".repeat(64)}`,
  environment,
  workspaceRoot: "/workspaces/ariadne",
  setup: ["./scripts/ds-bootstrap.sh", "./scripts/prepare.sh"],
  artifacts: [],
  ensure: [
    ["node", "scripts/pnpm-state.mjs"],
    ["uv", "sync", "--locked", "--offline"],
  ],
};
const artifactInput = {
  ...input,
  artifacts: ["vendor/dev-standards/runner/dist/verify-runner.mjs"],
};

describe("dependency setup", () => {
  it("reads an exact package manager from the declared package.json", () => {
    expect(packageManagerFromPackageJson(new TextEncoder().encode('{"packageManager":"pnpm@11.9.0"}'))).toBe(
      "pnpm@11.9.0",
    );
    expect(() => packageManagerFromPackageJson(new TextEncoder().encode('{"packageManager":"pnpm@latest"}'))).toThrow(
      "exact",
    );
    expect(() =>
      packageManagerFromPackageJson(
        new TextEncoder().encode('{"packageManager":"pnpm@11.9.0","packageManager":"pnpm@10.0.0"}'),
      ),
    ).toThrow();
  });

  it("skips setup only when state matches and every ensure command succeeds", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment });
    await expect(ensureDependencySetup(runtime, input)).resolves.toEqual({
      fingerprint: input.fingerprint,
      environment,
      setupRan: false,
    });
    expect(runtime.calls).toEqual([
      "read",
      'ensure:["node","scripts/pnpm-state.mjs"]:/workspaces/ariadne:26.5.0-linux-x64',
      'ensure:["uv","sync","--locked","--offline"]:/workspaces/ariadne:26.5.0-linux-x64',
    ]);
  });

  it("runs setup and retries every ensure command when a matching state fails convergence", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment }, undefined, [9, 0, 0]);

    await expect(ensureDependencySetup(runtime, input)).resolves.toMatchObject({ setupRan: true });
    expect(runtime.calls).toEqual([
      "read",
      'ensure:["node","scripts/pnpm-state.mjs"]:/workspaces/ariadne:26.5.0-linux-x64',
      "run:./scripts/ds-bootstrap.sh:/workspaces/ariadne:26.5.0-linux-x64",
      "run:./scripts/prepare.sh:/workspaces/ariadne:26.5.0-linux-x64",
      'ensure:["node","scripts/pnpm-state.mjs"]:/workspaces/ariadne:26.5.0-linux-x64',
      'ensure:["uv","sync","--locked","--offline"]:/workspaces/ariadne:26.5.0-linux-x64',
      "write",
    ]);
  });

  it("reruns setup when a current fingerprint loses a declared artifact", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment }, undefined, [], [1, 0]);

    await expect(ensureDependencySetup(runtime, artifactInput)).resolves.toMatchObject({ setupRan: true });
    expect(runtime.calls).toEqual([
      "read",
      "artifact:vendor/dev-standards/runner/dist/verify-runner.mjs:/workspaces/ariadne",
      "run:./scripts/ds-bootstrap.sh:/workspaces/ariadne:26.5.0-linux-x64",
      "run:./scripts/prepare.sh:/workspaces/ariadne:26.5.0-linux-x64",
      "artifact:vendor/dev-standards/runner/dist/verify-runner.mjs:/workspaces/ariadne",
      'ensure:["node","scripts/pnpm-state.mjs"]:/workspaces/ariadne:26.5.0-linux-x64',
      'ensure:["uv","sync","--locked","--offline"]:/workspaces/ariadne:26.5.0-linux-x64',
      "write",
    ]);
  });

  it("fails closed when setup does not recreate a declared artifact", async () => {
    const previous = { fingerprint: input.fingerprint, environment };
    const runtime = new FakeRuntime(previous, undefined, [], [1, 1]);

    await expect(ensureDependencySetup(runtime, artifactInput)).rejects.toThrow(/bootstrap artifact.*missing/u);
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
  });

  it("fails immediately when artifact inspection returns a protocol exit", async () => {
    const previous = { fingerprint: input.fingerprint, environment };
    const runtime = new FakeRuntime(previous, undefined, [], [2]);

    await expect(ensureDependencySetup(runtime, artifactInput)).rejects.toThrow(/artifact inspection.*exit code 2/u);
    expect(runtime.calls).toEqual([
      "read",
      "artifact:vendor/dev-standards/runner/dist/verify-runner.mjs:/workspaces/ariadne",
    ]);
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
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
      'ensure:["node","scripts/pnpm-state.mjs"]:/workspaces/ariadne:26.5.0-linux-x64',
      'ensure:["uv","sync","--locked","--offline"]:/workspaces/ariadne:26.5.0-linux-x64',
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

  it("does not persist state when ensure still fails after setup", async () => {
    const previous = { fingerprint: `sha256:${"b".repeat(64)}`, environment };
    const runtime = new FakeRuntime(previous, undefined, [9]);

    await expect(ensureDependencySetup(runtime, input)).rejects.toThrow(/ensure.*exit code 9/u);
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
    expect(runtime.calls.at(-1)).toContain("ensure:");
  });

  it("preserves legacy fingerprint-only behavior when no ensure command is declared", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment });
    await expect(ensureDependencySetup(runtime, { ...input, ensure: [] })).resolves.toMatchObject({
      setupRan: false,
    });
    expect(runtime.calls).toEqual(["read"]);
  });

  it("rejects unsafe setup scripts before reading or running state", async () => {
    const runtime = new FakeRuntime();
    await expect(ensureDependencySetup(runtime, { ...input, setup: ["../escape"] })).rejects.toThrow("safe relative");
    expect(runtime.calls).toEqual([]);
  });

  it("rejects a non-canonical workspace root before side effects", async () => {
    const runtime = new FakeRuntime();
    await expect(ensureDependencySetup(runtime, { ...input, workspaceRoot: "/workspaces/../etc" })).rejects.toThrow(
      "canonical",
    );
    expect(runtime.calls).toEqual([]);
  });
});
