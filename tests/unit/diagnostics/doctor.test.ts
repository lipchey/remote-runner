import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_PROBES,
  doctor,
  formatStatus,
  tailLogs,
  type DoctorRuntime,
} from "../../../src/diagnostics/doctor.js";

class FakeDoctorRuntime implements DoctorRuntime {
  readonly observed: string[] = [];

  constructor(
    private readonly outcomes: Readonly<Record<string, "ok" | "warn" | "fail">> = {},
    private readonly details: Readonly<Record<string, string>> = {},
  ) {}

  async inspect(probe: (typeof DIAGNOSTIC_PROBES)[number]) {
    this.observed.push(probe.id);
    return {
      status: this.outcomes[probe.id] ?? "ok",
      ...(this.details[probe.id] === undefined ? {} : { detail: this.details[probe.id] }),
      rawOutput: probe.reason === "transport" ? "postgres://user:secret-canary@db/test" : "",
    };
  }
}

describe("doctor", () => {
  it("reports stable reason codes without raw diagnostic output", async () => {
    const runtime = new FakeDoctorRuntime({ "ssh.transport": "fail" });

    const report = await doctor(runtime);

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "ssh.transport",
        status: "fail",
        reason: "transport",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("secret-canary");
  });

  it("carries a sanitized detail for a failing check only", async () => {
    const runtime = new FakeDoctorRuntime(
      { "sync.session": "fail", "ssh.transport": "fail" },
      {
        "sync.session": `Mutagen session endpoint mismatch\nsecond line`,
        "runtime.lock": "lock is fine",
        "ssh.transport": `${"z".repeat(400)}`,
      },
    );

    const report = await doctor(runtime);
    const checks = Object.fromEntries(report.checks.map((check) => [check.id, check]));

    expect(checks["sync.session"]).toEqual({
      id: "sync.session",
      status: "fail",
      reason: "sync",
      detail: "Mutagen session endpoint mismatch",
      next: "mutagen sync list <session>",
    });
    expect(checks["runtime.lock"]).not.toHaveProperty("detail");
    expect(checks["ssh.transport"]?.detail).toHaveLength(200);
    expect(checks["ssh.transport"]?.detail?.endsWith("...")).toBe(true);
  });

  it("runs every declared probe as a read-only argv command", async () => {
    const runtime = new FakeDoctorRuntime();

    await doctor(runtime);

    expect(runtime.observed).toEqual(DIAGNOSTIC_PROBES.map((probe) => probe.id));
    expect(DIAGNOSTIC_PROBES.every((probe) => probe.readOnly)).toBe(true);
    expect(new Set(DIAGNOSTIC_PROBES.map((probe) => probe.reason)).size).toBe(DIAGNOSTIC_PROBES.length);
    expect(DIAGNOSTIC_PROBES.every((probe) => probe.command.length > 0)).toBe(true);
    expect(DIAGNOSTIC_PROBES).toContainEqual(
      expect.objectContaining({
        id: "remote.workspace-registration",
        reason: "workspace-registration",
        readOnly: true,
      }),
    );
  });

  it("converts probe exceptions into bounded failures", async () => {
    const runtime: DoctorRuntime = {
      async inspect(probe) {
        if (probe.id === "sync.session") throw new Error("secret-canary");
        return { status: "ok", rawOutput: "" };
      },
    };

    const report = await doctor(runtime);

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "sync.session",
        status: "fail",
        reason: "sync",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("secret-canary");
  });
});

describe("status formatting", () => {
  it("prints only concise bounded status fields", () => {
    const output = formatStatus({
      profile: "verify-full",
      controller: "running",
      prewarm: "queued",
      session: "watching",
      workspace: "ready",
      fingerprint: "current",
      outage: "clear",
    });

    expect(output).toBe(
      "verify-full controller=running prewarm=queued session=watching workspace=ready fingerprint=current outage=clear",
    );
  });

  it("prints the last prewarm outcome and when it finished", () => {
    const snapshot = {
      profile: "verify-full",
      controller: "running",
      session: "watching",
      workspace: "ready",
      fingerprint: "current",
      outage: "clear",
    } as const;

    expect(
      formatStatus({ ...snapshot, prewarm: { outcome: "failed", status: 1, at: "2026-08-17T17:04:05.825Z" } }),
    ).toContain("prewarm=failed(1)@2026-08-17T17:04:05.825Z ");
    expect(
      formatStatus({ ...snapshot, prewarm: { outcome: "ok", status: 0, at: "2026-08-17T17:23:23.879Z" } }),
    ).toContain("prewarm=ok@2026-08-17T17:23:23.879Z ");
  });
});

describe("bounded log tail", () => {
  it("reads only the owned rotation set and returns the newest bounded lines", async () => {
    const reads: number[] = [];
    const lines = await tailLogs(
      {
        async readRotation(index) {
          reads.push(index);
          return index === 0 ? "current-a\ncurrent-b\n" : `old-${index}\n`;
        },
      },
      3,
    );

    expect(reads).toEqual([3, 2, 1, 0]);
    expect(lines).toEqual(["old-1", "current-a", "current-b"]);
  });

  it("truncates an individual log line before returning it", async () => {
    const [line] = await tailLogs(
      {
        async readRotation() {
          return "x".repeat(10_000);
        },
      },
      1,
    );
    expect(line).toHaveLength(4_096);
  });
});
