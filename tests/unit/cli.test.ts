import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies } from "../../src/cli.js";
import type { DiagnosticStatus } from "../../src/diagnostics/doctor.js";
import { validManifest } from "./config/manifest-fixture.js";

describe("runCli", () => {
  it("prints stable top-level commands without touching the system", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("run <profile> [options] [-- <command...>]");
    expect(stdout.join("\n")).toContain("prewarm <profile>");
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
    expect(stdout).toEqual(["valid profile: verify-full (fixtures/profile.yaml)"]);
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
        readFile: async (path) => {
          calls.push(["read", path]);
          return validManifest;
        },
        ensureController: async () => {
          calls.push(["controller"]);
        },
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

  it("uses the manifest workload and environment mode when command and mode argv are omitted", async () => {
    const calls: unknown[] = [];
    const code = await runCli(
      ["run", "verify-full"],
      { stdout: () => undefined, stderr: () => undefined },
      {
        readFile: async () => validManifest,
        environment: { REMOTE_RUNNER_MODE: "remote" },
        ensureController: async () => undefined,
        runProfile: async (profile, command, mode) => {
          calls.push([profile.id, command, mode]);
          return 0;
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([["verify-full", ["./scripts/verify", "--full"], "remote"]]);
  });

  it("queues prewarm without entering the attached profile execution path", async () => {
    const calls: unknown[] = [];
    const errors: string[] = [];
    const output: string[] = [];
    const code = await runCli(
      ["prewarm", "verify-full"],
      { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
      {
        readFile: async (path) => {
          calls.push(["read", path]);
          return validManifest;
        },
        environment: { REMOTE_RUNNER_MODE: "local" },
        enqueuePrewarm: async (profile, manifestPath) => {
          calls.push(["enqueue", profile.id, manifestPath]);
          return "published";
        },
        runProfile: async () => {
          throw new Error("prewarm must not run an attached profile");
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["read", ".remote-runner.yaml"],
      ["enqueue", "verify-full", ".remote-runner.yaml"],
    ]);
    expect(output).toEqual(["prewarm queued: verify-full"]);
    expect(errors).toEqual([]);
  });

  it("keeps enqueue failures visible and fail-soft", async () => {
    const errors: string[] = [];
    const code = await runCli(
      ["prewarm", "verify-full", "--manifest", "profile.yaml"],
      { stdout: () => undefined, stderr: (line) => errors.push(line) },
      {
        readFile: async () => validManifest,
        enqueuePrewarm: async () => {
          throw new Error("controller unavailable");
        },
      },
    );

    expect(code).toBe(0);
    expect(errors).toEqual(["remote-runner prewarm failed; worktree preserved and the first manual verify will retry"]);
  });

  it("continues through the automatic fallback policy when controller repair fails", async () => {
    const calls: string[] = [];
    const code = await runCli(
      ["run", "verify-full"],
      { stdout: () => undefined, stderr: (line) => calls.push(`error:${line}`) },
      {
        readFile: async () => validManifest,
        ensureController: async () => {
          calls.push("controller");
          throw new Error("stopped");
        },
        runProfile: async (_profile, _command, mode) => {
          calls.push(`run:${mode}`);
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      "controller",
      "error:remote-runner controller unavailable; continuing automatic fallback policy",
      "run:auto",
    ]);
  });

  it("does not require the controller locally and fails closed when remote is forced", async () => {
    const calls: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => calls.push(`error:${line}`) };
    const dependencies = {
      readFile: async () => validManifest,
      ensureController: async () => {
        calls.push("controller");
        throw new Error("stopped");
      },
      runProfile: async (_profile: unknown, _command: readonly string[], mode?: string) => {
        calls.push(`run:${mode}`);
        return 0;
      },
    };

    expect(await runCli(["run", "verify-full", "--mode", "local"], io, dependencies)).toBe(0);
    expect(await runCli(["run", "verify-full", "--mode", "remote"], io, dependencies)).toBe(70);
    expect(calls).toEqual(["run:local", "controller", "error:remote-runner controller repair failed"]);
  });

  it("rejects malformed run syntax before reading the manifest", async () => {
    const errors: string[] = [];
    const dependencies = {
      readFile: async () => {
        throw new Error("must not read");
      },
    };
    expect(await runCli(["run"], { stdout: () => undefined, stderr: (line) => errors.push(line) }, dependencies)).toBe(
      2,
    );
    expect(
      await runCli(
        ["run", "verify-full", "--mode", "invalid", "--", "x"],
        { stdout: () => undefined, stderr: (line) => errors.push(line) },
        dependencies,
      ),
    ).toBe(2);
    expect(errors).toHaveLength(2);
  });

  it("routes status, doctor, and bounded logs through injected read-only dependencies", async () => {
    const stdout: string[] = [];
    const calls: string[] = [];
    const io = { stdout: (line: string) => stdout.push(line), stderr: () => undefined };
    const dependencies: CliDependencies = {
      readFile: async () => validManifest,
      statusProfile: async (profile?: string) => {
        calls.push(`status:${profile ?? "all"}`);
        return "verify-full controller=running prewarm=queued session=watching workspace=ready fingerprint=current outage=clear";
      },
      doctorProfile: async (profile?: string) => {
        calls.push(`doctor:${profile ?? "all"}`);
        return [
          {
            profile: "verify-full",
            report: {
              checks: [{ id: "ssh.transport", status: "ok", next: "remote-runner doctor" }],
            },
          },
        ];
      },
      logsProfile: async (profile?: string) => {
        calls.push(`logs:${profile ?? "all"}`);
        return ["line-1", "line-2"];
      },
    };

    expect(await runCli(["status", "verify-full"], io, dependencies)).toBe(0);
    expect(await runCli(["doctor"], io, dependencies)).toBe(0);
    expect(await runCli(["logs", "verify-full"], io, dependencies)).toBe(0);
    expect(calls).toEqual(["status:verify-full", "doctor:all", "logs:verify-full"]);
    expect(stdout).toEqual([
      "verify-full controller=running prewarm=queued session=watching workspace=ready fingerprint=current outage=clear",
      '{"profiles":[{"profile":"verify-full","report":{"checks":[{"id":"ssh.transport","status":"ok","next":"remote-runner doctor"}]}}]}',
      "line-1",
      "line-2",
    ]);
  });

  it("exits non-zero for doctor only on a failing check, printing the same report either way", async () => {
    const stdout: string[] = [];
    const io = { stdout: (line: string) => stdout.push(line), stderr: () => undefined };
    const dependencies = (status: DiagnosticStatus): CliDependencies => ({
      readFile: async () => validManifest,
      doctorProfile: async () => [
        {
          profile: "verify-full",
          report: {
            checks: [
              { id: "ssh.transport", status: "ok", next: "ssh <remote> true" },
              { id: "remote.capacity", status, reason: "capacity", next: "ssh <remote> df -Pk <workspace>" },
            ],
          },
        },
      ],
    });
    const checks = (status: DiagnosticStatus): string =>
      `[{"id":"ssh.transport","status":"ok","next":"ssh <remote> true"},{"id":"remote.capacity","status":"${status}","reason":"capacity","next":"ssh <remote> df -Pk <workspace>"}]`;

    expect(await runCli(["doctor", "verify-full"], io, dependencies("warn"))).toBe(0);
    expect(await runCli(["doctor", "verify-full"], io, dependencies("fail"))).toBe(1);
    expect(await runCli(["doctor"], io, dependencies("fail"))).toBe(1);
    expect(stdout).toEqual([
      `{"checks":${checks("warn")}}`,
      `{"checks":${checks("fail")}}`,
      `{"profiles":[{"profile":"verify-full","report":{"checks":${checks("fail")}}}]}`,
    ]);
  });

  it("requires an exact dry-run before routing repair apply", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const dependencies = {
      readFile: async () => validManifest,
      repairProfile: async (profile: string, apply: boolean) => {
        calls.push(`${profile}:${apply ? "apply" : "dry-run"}`);
        return { profile, identity: "worktree-abc123", planHash: "abc", actions: [] };
      },
    };
    const io = {
      stdout: (line: string) => calls.push(`output:${line}`),
      stderr: (line: string) => errors.push(line),
    };

    expect(await runCli(["repair", "verify-full", "--dry-run"], io, dependencies)).toBe(0);
    expect(await runCli(["repair", "verify-full", "--apply"], io, dependencies)).toBe(0);
    expect(await runCli(["repair", "verify-full"], io, dependencies)).toBe(2);
    expect(await runCli(["repair", "verify-full", "--apply", "extra"], io, dependencies)).toBe(2);
    expect(calls.slice(0, 4)).toEqual([
      "verify-full:dry-run",
      expect.stringContaining('output:{"profile":"verify-full"'),
      "verify-full:apply",
      expect.stringContaining('output:{"profile":"verify-full"'),
    ]);
    expect(errors).toEqual([
      "repair requires <profile> --dry-run|--apply",
      "repair requires <profile> --dry-run|--apply",
    ]);
  });

  it("loads a validated profile before routing benchmark collection", async () => {
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const code = await runCli(
      ["benchmark", "verify-full", "--manifest", "profile.yaml"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
      {
        readFile: async (path) => {
          calls.push(["read", path]);
          return validManifest;
        },
        benchmarkProfile: async (profile) => {
          calls.push(["benchmark", profile.id, profile.benchmark.samples]);
          return { profile: profile.id, rows: [], receiptPaths: ["one.json", "one.md"] };
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["read", "profile.yaml"],
      ["benchmark", "verify-full", 3],
    ]);
    expect(stdout).toEqual(['{"profile":"verify-full","rows":[],"receiptPaths":["one.json","one.md"]}']);
  });
});
