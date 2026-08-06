import { describe, expect, it } from "vitest";

import { loadManifestText } from "../../../src/config/load-manifest.js";
import { runBenchmark, type BenchmarkExecution, type BenchmarkRuntime } from "../../../src/benchmark/run-benchmark.js";
import { validManifest } from "../config/manifest-fixture.js";

class FakeBenchmarkRuntime implements BenchmarkRuntime {
  readonly executions: BenchmarkExecution[] = [];
  readonly writes: Array<{ path: string; contents: string }> = [];
  private counters = new Map<string, number>();

  constructor(
    private readonly executeSample: (
      execution: BenchmarkExecution,
      index: number,
    ) => Promise<{ elapsedMs: number; status: number }> = async (_execution, index) => ({
      elapsedMs: [0, 1_800, 2_000, 2_300][index]!,
      status: 0,
    }),
  ) {}

  now() {
    return "2026-07-31T12:34:56.000Z";
  }

  async runSample(execution: BenchmarkExecution) {
    this.executions.push(execution);
    const key = `${execution.location}:${execution.workloadId}`;
    const index = this.counters.get(key) ?? 0;
    this.counters.set(key, index + 1);
    return this.executeSample(execution, index);
  }

  async writeReceipt(path: string, contents: string) {
    this.writes.push({ path, contents });
  }

  executionCount(location: "local" | "remote", workloadId: string) {
    return this.executions.filter((entry) => entry.location === location && entry.workloadId === workloadId).length;
  }
}

const profile = loadManifestText(validManifest).profiles[0]!;

describe("runBenchmark", () => {
  it("runs one warm-up plus samples measured runs per (location x workload) pair", async () => {
    const runtime = new FakeBenchmarkRuntime();

    const report = await runBenchmark(runtime, profile);

    expect(runtime.executionCount("local", "full")).toBe(1 + profile.benchmark.samples);
    expect(runtime.executionCount("remote", "full")).toBe(1 + profile.benchmark.samples);
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      location: "local",
      workloadId: "full",
      samples: profile.benchmark.samples,
      medianMs: 2_000,
      minMs: 1_800,
      maxMs: 2_300,
      status: 0,
    });
  });

  it("excludes the warm-up sample from aggregation, and preserves workload failures", async () => {
    const runtime = new FakeBenchmarkRuntime(async (execution, index) => ({
      elapsedMs: index === 0 ? 99_999 : index * 100,
      status: execution.location === "local" && index === 2 ? 42 : 0,
    }));

    const report = await runBenchmark(runtime, profile);
    const local = report.rows.find((row) => row.location === "local" && row.workloadId === "full");

    expect(local).toMatchObject({
      medianMs: 200,
      minMs: 100,
      maxMs: 300,
      status: 42,
      samples: 3,
      successfulSamples: 2,
    });
    expect(local?.medianMs).not.toBe(99_999);
    expect(report.samples.some((sample) => sample.elapsedMs === 99_999)).toBe(false);
  });

  it("reports null median and range for a pair with no successful sample, never a fabricated 0", async () => {
    const runtime = new FakeBenchmarkRuntime(async () => ({ elapsedMs: 0, status: 1 }));

    const report = await runBenchmark(runtime, profile);
    const local = report.rows.find((row) => row.location === "local" && row.workloadId === "full");

    expect(local).toMatchObject({
      samples: profile.benchmark.samples,
      successfulSamples: 0,
      status: 1,
      medianMs: null,
      minMs: null,
      maxMs: null,
    });
  });

  it("uses only declared workload argv and writes timestamped JSON and Markdown receipts", async () => {
    const runtime = new FakeBenchmarkRuntime();

    const report = await runBenchmark(runtime, profile);

    expect(runtime.executions).toHaveLength(2 * (1 + profile.benchmark.samples));
    expect(
      runtime.executions.every(
        (execution) => execution.command.join("\0") === profile.benchmark.workloads[0]!.command.join("\0"),
      ),
    ).toBe(true);
    expect(runtime.writes.map((write) => write.path)).toEqual([
      "benchmark/20260731T123456Z-verify-full.json",
      "benchmark/20260731T123456Z-verify-full.md",
    ]);
    expect(JSON.parse(runtime.writes[0]!.contents)).toMatchObject({
      schemaVersion: 2,
      profile: "verify-full",
      receiptPaths: report.receiptPaths,
    });
    expect(runtime.writes[1]!.contents).toContain("| local | full |");
  });

  it("turns thrown secret-bearing errors into sanitized failed samples", async () => {
    const runtime = new FakeBenchmarkRuntime(async (_execution, index) => {
      if (index === 2) throw new Error("postgres://user:secret-canary@db/test");
      return { elapsedMs: 3, status: 0 };
    });

    const report = await runBenchmark(runtime, profile);
    const serialized = JSON.stringify({ report, writes: runtime.writes });

    expect(serialized).not.toContain("secret-canary");
    expect(report.rows.some((row) => row.status === 75)).toBe(true);
  });
});
