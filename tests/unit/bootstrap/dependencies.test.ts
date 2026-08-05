import { describe, expect, it } from "vitest";

import {
  DependencyCommandError,
  ensureDependencySetup,
  packageManagerFromPackageJson,
  type DependencySetupRuntime,
  type HealthySetupState,
} from "../../../src/bootstrap/dependencies.js";

class FakeRuntime implements DependencySetupRuntime {
  readonly calls: string[] = [];
  writes: HealthySetupState[] = [];
  setupExitCode = 9;
  ensureThrows?: Error;
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
    return { exitCode: script === this.failureAt ? this.setupExitCode : 0 };
  }
  async runEnsure(command: readonly string[], workspaceRoot: string, environment: HealthySetupState["environment"]) {
    this.calls.push(`ensure:${JSON.stringify(command)}:${workspaceRoot}:${environment.node}`);
    if (this.ensureThrows !== undefined) throw this.ensureThrows;
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

  /* The postcheck is the runner's own, not a consumer command observed exiting non-zero: a damaged
     remote workspace loses the artifact while the local checkout still has it, so it must keep the
     outage notification and the fallback. */
  it("fails closed on a missing artifact without blaming the consumer", async () => {
    const previous = { fingerprint: input.fingerprint, environment };
    const runtime = new FakeRuntime(previous, undefined, [], [1, 1]);

    const caught = await ensureDependencySetup(runtime, artifactInput).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DependencyCommandError);
    expect((caught as Error).message).toMatch(/bootstrap artifact.*missing/u);
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
    await expect(ensureDependencySetup(runtime, input)).rejects.toMatchObject({
      name: "DependencyCommandError",
      command: "./scripts/ds-bootstrap.sh",
      exitCode: 9,
      message: expect.stringContaining("exit code 9"),
    });
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
    expect(runtime.calls).toHaveLength(2);
  });

  it("does not persist state when ensure still fails after setup", async () => {
    const previous = { fingerprint: `sha256:${"b".repeat(64)}`, environment };
    const runtime = new FakeRuntime(previous, undefined, [9]);

    await expect(ensureDependencySetup(runtime, input)).rejects.toMatchObject({
      name: "DependencyCommandError",
      command: "node",
      exitCode: 9,
      message: expect.stringMatching(/ensure.*exit code 9/u),
    });
    expect(runtime.state).toEqual(previous);
    expect(runtime.writes).toEqual([]);
    expect(runtime.calls.at(-1)).toContain("ensure:");
  });

  /* None of these codes proves the consumer's command ran and failed: 255 is ssh's own failure, 127
     and 137 are synthesized locally when the ssh client cannot spawn or is signal-killed (the OOM
     killer during an install), and 125 is the workspace wrapper reporting its own `cd` failure.
     Blaming the consumer for any of them silences the outage notification and skips the fallback
     exactly when the machine is broken. */
  it.each([
    [255, "setup"],
    [255, "ensure"],
    [127, "setup"],
    [127, "ensure"],
    [137, "setup"],
    [137, "ensure"],
    [125, "setup"],
    [125, "ensure"],
  ] as const)("keeps exit %d from a %s command a remote failure", async (exitCode, site) => {
    let runtime: FakeRuntime;
    if (site === "setup") {
      runtime = new FakeRuntime(undefined, "./scripts/ds-bootstrap.sh");
      runtime.setupExitCode = exitCode;
    } else {
      runtime = new FakeRuntime(undefined, undefined, [exitCode]);
    }

    const caught = await ensureDependencySetup(runtime, input).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DependencyCommandError);
    expect((caught as Error).message).toContain(String(exitCode));
  });

  /* The upper bound is a range, not a list: 124 must stay the consumer's own failure. */
  it("still blames the consumer for the highest shell-returnable code", async () => {
    const runtime = new FakeRuntime(undefined, "./scripts/ds-bootstrap.sh");
    runtime.setupExitCode = 124;

    await expect(ensureDependencySetup(runtime, input)).rejects.toMatchObject({
      name: "DependencyCommandError",
      exitCode: 124,
    });
  });

  /* No exit code was ever observed, so the transport dying is not the consumer's command failing. */
  it("keeps a transport failure during ensure a remote failure", async () => {
    const runtime = new FakeRuntime({ fingerprint: input.fingerprint, environment });
    runtime.ensureThrows = new Error("ssh: connection closed");

    const caught = await ensureDependencySetup(runtime, input).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DependencyCommandError);
    expect((caught as Error).message).toContain("dependency ensure node failed");
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
