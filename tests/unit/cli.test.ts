import { describe, expect, it } from "vitest";

import { runCli } from "../../src/cli.js";

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
});
