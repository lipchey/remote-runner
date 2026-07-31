import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";
import { validManifest } from "./config/manifest-fixture.js";

describe("runCli", () => {
  it("prints stable top-level commands without touching the system", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("run <profile> -- <command...>");
    expect(stdout.join("\n")).toContain("validate [profile] [--manifest <path>]");
    expect(stdout.join("\n")).toContain("status [profile]");
    expect(stdout.join("\n")).toContain("doctor [profile]");
    expect(stdout.join("\n")).toContain("logs [profile]");
    expect(stdout.join("\n")).toContain("repair <profile> --dry-run|--apply");
    expect(stdout.join("\n")).toContain("benchmark <profile>");
  });

  it("rejects an unknown command with a usage exit code", async () => {
    const stderr: string[] = [];
    const code = await runCli(["unknown"], {
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(2);
    expect(stderr).toEqual(["unknown command: unknown"]);
  });

  it("validates the default manifest through only the injected reader", async () => {
    const stdout: string[] = [];
    const reads: string[] = [];
    const code = await runCli(
      ["validate"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
      {
        readFile: async (path) => {
          reads.push(path);
          return validManifest;
        },
      },
    );

    expect(code).toBe(0);
    expect(reads).toEqual([".remote-runner.yaml"]);
    expect(stdout).toEqual(["valid manifest: .remote-runner.yaml (1 profile)"]);
  });

  it("validates a selected profile from an explicit manifest without runtime side effects", async () => {
    const calls: string[] = [];
    const dependencies = {
      readFile: async (path: string) => {
        calls.push(`read:${path}`);
        return validManifest;
      },
      probe: () => calls.push("probe"),
      sync: () => calls.push("sync"),
      bootstrap: () => calls.push("bootstrap"),
      notify: () => calls.push("notify"),
      mutateState: () => calls.push("state"),
    };
    const stdout: string[] = [];
    const code = await runCli(
      ["validate", "verify-full", "--manifest", "fixtures/profile.yaml"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      dependencies,
    );

    expect(code).toBe(0);
    expect(calls).toEqual(["read:fixtures/profile.yaml"]);
    expect(stdout).toEqual([
      "valid profile: verify-full (fixtures/profile.yaml)",
    ]);
  });

  it("reports invalid manifests, missing profiles, and invalid validate arguments stably", async () => {
    const errors: string[] = [];
    const io = {
      stdout: () => undefined,
      stderr: (line: string) => errors.push(line),
    };
    const reader = { readFile: async () => validManifest };

    expect(await runCli(["validate", "missing"], io, reader)).toBe(2);
    expect(await runCli(["validate", "--manifest"], io, reader)).toBe(2);
    expect(
      await runCli(["validate"], io, {
        readFile: async () => "schemaVersion: 2\nprofiles: []\n",
      }),
    ).toBe(2);
    expect(errors).toEqual([
      "profile not found: missing",
      "validate requires a path after --manifest",
      "invalid manifest: schemaVersion must be 1",
    ]);
  });

  it("loads a selected run profile and forwards the exact argv array and mode override", async () => {
    const calls: unknown[] = [];
    const code = await runCli(
      ["run", "verify-full", "--mode", "local", "--manifest", "profile.yaml", "--", "./scripts/verify", "--full"],
      { stdout: () => undefined, stderr: () => undefined },
      {
        readFile: async (path) => { calls.push(["read", path]); return validManifest; },
        runProfile: async (profile, command, mode) => {
          calls.push(["run", profile.id, command, mode]);
          return 29;
        },
      },
    );
    expect(code).toBe(29);
    expect(calls).toEqual([
      ["read", "profile.yaml"],
      ["run", "verify-full", ["./scripts/verify", "--full"], "local"],
    ]);
  });

  it("rejects malformed run syntax before reading the manifest", async () => {
    const errors: string[] = [];
    const dependencies = { readFile: async () => { throw new Error("must not read"); } };
    expect(await runCli(["run", "verify-full"], { stdout: () => undefined, stderr: (line) => errors.push(line) }, dependencies)).toBe(2);
    expect(await runCli(["run", "verify-full", "--mode", "invalid", "--", "x"], { stdout: () => undefined, stderr: (line) => errors.push(line) }, dependencies)).toBe(2);
    expect(errors).toHaveLength(2);
  });
});
