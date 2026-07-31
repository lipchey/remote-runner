import { describe, expect, it } from "vitest";

import { loadManifestText } from "../../../src/config/load-manifest.js";
import {
  runBenchmark,
  type BenchmarkExecution,
  type BenchmarkRuntime,
} from "../../../src/benchmark/run-benchmark.js";
import { validManifest } from "../config/manifest-fixture.js";

class FakeBenchmarkRuntime implements BenchmarkRuntime {
  readonly executions: BenchmarkExecution[] = [];
  readonly writes: Array<{ path: string; contents: string }> = [];
  private counters = new Map<string, number>();

  constructor(
    private readonly executeSample: (execution: BenchmarkExecution, index: number) => Promise<{
      syncMs: number;
      setupMs: number;
      workloadMs: number;
      status: number;
      cpuLoad?: number;
      peakMemoryBytes?: number;
      transferredBytes?: number;
      cacheHitRatio?: number;
    }> = async (_execution, index) => ({
      syncMs: 10,
      setupMs: 20,
      workloadMs: [0, 1_800, 2_000, 2_300, 1_000, 1_100, 1_200][index]!,
      status: 0,
      cpuLoad: 2.5,
      peakMemoryBytes: 1_024,
      transferredBytes: 512,
      cacheHitRatio: 0.75,
    }),
  ) {}

  now() { return "2026-07-31T12:34:56.000Z"; }

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

  samples(location: "local" | "remote", workloadId: string) {
    return this.executions
      .filter((entry) => entry.location === location && entry.workloadId === workloadId)
      .map((entry) => entry.cache);
  }
}

const profile = loadManifestText(validManifest).profiles[0]!;

describe("runBenchmark", () => {
  it("runs warm-up plus three cold and three warm samples per location", async () => {
    const runtime = new FakeBenchmarkRuntime();

    const report = await runBenchmark(runtime, profile);

    expect(runtime.samples("local", "full")).toEqual([
      "warmup", "cold", "cold", "cold", "warm", "warm", "warm",
    ]);
    expect(runtime.samples("remote", "full")).toEqual([
      "warmup", "cold", "cold", "cold", "warm", "warm", "warm",
    ]);
    expect(report.rows[0]).toMatchObject({
      location: "local",
      workloadId: "full",
      cache: "cold",
      medianMs: 2_000,
      minMs: 1_800,
      maxMs: 2_300,
      wallMedianMs: 2_030,
      status: 0,
    });
  });

  it("excludes warm-up, preserves workload failures, and aggregates available metrics", async () => {
    const runtime = new FakeBenchmarkRuntime(async (execution, index) => ({
      syncMs: index === 0 ? 99_999 : 10 + index,
      setupMs: index === 0 ? 99_999 : 20 + index,
      workloadMs: index === 0 ? 99_999 : index * 100,
      status: execution.location === "local" && index === 2 ? 42 : 0,
      ...(index % 2 === 0 ? { peakMemoryBytes: index * 1_000 } : {}),
    }));

    const report = await runBenchmark(runtime, profile);
    const localCold = report.rows.find((row) =>
      row.location === "local" && row.workloadId === "full" && row.cache === "cold",
    );

    expect(localCold).toMatchObject({
      medianMs: 200,
      minMs: 100,
      maxMs: 300,
      status: 42,
      samples: 3,
      successfulSamples: 2,
      peakMemoryBytes: 2_000,
    });
    expect(localCold?.medianMs).not.toBe(99_999);
  });

  it("uses only declared workload argv and writes timestamped JSON and Markdown receipts", async () => {
    const runtime = new FakeBenchmarkRuntime();

    const report = await runBenchmark(runtime, profile);

    expect(runtime.executions.every((execution) =>
      execution.command.join("\0") === profile.benchmark.workloads[0]!.command.join("\0"),
    )).toBe(true);
    expect(runtime.writes.map((write) => write.path)).toEqual([
      "benchmark/20260731T123456Z-verify-full.json",
      "benchmark/20260731T123456Z-verify-full.md",
    ]);
    expect(JSON.parse(runtime.writes[0]!.contents)).toMatchObject({
      profile: "verify-full",
      receiptPaths: report.receiptPaths,
    });
    expect(runtime.writes[1]!.contents).toContain("| local | full | cold |");
  });

  it("turns thrown secret-bearing errors into sanitized failed samples", async () => {
    const runtime = new FakeBenchmarkRuntime(async (_execution, index) => {
      if (index === 2) throw new Error("postgres://user:secret-canary@db/test");
      return { syncMs: 1, setupMs: 2, workloadMs: 3, status: 0 };
    });

    const report = await runBenchmark(runtime, profile);
    const serialized = JSON.stringify({ report, writes: runtime.writes });

    expect(serialized).not.toContain("secret-canary");
    expect(report.rows.some((row) => row.status === 75)).toBe(true);
    expect(report.rows.every((row) => row.cpuLoad === undefined)).toBe(true);
  });
});
