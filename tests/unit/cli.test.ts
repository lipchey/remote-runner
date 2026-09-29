import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliIo } from "../../src/cli.js";
import { summarizeCorpus, type CorpusOptions, type CorpusRecord } from "../../src/diagnostics/corpus.js";
import type { DiagnosticStatus } from "../../src/diagnostics/doctor.js";
import { validManifest } from "./config/manifest-fixture.js";

const profileBlock = validManifest.slice(validManifest.indexOf("  - id:"));

function remoteFallbackManifest(fallbackPolicy: "local" | "fail" = "local"): string {
  const fallback = validManifest.replace("fallback: local", `fallback: ${fallbackPolicy}`);
  const primary = profileBlock
    .replace("id: verify-full", "id: verify-full-pop-os")
    .replace("fallback: local", "fallback: verify-full")
    .replace("label: pop-os, target: admin@pop-os", "label: ariadne-runner, target: admin@primary");
  return `${fallback}${primary}`;
}

function collect(stdout: string[]): CliIo {
  return { stdout: (line) => stdout.push(line), stderr: () => undefined };
}

function remoteFinish(at: string, extra: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    event: "run-finish",
    at,
    status: 0,
    provider: "remote",
    durationMs: 1000,
    consumer: "ariadne",
    profile: "verify-full",
    identity: "aaa",
    ...extra,
  };
}

function corpusDependencies(
  seenOptions: CorpusOptions[],
  records: readonly CorpusRecord[] = [remoteFinish("2026-08-01T00:00:00Z")],
): CliDependencies {
  return {
    readFile: async () => validManifest,
    readLogCorpus: async (options) => {
      seenOptions.push(options);
      return {
        provenance: { source: "/state/profiles", files: 1, unparsed: 0, runner: "remote-runner 9.9.9" },
        summary: summarizeCorpus(records, options),
      };
    },
  };
}

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
    expect(stdout.join("\n")).not.toContain("repair");
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
        runProfile: async (profile, command, mode, _controllerEnsureMs, fallback) => {
          calls.push(["run", profile.id, command, mode, fallback?.id]);
          return 29;
        },
      },
    );
    expect(code).toBe(29);
    expect(calls).toEqual([
      ["read", "profile.yaml"],
      ["run", "verify-full", ["./scripts/verify", "--full"], "local", undefined],
    ]);
  });

  /* Only the CLI can measure the repair, since it runs before the runner's clock starts; a local
     run reports no measurement, not a false zero. */
  it("hands the run what the controller repair cost, and nothing when it is skipped", async () => {
    const measured: (number | undefined)[] = [];
    const dependencies: CliDependencies = {
      readFile: async () => validManifest,
      ensureController: async () => undefined,
      runProfile: async (_profile, _command, _mode, controllerEnsureMs) => {
        measured.push(controllerEnsureMs);
        return 0;
      },
    };
    const io = { stdout: () => undefined, stderr: () => undefined };

    expect(await runCli(["run", "verify-full", "--mode", "remote"], io, dependencies)).toBe(0);
    expect(await runCli(["run", "verify-full", "--mode", "local"], io, dependencies)).toBe(0);

    expect(measured).toHaveLength(2);
    expect(Number.isInteger(measured[0])).toBe(true);
    expect(measured[0]).toBeGreaterThanOrEqual(0);
    expect(measured[1]).toBeUndefined();
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
    expect(calls).toEqual([["verify-full", undefined, "remote"]]);
  });

  it("run passes the resolved fallback profile and command override separately", async () => {
    const calls: unknown[] = [];
    const code = await runCli(
      ["run", "verify-full-pop-os", "--", "./explicit", "--flag"],
      { stdout: () => undefined, stderr: () => undefined },
      {
        readFile: async () => remoteFallbackManifest(),
        ensureController: async () => undefined,
        runProfile: async (profile, commandOverride, mode, _controllerEnsureMs, fallback) => {
          calls.push([profile.id, commandOverride, mode, fallback?.id]);
          return 0;
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([["verify-full-pop-os", ["./explicit", "--flag"], "auto", "verify-full"]]);
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

  it("controller repair failure continues when the remote fallback ends locally", async () => {
    const calls: string[] = [];
    const code = await runCli(
      ["run", "verify-full-pop-os"],
      { stdout: () => undefined, stderr: (line) => calls.push(`error:${line}`) },
      {
        readFile: async () => remoteFallbackManifest("local"),
        ensureController: async () => {
          calls.push("controller");
          throw new Error("stopped");
        },
        runProfile: async (_profile, _command, _mode, _controllerEnsureMs, fallback) => {
          calls.push(`run:${fallback?.id}`);
          return 0;
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([
      "controller",
      "error:remote-runner controller unavailable; continuing automatic fallback policy",
      "run:verify-full",
    ]);
  });

  it("controller repair failure exits 70 when the remote fallback fails closed", async () => {
    let ran = false;
    const code = await runCli(
      ["run", "verify-full-pop-os"],
      { stdout: () => undefined, stderr: () => undefined },
      {
        readFile: async () => remoteFallbackManifest("fail"),
        ensureController: async () => {
          throw new Error("stopped");
        },
        runProfile: async () => {
          ran = true;
          return 0;
        },
      },
    );

    expect(code).toBe(70);
    expect(ran).toBe(false);
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

  it.each(["status", "doctor", "logs"])("passes the selected manifest through %s diagnostics", async (command) => {
    const calls: unknown[] = [];
    const dependencies: CliDependencies = {
      readFile: async () => {
        throw new Error("diagnostic dependencies own manifest reading");
      },
      statusProfile: async (profile?: string, manifestPath?: string) => {
        calls.push([profile, manifestPath]);
        return "status";
      },
      doctorProfile: async (profile?: string, manifestPath?: string) => {
        calls.push([profile, manifestPath]);
        return [{ profile: profile ?? "verify-full", report: { checks: [] } }];
      },
      logsProfile: async (profile?: string, manifestPath?: string) => {
        calls.push([profile, manifestPath]);
        return ["log"];
      },
    };

    for (const arguments_ of [
      ["verify-full", "--manifest", "operator.yaml"],
      ["--manifest", "operator.yaml", "verify-full"],
      ["--manifest", "operator.yaml"],
      [],
    ]) {
      expect(await runCli([command, ...arguments_], collect([]), dependencies)).toBe(0);
    }
    expect(calls).toEqual([
      ["verify-full", "operator.yaml"],
      ["verify-full", "operator.yaml"],
      [undefined, "operator.yaml"],
      [undefined, undefined],
    ]);
  });

  it.each(["status", "doctor", "logs"])("rejects malformed %s manifest options before diagnostics", async (command) => {
    const calls: string[] = [];
    const dependencies: CliDependencies = {
      readFile: async () => validManifest,
      statusProfile: async () => {
        calls.push("status");
        return "status";
      },
      doctorProfile: async () => {
        calls.push("doctor");
        return [];
      },
      logsProfile: async () => {
        calls.push("logs");
        return [];
      },
    };
    for (const arguments_ of [
      ["--manifest"],
      ["--manifest", ""],
      ["--manifest", "--all"],
      ["--manifest", "first.yaml", "--manifest", "second.yaml"],
      ["first-profile", "second-profile", "--manifest", "operator.yaml"],
      ["--unknown", "operator.yaml"],
    ]) {
      expect(await runCli([command, ...arguments_], collect([]), dependencies)).toBe(2);
    }
    expect(calls).toEqual([]);
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

  it("routes a retired repair invocation to the unknown-command exit code", async () => {
    const errors: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => errors.push(line) };

    expect(await runCli(["repair", "verify-full", "--apply"], io, { readFile: async () => validManifest })).toBe(2);
    expect(errors).toEqual(["unknown command: repair"]);
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

  it("reads every identity for logs --all and renders the text report", async () => {
    const stdout: string[] = [];
    const options: CorpusOptions[] = [];
    const code = await runCli(["logs", "--all"], collect(stdout), corpusDependencies(options));

    expect(code).toBe(0);
    expect(options).toEqual([{}]);
    expect(stdout.join("\n")).toContain("source     /state/profiles");
    expect(stdout.join("\n")).toContain("dispatched 1 run-finish");
  });

  it("prints the corpus as a single JSON line for logs --all --json", async () => {
    const stdout: string[] = [];
    const code = await runCli(["logs", "--all", "--json"], collect(stdout), corpusDependencies([]));

    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ schemaVersion: 1, source: "/state/profiles" });
  });

  /* A non-zero exit here would mean the read failed. Lanes fail all the time and the report exists to
     show them, so letting failures set the exit code makes every honest report look like a broken
     command. */
  it("exits zero when the corpus it read is full of failed runs", async () => {
    const stdout: string[] = [];
    const dependencies = corpusDependencies([], [{ ...remoteFinish("2026-08-01T00:00:00Z"), status: 1 }]);

    expect(await runCli(["logs", "--all"], collect(stdout), dependencies)).toBe(0);
    expect(stdout.join("\n")).toContain("failures   1 non-zero");
  });

  it("passes --since and --cold-threshold-ms through to the corpus read", async () => {
    const options: CorpusOptions[] = [];
    const code = await runCli(
      ["logs", "--all", "--since", "2026-08-17", "--cold-threshold-ms", "3000"],
      collect([]),
      corpusDependencies(options),
    );

    expect(code).toBe(0);
    expect(options).toEqual([{ since: "2026-08-17", coldThresholdMs: 3000 }]);
  });

  it("accepts an in-range ISO time prefix on --since", async () => {
    const options: CorpusOptions[] = [];

    expect(
      await runCli(["logs", "--all", "--since", "2026-08-17T23:59:59.999Z"], collect([]), corpusDependencies(options)),
    ).toBe(0);
    expect(options).toEqual([{ since: "2026-08-17T23:59:59.999Z" }]);
  });

  it.each([
    ["a profile alongside --all", ["logs", "--all", "verify-full"]],
    ["a manifest alongside --all", ["logs", "--all", "--manifest", "operator.yaml"]],
    ["--json without --all", ["logs", "--json"]],
    ["--since without --all", ["logs", "--since", "2026-08-17"]],
    ["--cold-threshold-ms without --all", ["logs", "--cold-threshold-ms", "3000"]],
    ["a zero cold threshold", ["logs", "--all", "--cold-threshold-ms", "0"]],
    ["a negative cold threshold", ["logs", "--all", "--cold-threshold-ms", "-1"]],
    ["a fractional cold threshold", ["logs", "--all", "--cold-threshold-ms", "2.5"]],
    ["a non-numeric cold threshold", ["logs", "--all", "--cold-threshold-ms", "soon"]],
    /* A string compare against ISO timestamps accepts an impossible date happily and silently
       selects a range no reader intended. */
    ["an impossible calendar date", ["logs", "--all", "--since", "2026-02-30"]],
    ["a --since that is not a date", ["logs", "--all", "--since", "yesterday"]],
    /* A lexical cut sorts these above every real timestamp of that day instead of failing. One case
       per component: a shared out-of-range value would let any single check carry all three. */
    ["an out-of-range hour", ["logs", "--all", "--since", "2026-08-17T99Z"]],
    ["an out-of-range minute", ["logs", "--all", "--since", "2026-08-17T12:99Z"]],
    ["an out-of-range second", ["logs", "--all", "--since", "2026-08-17T12:30:99Z"]],
    ["a bare T with no time after it", ["logs", "--all", "--since", "2026-08-17T"]],
    ["an unsafe integer cold threshold", ["logs", "--all", "--cold-threshold-ms", "9007199254740993"]],
    ["--since with no value", ["logs", "--all", "--since"]],
    ["a repeated --since", ["logs", "--all", "--since", "2026-08-17", "--since", "2026-08-18"]],
    ["an unknown flag", ["logs", "--all", "--failures", "3"]],
  ])("rejects %s with a usage exit code", async (_case, argv) => {
    const stderr: string[] = [];
    const options: CorpusOptions[] = [];
    const code = await runCli(
      argv,
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      corpusDependencies(options),
    );

    expect(code).toBe(2);
    expect(stderr).toHaveLength(1);
    expect(options).toEqual([]);
  });

  it("keeps rejecting unsupported flags for status and doctor", async () => {
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => stderr.push(line) };
    const dependencies: CliDependencies = {
      readFile: async () => validManifest,
      statusProfile: async () => "unreachable",
      doctorProfile: async () => [{ profile: "verify-full", report: { checks: [] } }],
    };

    expect(await runCli(["status", "--all"], io, dependencies)).toBe(2);
    expect(await runCli(["doctor", "--json"], io, dependencies)).toBe(2);
  });

  it("reports an unconfigured corpus runtime rather than an empty corpus", async () => {
    const stderr: string[] = [];
    const code = await runCli(
      ["logs", "--all"],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      { readFile: async () => validManifest },
    );

    expect(code).toBe(70);
    expect(stderr.join("\n")).toContain("runtime is not configured");
  });

  it("lists the cross-identity form in the help text", async () => {
    const stdout: string[] = [];
    await runCli(["--help"], collect(stdout), { readFile: async () => validManifest });

    expect(stdout.join("\n")).toContain("--all [--json]");
  });
});
