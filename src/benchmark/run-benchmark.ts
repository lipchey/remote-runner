import type { Profile } from "../config/types.js";

export interface BenchmarkSample {
  readonly location: "local" | "remote";
  readonly workloadId: string;
  readonly cache: "warmup" | "cold" | "warm";
  readonly syncMs: number;
  readonly setupMs: number;
  readonly workloadMs: number;
  readonly status: number;
  readonly cpuLoad?: number;
  readonly peakMemoryBytes?: number;
  readonly transferredBytes?: number;
  readonly cacheHitRatio?: number;
}

export interface BenchmarkExecution {
  readonly location: BenchmarkSample["location"];
  readonly workloadId: string;
  readonly cache: BenchmarkSample["cache"];
  readonly command: readonly string[];
}

export interface BenchmarkSampleResult {
  readonly syncMs: number;
  readonly setupMs: number;
  readonly workloadMs: number;
  readonly status: number;
  readonly cpuLoad?: number;
  readonly peakMemoryBytes?: number;
  readonly transferredBytes?: number;
  readonly cacheHitRatio?: number;
}

export interface BenchmarkRuntime {
  now(): string;
  runSample(execution: BenchmarkExecution): Promise<BenchmarkSampleResult>;
  writeReceipt(path: string, contents: string): Promise<void>;
}

export interface BenchmarkRow {
  readonly location: BenchmarkSample["location"];
  readonly workloadId: string;
  readonly cache: "cold" | "warm";
  readonly samples: number;
  readonly successfulSamples: number;
  readonly status: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly wallMedianMs: number;
  readonly syncMedianMs: number;
  readonly setupMedianMs: number;
  readonly cpuLoad?: number;
  readonly peakMemoryBytes?: number;
  readonly transferredBytes?: number;
  readonly cacheHitRatio?: number;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly profile: string;
  readonly samples: readonly BenchmarkSample[];
  readonly rows: readonly BenchmarkRow[];
  readonly receiptPaths: readonly [string, string];
}

const INFRASTRUCTURE_EXIT_CODE = 75;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/u;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255;
}

function optionalMetric(value: unknown, maximum = Number.POSITIVE_INFINITY): number | undefined {
  return finiteNonNegative(value) && value <= maximum ? value : undefined;
}

function failedSample(execution: BenchmarkExecution): BenchmarkSample {
  return {
    location: execution.location,
    workloadId: execution.workloadId,
    cache: execution.cache,
    syncMs: 0,
    setupMs: 0,
    workloadMs: 0,
    status: INFRASTRUCTURE_EXIT_CODE,
  };
}

function normalizeSample(
  execution: BenchmarkExecution,
  result: BenchmarkSampleResult,
): BenchmarkSample {
  if (
    !finiteNonNegative(result.syncMs) ||
    !finiteNonNegative(result.setupMs) ||
    !finiteNonNegative(result.workloadMs) ||
    !validStatus(result.status)
  ) return failedSample(execution);
  return {
    location: execution.location,
    workloadId: execution.workloadId,
    cache: execution.cache,
    syncMs: result.syncMs,
    setupMs: result.setupMs,
    workloadMs: result.workloadMs,
    status: result.status,
    ...(optionalMetric(result.cpuLoad) === undefined ? {} : { cpuLoad: result.cpuLoad }),
    ...(optionalMetric(result.peakMemoryBytes) === undefined ? {} : { peakMemoryBytes: result.peakMemoryBytes }),
    ...(optionalMetric(result.transferredBytes) === undefined ? {} : { transferredBytes: result.transferredBytes }),
    ...(optionalMetric(result.cacheHitRatio, 1) === undefined ? {} : { cacheHitRatio: result.cacheHitRatio }),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("cannot aggregate an empty benchmark sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]!
    : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function optionalMedian(samples: readonly BenchmarkSample[], field: keyof BenchmarkSample): number | undefined {
  const values = samples.map((sample) => sample[field]).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? undefined : median(values);
}

function aggregate(
  location: BenchmarkSample["location"],
  workloadId: string,
  cache: "cold" | "warm",
  samples: readonly BenchmarkSample[],
): BenchmarkRow {
  const workloadTimes = samples.map((sample) => sample.workloadMs);
  const firstFailure = samples.find((sample) => sample.status !== 0)?.status ?? 0;
  const cpuLoad = optionalMedian(samples, "cpuLoad");
  const peakMemoryBytes = optionalMedian(samples, "peakMemoryBytes");
  const transferredBytes = optionalMedian(samples, "transferredBytes");
  const cacheHitRatio = optionalMedian(samples, "cacheHitRatio");
  return {
    location,
    workloadId,
    cache,
    samples: samples.length,
    successfulSamples: samples.filter((sample) => sample.status === 0).length,
    status: firstFailure,
    medianMs: median(workloadTimes),
    minMs: Math.min(...workloadTimes),
    maxMs: Math.max(...workloadTimes),
    wallMedianMs: median(samples.map((sample) => sample.syncMs + sample.setupMs + sample.workloadMs)),
    syncMedianMs: median(samples.map((sample) => sample.syncMs)),
    setupMedianMs: median(samples.map((sample) => sample.setupMs)),
    ...(cpuLoad === undefined ? {} : { cpuLoad }),
    ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
    ...(transferredBytes === undefined ? {} : { transferredBytes }),
    ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
  };
}

function timestampSlug(createdAt: string): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error("benchmark timestamp is invalid");
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".000", "");
}

function markdown(report: BenchmarkReport): string {
  const lines = [
    `# Benchmark: ${report.profile}`,
    "",
    `Created: ${report.createdAt}`,
    "",
    "| Location | Workload | Cache | Samples | Successful | Status | Wall median ms | Workload median ms | Range ms | Sync median ms | Setup median ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.location} | ${row.workloadId} | ${row.cache} | ${row.samples} | ${row.successfulSamples} | ${row.status} | ${row.wallMedianMs} | ${row.medianMs} | ${row.minMs}–${row.maxMs} | ${row.syncMedianMs} | ${row.setupMedianMs} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runBenchmark(
  runtime: BenchmarkRuntime,
  profile: Pick<Profile, "id" | "benchmark">,
): Promise<BenchmarkReport> {
  if (!PROFILE_ID.test(profile.id)) throw new Error("benchmark profile id is invalid");
  if (!Number.isSafeInteger(profile.benchmark.samples) || profile.benchmark.samples < 3 || profile.benchmark.samples > 1_000) {
    throw new Error("benchmark samples must be an integer between 3 and 1000");
  }
  const createdAt = new Date(runtime.now()).toISOString();
  const prefix = `benchmark/${timestampSlug(createdAt)}-${profile.id}`;
  const receiptPaths = [`${prefix}.json`, `${prefix}.md`] as const;
  const samples: BenchmarkSample[] = [];
  const rows: BenchmarkRow[] = [];

  for (const location of ["local", "remote"] as const) {
    for (const workload of profile.benchmark.workloads) {
      if (!PROFILE_ID.test(workload.id) || workload.command.length === 0) {
        throw new Error("benchmark workload is invalid");
      }
      const matrix: BenchmarkSample["cache"][] = [
        "warmup",
        ...Array.from({ length: profile.benchmark.samples }, () => "cold" as const),
        ...Array.from({ length: profile.benchmark.samples }, () => "warm" as const),
      ];
      for (const cache of matrix) {
        const execution: BenchmarkExecution = {
          location,
          workloadId: workload.id,
          cache,
          command: [...workload.command],
        };
        let sample: BenchmarkSample;
        try {
          sample = normalizeSample(execution, await runtime.runSample(execution));
        } catch {
          sample = failedSample(execution);
        }
        samples.push(sample);
      }
      for (const cache of ["cold", "warm"] as const) {
        rows.push(aggregate(
          location,
          workload.id,
          cache,
          samples.filter((sample) =>
            sample.location === location && sample.workloadId === workload.id && sample.cache === cache,
          ),
        ));
      }
    }
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    createdAt,
    profile: profile.id,
    samples,
    rows,
    receiptPaths,
  };
  await runtime.writeReceipt(receiptPaths[0], `${JSON.stringify(report, null, 2)}\n`);
  await runtime.writeReceipt(receiptPaths[1], markdown(report));
  return report;
}
