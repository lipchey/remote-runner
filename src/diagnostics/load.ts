import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Profile } from "../config/types.js";
import { ensureManagedKnownHost } from "../node/managed-ssh.js";
import { runSsh, type SshProcessRuntime } from "../ssh/client.js";

export const HOST_LOAD_CAPTURE_BYTES = 8 * 1024 * 1024;
export const GITHUB_JOB_REFERENCE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+\/)[A-Za-z0-9_.-]+\/\d+$/u;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOURCES = [
  "ci",
  "ci-idle-load",
  "mutagen",
  "remote-runner",
  "remote-runner-orphan",
  "remote-runner-prep",
  "ssh",
  "docker",
  "sampler",
];

export interface LoadWindow {
  readonly from: number;
  readonly to: number;
}

export type LoadQuery = LoadWindow | { readonly githubJob: string };

interface LoadRow {
  readonly source: string;
  readonly labels: Readonly<Record<string, string | boolean>>;
  readonly mean_cores: number;
  readonly peak_cores: number | null;
  marked?: true;
}

interface LoadGroup extends LoadRow {
  readonly members: number;
  readonly share: number;
  readonly max_stall_pct: number;
}

interface LoadCgroup extends LoadRow {
  readonly key: string;
  readonly path: string;
  readonly stall_pct: number;
}

interface LoadJob {
  readonly ref: string;
  readonly runner_name: string;
  readonly started_at: string;
  readonly completed_at: string;
}

export interface HostLoadReport {
  readonly v: 1;
  readonly window: LoadWindow;
  readonly host: {
    readonly ncpu: number;
    readonly busy_cores_mean: number;
    readonly busy_pct: number;
    readonly psi: {
      readonly cpu_some_pct: number;
      readonly cpu_full_pct: number;
      readonly io_some_pct: number;
      readonly io_full_pct: number;
      readonly mem_some_pct: number;
      readonly mem_full_pct: number;
    };
  };
  readonly groups: LoadGroup[];
  readonly cgroups: LoadCgroup[];
  readonly unattributed: { readonly mean_cores: number; readonly share: number };
  readonly coverage: {
    readonly window_ms: number;
    readonly covered_ms: number;
    readonly samples: number;
    readonly missing_readings: number;
    readonly gaps: readonly LoadWindow[];
    readonly clock_discontinuities: readonly {
      readonly t: number;
      readonly wall_ms: number;
      readonly mono_ms: number;
    }[];
    readonly boots: readonly string[];
  };
  job?: LoadJob;
}

function assertWindow(window: LoadWindow): void {
  if (!Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.to <= window.from)
    throw new Error("load requires --to > --from");
  if (window.to - window.from > MAX_WINDOW_MS) throw new Error("load window must be at most 24 h");
}

function isoMilliseconds(value: string): number {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  const milliseconds = Date.parse(value);
  const day = parts?.[1];
  if (
    parts === null ||
    day === undefined ||
    !Number.isFinite(milliseconds) ||
    !new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ||
    Number(parts[2]) > 23 ||
    Number(parts[3]) > 59 ||
    Number(parts[4]) > 59 ||
    Number(parts[6] ?? 0) > 23 ||
    Number(parts[7] ?? 0) > 59
  )
    throw new Error("load --from/--to must be ISO timestamps with a timezone");
  return milliseconds;
}

export function parseLoadWindow(from: string, to: string): LoadWindow {
  const window = { from: isoMilliseconds(from), to: isoMilliseconds(to) };
  assertWindow(window);
  return window;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numbers(value: unknown, keys: readonly string[]): boolean {
  return record(value) && keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

function validRow(value: unknown, group: boolean): boolean {
  if (
    !record(value) ||
    typeof value.source !== "string" ||
    !SOURCES.includes(value.source) ||
    !record(value.labels) ||
    !Object.values(value.labels).every((label) => typeof label === "string" || typeof label === "boolean") ||
    !numbers(value, ["mean_cores"]) ||
    !(value.peak_cores === null || numbers(value, ["peak_cores"]))
  )
    return false;
  return group
    ? numbers(value, ["members", "share", "max_stall_pct"]) &&
        Number.isSafeInteger(value.members) &&
        Number(value.members) >= 0
    : typeof value.key === "string" && typeof value.path === "string" && numbers(value, ["stall_pct"]);
}

function parseReport(stdout: Uint8Array, window: LoadWindow): HostLoadReport {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
    if (
      !record(value) ||
      value.v !== 1 ||
      !record(value.window) ||
      value.window.from !== window.from ||
      value.window.to !== window.to ||
      !record(value.host) ||
      !numbers(value.host, ["ncpu", "busy_cores_mean", "busy_pct"]) ||
      !Number.isSafeInteger(value.host.ncpu) ||
      Number(value.host.ncpu) <= 0 ||
      !numbers(value.host.psi, [
        "cpu_some_pct",
        "cpu_full_pct",
        "io_some_pct",
        "io_full_pct",
        "mem_some_pct",
        "mem_full_pct",
      ]) ||
      !Array.isArray(value.groups) ||
      !value.groups.every((row) => validRow(row, true)) ||
      !Array.isArray(value.cgroups) ||
      !value.cgroups.every((row) => validRow(row, false)) ||
      !numbers(value.unattributed, ["mean_cores", "share"]) ||
      !record(value.coverage) ||
      !numbers(value.coverage, ["window_ms", "covered_ms", "samples", "missing_readings"]) ||
      !Array.isArray(value.coverage.gaps) ||
      !value.coverage.gaps.every((gap) => numbers(gap, ["from", "to"])) ||
      !Array.isArray(value.coverage.clock_discontinuities) ||
      !value.coverage.clock_discontinuities.every((step) => numbers(step, ["t", "wall_ms", "mono_ms"])) ||
      !Array.isArray(value.coverage.boots) ||
      !value.coverage.boots.every((boot) => typeof boot === "string")
    )
      throw new Error("invalid shape");
    return value as unknown as HostLoadReport;
  } catch {
    throw new Error("invalid host load report: expected the v1 JSON contract");
  }
}

async function githubJob(ref: string, gh: SshProcessRuntime): Promise<LoadJob> {
  const [owner, repository, id] = ref.split("/");
  const result = await gh.run({
    command: "gh",
    args: ["api", `repos/${owner}/${repository}/actions/jobs/${id}`],
    maxOutputBytes: HOST_LOAD_CAPTURE_BYTES,
  });
  if (!result.spawned || result.exitCode !== 0)
    throw new Error(
      result.spawnErrorCode === "ENOENT"
        ? "gh is missing; use --from/--to instead"
        : "gh job lookup failed; use --from/--to instead",
    );
  if (
    result.outputTruncated ||
    result.stdout.byteLength > HOST_LOAD_CAPTURE_BYTES ||
    result.stderr.byteLength > HOST_LOAD_CAPTURE_BYTES
  )
    throw new Error("gh job output limit exceeded; use --from/--to instead");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
  } catch {
    throw new Error("invalid gh job JSON; use --from/--to instead");
  }
  if (!record(value) || typeof value.completed_at !== "string")
    throw new Error("GitHub job has no completed_at; use --from/--to instead");
  if (typeof value.started_at !== "string" || typeof value.runner_name !== "string" || value.runner_name.length === 0)
    throw new Error("GitHub job has no start time or runner; use --from/--to instead");
  return { ref, runner_name: value.runner_name, started_at: value.started_at, completed_at: value.completed_at };
}

export async function readHostLoad(
  profile: Profile,
  query: LoadQuery,
  options: {
    readonly home: string;
    readonly knownHostsPath?: string;
    readonly processes: SshProcessRuntime;
    readonly gh?: SshProcessRuntime;
  },
): Promise<HostLoadReport> {
  if ("githubJob" in query) {
    if (!GITHUB_JOB_REFERENCE.test(query.githubJob)) throw new Error("invalid --github-job: expected owner/repo/jobId");
  } else assertWindow(query);
  const knownHostsPath =
    options.knownHostsPath ?? join(options.home, ".local", "state", "remote-runner", "known_hosts", "managed");
  await mkdir(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  await ensureManagedKnownHost(options.processes, {
    target: profile.remote.target,
    trustedFingerprint: profile.remote.hostKeySha256,
    knownHostsPath,
    connectTimeoutSeconds: profile.probes.connectTimeoutSeconds,
  });
  const job = "githubJob" in query ? await githubJob(query.githubJob, options.gh ?? options.processes) : undefined;
  const window = job === undefined ? (query as LoadWindow) : parseLoadWindow(job.started_at, job.completed_at);
  const result = await runSsh(
    options.processes,
    profile.remote.target,
    [
      "sh",
      "-ceu",
      'exec python3 "$HOME/.local/bin/host-load-sampler.py" report --from "$1" --to "$2"',
      "remote-runner-load",
      String(window.from),
      String(window.to),
    ],
    profile.probes.connectTimeoutSeconds,
    knownHostsPath,
    HOST_LOAD_CAPTURE_BYTES,
  );
  if (!result.spawned || result.exitCode !== 0) throw new Error(`host load report failed (exit ${result.exitCode})`);
  const report = parseReport(result.stdout, window);
  if (job !== undefined) {
    report.job = job;
    for (const row of [...report.groups, ...report.cgroups]) {
      if ((row.source === "ci" || row.source === "ci-idle-load") && row.labels.runner === job.runner_name)
        row.marked = true;
    }
  }
  return report;
}

function fixed(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatHostLoad(report: HostLoadReport, detail: boolean): string {
  const psi = report.host.psi;
  const lines = [
    `Host load ${new Date(report.window.from).toISOString()} .. ${new Date(report.window.to).toISOString()}`,
    ...(report.job === undefined
      ? []
      : [`Job ${report.job.ref}, runner ${JSON.stringify(report.job.runner_name)} (* marked)`]),
    table([
      ["SOURCE", "LABELS", "MEAN CORES", "SHARE", "PEAK CORES", "MAX STALL %"],
      ...report.groups.map((row) => [
        `${row.marked ? "* " : ""}${row.source}`,
        JSON.stringify(row.labels),
        fixed(row.mean_cores),
        `${fixed(row.share * 100)}%`,
        fixed(row.peak_cores),
        fixed(row.max_stall_pct),
      ]),
    ]),
    `Host busy: ${fixed(report.host.busy_cores_mean)} cores, ${fixed(report.host.busy_pct)}% of ${report.host.ncpu} CPUs`,
    `PSI: CPU some/full ${fixed(psi.cpu_some_pct)}%/${fixed(psi.cpu_full_pct)}%; IO some/full ${fixed(psi.io_some_pct)}%/${fixed(psi.io_full_pct)}%; Memory some/full ${fixed(psi.mem_some_pct)}%/${fixed(psi.mem_full_pct)}%`,
    `Unattributed: ${signed(report.unattributed.mean_cores)} cores, ${signed(report.unattributed.share * 100)}% share`,
    `Coverage: ${report.coverage.covered_ms}/${report.coverage.window_ms} ms, ${report.coverage.samples} samples, ${report.coverage.missing_readings} missing readings, ${report.coverage.boots.length} boots`,
    `Gaps: ${JSON.stringify(report.coverage.gaps)}`,
    `Clock discontinuities: ${JSON.stringify(report.coverage.clock_discontinuities)}`,
  ];
  if (detail)
    lines.push(
      table([
        ["CGROUP", "SOURCE", "LABELS", "MEAN CORES", "PEAK CORES", "STALL %"],
        ...report.cgroups.map((row) => [
          `${row.marked ? "* " : ""}${JSON.stringify(row.path)} (${JSON.stringify(row.key)})`,
          row.source,
          JSON.stringify(row.labels),
          fixed(row.mean_cores),
          fixed(row.peak_cores),
          fixed(row.stall_pct),
        ]),
      ]),
    );
  return lines.join("\n");
}
