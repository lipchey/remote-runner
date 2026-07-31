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
  ) {}

  async inspect(probe: (typeof DIAGNOSTIC_PROBES)[number]) {
    this.observed.push(probe.id);
    return {
      status: this.outcomes[probe.id] ?? "ok",
      rawOutput: probe.reason === "transport" ? "postgres://user:secret-canary@db/test" : "",
    };
  }
}

describe("doctor", () => {
  it("reports stable reason codes without raw diagnostic output", async () => {
    const runtime = new FakeDoctorRuntime({ "ssh.transport": "fail" });

    const report = await doctor(runtime);

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "ssh.transport",
      status: "fail",
      reason: "transport",
    }));
    expect(JSON.stringify(report)).not.toContain("secret-canary");
  });

  it("runs every declared probe as a read-only argv command", async () => {
    const runtime = new FakeDoctorRuntime();

    await doctor(runtime);

    expect(runtime.observed).toEqual(DIAGNOSTIC_PROBES.map((probe) => probe.id));
    expect(DIAGNOSTIC_PROBES.every((probe) => probe.readOnly)).toBe(true);
    expect(new Set(DIAGNOSTIC_PROBES.map((probe) => probe.reason)).size).toBe(
      DIAGNOSTIC_PROBES.length,
    );
    expect(DIAGNOSTIC_PROBES.every((probe) => probe.command.length > 0)).toBe(true);
  });

  it("converts probe exceptions into bounded failures", async () => {
    const runtime: DoctorRuntime = {
      async inspect(probe) {
        if (probe.id === "sync.session") throw new Error("secret-canary");
        return { status: "ok", rawOutput: "" };
      },
    };

    const report = await doctor(runtime);

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "sync.session",
      status: "fail",
      reason: "sync",
    }));
    expect(JSON.stringify(report)).not.toContain("secret-canary");
  });
});

describe("status formatting", () => {
  it("prints only concise bounded status fields", () => {
    const output = formatStatus({
      profile: "verify-full",
      controller: "running",
      session: "watching",
      workspace: "ready",
      fingerprint: "current",
      outage: "clear",
    });

    expect(output).toBe(
      "verify-full controller=running session=watching workspace=ready fingerprint=current outage=clear",
    );
  });
});

describe("bounded log tail", () => {
  it("reads only the owned rotation set and returns the newest bounded lines", async () => {
    const reads: number[] = [];
    const lines = await tailLogs({
      async readRotation(index) {
        reads.push(index);
        return index === 0 ? "current-a\ncurrent-b\n" : `old-${index}\n`;
      },
    }, 3);

    expect(reads).toEqual([3, 2, 1, 0]);
    expect(lines).toEqual(["old-1", "current-a", "current-b"]);
  });

  it("truncates an individual log line before returning it", async () => {
    const [line] = await tailLogs({ async readRotation() { return "x".repeat(10_000); } }, 1);
    expect(line).toHaveLength(4_096);
  });
});
