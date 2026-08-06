import type { Profile } from "../config/types.js";

export interface BenchmarkSample {
  readonly location: "local" | "remote";
  readonly workloadId: string;
  readonly elapsedMs: number;
  readonly status: number;
}

export interface BenchmarkExecution {
  readonly location: BenchmarkSample["location"];
  readonly workloadId: string;
  readonly command: readonly string[];
}

export interface BenchmarkSampleResult {
  readonly elapsedMs: number;
  readonly status: number;
}

export interface BenchmarkRuntime {
  now(): string;
  runSample(execution: BenchmarkExecution): Promise<BenchmarkSampleResult>;
  writeReceipt(path: string, contents: string): Promise<void>;
}

export interface BenchmarkRow {
  readonly location: BenchmarkSample["location"];
  readonly workloadId: string;
  readonly samples: number;
  readonly successfulSamples: number;
  readonly status: number;
  readonly medianMs: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

export interface BenchmarkReport {
  readonly schemaVersion: 2;
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

function failedSample(execution: BenchmarkExecution): BenchmarkSample {
  return {
    location: execution.location,
    workloadId: execution.workloadId,
    elapsedMs: 0,
    status: INFRASTRUCTURE_EXIT_CODE,
  };
}

function normalizeSample(execution: BenchmarkExecution, result: BenchmarkSampleResult): BenchmarkSample {
  if (!finiteNonNegative(result.elapsedMs) || !validStatus(result.status)) return failedSample(execution);
  return {
    location: execution.location,
    workloadId: execution.workloadId,
    elapsedMs: result.elapsedMs,
    status: result.status,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("cannot aggregate an empty benchmark sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[midpoint]! : (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
}

function aggregate(
  location: BenchmarkSample["location"],
  workloadId: string,
  samples: readonly BenchmarkSample[],
): BenchmarkRow {
  const successfulTimes = samples.filter((sample) => sample.status === 0).map((sample) => sample.elapsedMs);
  const firstFailure = samples.find((sample) => sample.status !== 0)?.status ?? 0;
  return {
    location,
    workloadId,
    samples: samples.length,
    successfulSamples: successfulTimes.length,
    status: firstFailure,
    medianMs: successfulTimes.length === 0 ? null : median(successfulTimes),
    minMs: successfulTimes.length === 0 ? null : Math.min(...successfulTimes),
    maxMs: successfulTimes.length === 0 ? null : Math.max(...successfulTimes),
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
    "| Location | Workload | Samples | Successful | Status | Median ms | Range ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of report.rows) {
    const medianMs = row.medianMs === null ? "n/a" : row.medianMs;
    const range = row.minMs === null || row.maxMs === null ? "n/a" : `${row.minMs}–${row.maxMs}`;
    lines.push(
      `| ${row.location} | ${row.workloadId} | ${row.samples} | ${row.successfulSamples} | ${row.status} | ${medianMs} | ${range} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runBenchmark(
  runtime: BenchmarkRuntime,
  profile: Pick<Profile, "id" | "benchmark">,
): Promise<BenchmarkReport> {
  if (!PROFILE_ID.test(profile.id)) throw new Error("benchmark profile id is invalid");
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
      /* One untimed warm-up run precedes the measured samples; its result is discarded. */
      const runs: readonly boolean[] = [false, ...Array.from({ length: profile.benchmark.samples }, () => true)];
      for (const counted of runs) {
        const execution: BenchmarkExecution = {
          location,
          workloadId: workload.id,
          command: [...workload.command],
        };
        let sample: BenchmarkSample;
        try {
          sample = normalizeSample(execution, await runtime.runSample(execution));
        } catch {
          sample = failedSample(execution);
        }
        if (counted) samples.push(sample);
      }
      rows.push(
        aggregate(
          location,
          workload.id,
          samples.filter((sample) => sample.location === location && sample.workloadId === workload.id),
        ),
      );
    }
  }

  const report: BenchmarkReport = {
    schemaVersion: 2,
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
