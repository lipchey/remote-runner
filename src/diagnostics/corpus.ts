import { join } from "node:path";

/* The cut sits in an observed empty band — a reused workspace finishes in ~1.7-3.7 s, a rebuilt one
   at 5 s and above — measured on one machine, which is why it is overridable. */
export const COLD_BOOTSTRAP_MS = 5000;

/* The runner rotates at a size cap, so the live file alone is the most recent slice and not the
   history; oldest first keeps the merged stream in append order. */
const LOG_FILES = ["runner.log.3", "runner.log.2", "runner.log.1", "runner.log"] as const;

const MAX_RENDERED_FAILURES = 15;

export interface CorpusRecord {
  readonly at: string;
  readonly event: string;
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly provider?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly runId?: string;
  readonly durationMs?: number;
  readonly phases?: { readonly bootstrap?: number };
}

export interface CorpusRuntime {
  listDirectories(path: string): Promise<readonly string[]>;
  readLog(path: string): Promise<string | undefined>;
}

export interface CorpusRead {
  readonly records: readonly CorpusRecord[];
  readonly unparsed: number;
  readonly files: number;
}

export interface CorpusOptions {
  readonly since?: string;
  readonly coldThresholdMs?: number;
}

export interface CorpusProvenance {
  readonly source: string;
  readonly files: number;
  readonly unparsed: number;
  readonly runner: string;
}

export interface CorpusFailure {
  readonly at: string;
  readonly consumer: string;
  readonly profile: string;
  readonly identity: string;
  readonly runId: string | null;
  readonly status: number | null;
  readonly durationMs: number | null;
}

export interface CorpusBootstrap {
  readonly measured: number;
  readonly of: number;
  readonly coldThresholdMs: number;
  readonly cold: number;
  readonly medianMs: number | null;
  readonly maxMs: number | null;
  readonly returning: number;
  readonly returningCold: number;
  readonly measuredMs: readonly number[];
}

export interface CorpusSummary {
  readonly since: string;
  readonly records: number;
  readonly identities: number;
  readonly profiles: readonly string[];
  readonly span: { readonly from: string; readonly to: string } | null;
  readonly dispatched: { readonly total: number; readonly status: Readonly<Record<string, number>> };
  readonly undispatched: number;
  readonly deferred: Readonly<Record<string, number>>;
  readonly bootstrap: CorpusBootstrap;
  readonly failures: readonly CorpusFailure[];
}

export interface CorpusReport {
  readonly provenance: CorpusProvenance;
  readonly summary: CorpusSummary;
}

export interface CorpusEnvelope extends CorpusProvenance, Omit<CorpusSummary, "profiles" | "failures"> {
  readonly schemaVersion: 1;
  readonly profiles: readonly string[];
  readonly failures: readonly CorpusFailure[];
}

/* The version a consumer gates on: it carries what these fields MEAN, which no amount of
   shape-checking on the consumer side can establish. */
export function corpusJson(provenance: CorpusProvenance, summary: CorpusSummary): CorpusEnvelope {
  return { schemaVersion: 1, ...provenance, ...summary };
}

function laneKey(record: CorpusRecord): string {
  return `${record.consumer}/${record.profile}/${record.identity}`;
}

function parseRecord(line: string, consumer: string, profile: string, identity: string): CorpusRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.at !== "string" || typeof candidate.event !== "string") return undefined;
  /* The directory the log was found in decides which lane a record belongs to, not the record's own
     `profile` field: a spread that let the payload win would silently re-file every count under
     whatever the log claimed. */
  return { ...candidate, consumer, profile, identity } as unknown as CorpusRecord;
}

export async function readCorpus(runtime: CorpusRuntime, root: string): Promise<CorpusRead> {
  const records: CorpusRecord[] = [];
  let unparsed = 0;
  let files = 0;
  for (const consumer of await runtime.listDirectories(root)) {
    for (const profile of await runtime.listDirectories(join(root, consumer))) {
      for (const identity of await runtime.listDirectories(join(root, consumer, profile))) {
        for (const file of LOG_FILES) {
          const text = await runtime.readLog(join(root, consumer, profile, identity, file));
          if (text === undefined) continue;
          files += 1;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            /* The runner appends while this reads, so the final line can be a partial write:
               counting it loses one record, throwing loses the identity. */
            const record = parseRecord(line, consumer, profile, identity);
            if (record === undefined) unparsed += 1;
            else records.push(record);
          }
        }
      }
    }
  }
  /* Rotation already gives append order within one identity; `span` and the newest-first failures
     read across them. */
  records.sort((left, right) => left.at.localeCompare(right.at));
  return { records, unparsed, files };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[(sorted.length - 1) / 2] ?? null;
  /* Left unrounded: for an odd sum, rounding the midpoint returns exactly the upper middle, which is
     the value this figure exists to avoid reporting. */
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function summarizeCorpus(records: readonly CorpusRecord[], options: CorpusOptions = {}): CorpusSummary {
  const since = options.since ?? "";
  const coldThresholdMs = options.coldThresholdMs ?? COLD_BOOTSTRAP_MS;

  /* Computed over the WHOLE corpus, never the window: an identity whose earlier dispatches fall
     outside `--since` would otherwise be re-labelled a newcomer, and every such relabelling turns an
     eviction into an expected first build. A finish that never reached the remote provider built no
     workspace, so it cannot stand as a first dispatch either. */
  /* Held as the record itself, not its timestamp: two dispatches of one lane can share an `at`, and
     comparing timestamps would then excuse both from the returning counts. */
  const firstDispatch = new Set<CorpusRecord>();
  const dispatchedLanes = new Set<string>();
  for (const record of records) {
    if (record.event !== "run-finish" || record.provider !== "remote") continue;
    const key = laneKey(record);
    if (dispatchedLanes.has(key)) continue;
    dispatchedLanes.add(key);
    firstDispatch.add(record);
  }

  const windowed = since ? records.filter((record) => record.at >= since) : records;
  const finishes = windowed.filter((record) => record.event === "run-finish");
  /* `provider` names what actually ran the workload, so a finish without one never reached a
     provider and counting the two together inflates every remote-lane figure. */
  const dispatched = finishes.filter((record) => record.provider === "remote");
  const measured = dispatched.flatMap((record) => {
    const bootstrapMs = record.phases?.bootstrap;
    return typeof bootstrapMs === "number" ? [{ record, bootstrapMs }] : [];
  });
  /* A workspace that has never dispatched has nothing to reuse, so its first build is cold by
     construction and says nothing about retention. */
  const returning = measured.filter(({ record }) => !firstDispatch.has(record));
  const measuredMs = measured.map(({ bootstrapMs }) => bootstrapMs).sort((left, right) => left - right);

  return {
    since,
    records: windowed.length,
    identities: new Set(windowed.map(laneKey)).size,
    profiles: [...new Set(windowed.map((record) => `${record.consumer}/${record.profile}`))].sort(),
    span: windowed.length === 0 ? null : { from: windowed[0]?.at ?? "", to: windowed[windowed.length - 1]?.at ?? "" },
    dispatched: {
      total: dispatched.length,
      status: tally(dispatched.map((record) => String(record.status ?? "unknown"))),
    },
    undispatched: finishes.length - dispatched.length,
    deferred: tally(
      windowed.filter((record) => record.event === "run-unavailable").map((record) => record.reason ?? "unknown"),
    ),
    bootstrap: {
      measured: measuredMs.length,
      of: dispatched.length,
      coldThresholdMs,
      cold: measuredMs.filter((value) => value >= coldThresholdMs).length,
      medianMs: median(measuredMs),
      maxMs: measuredMs[measuredMs.length - 1] ?? null,
      returning: returning.length,
      returningCold: returning.filter(({ bootstrapMs }) => bootstrapMs >= coldThresholdMs).length,
      measuredMs,
    },
    failures: dispatched
      .filter((record) => record.status !== 0)
      .reverse()
      .map((record) => ({
        at: record.at,
        consumer: record.consumer,
        profile: record.profile,
        identity: record.identity,
        /* Typed at the boundary rather than passed through: the envelope declares these numeric, and
           the records come from a log this process does not own. */
        runId: typeof record.runId === "string" ? record.runId : null,
        status: typeof record.status === "number" ? record.status : null,
        durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
      })),
  };
}

/* Record-derived text reaches a terminal here, and a crafted log line can carry ANSI escapes that
   rewrite what the operator sees. `JSON.stringify` escapes control bytes itself; this render must. */
function plain(value: string): string {
  return value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
}

function formatTally(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "none" : entries.map(([key, count]) => `${plain(key)}=${count}`).join(" ");
}

export function formatCorpus(report: CorpusReport, options: { readonly failureLimit?: number } = {}): string {
  const { provenance, summary } = report;
  /* Only an absent corpus gets the absent message. Files that exist but yield nothing readable is
     what total format drift looks like, and reporting that as "no corpus" would swallow the one
     signal this read has for it. */
  if (provenance.files === 0) {
    return `no remote-runner log corpus at ${provenance.source} — nothing has been dispatched from this machine yet`;
  }
  const failureLimit = options.failureLimit ?? MAX_RENDERED_FAILURES;
  const { bootstrap } = summary;
  /* Provenance leads rather than trails: a number lifted out of this report into a permanent document
     takes its coverage with it or it takes nothing. */
  const lines = [
    `source     ${provenance.source}`,
    `read       ${provenance.files} log files, ${provenance.unparsed} unparseable records, runner ${provenance.runner}`,
    `corpus     ${summary.records} records, ${summary.identities} identities, profiles: ${plain(summary.profiles.join(", ")) || "none"}`,
    `span       ${plain(summary.span?.from ?? "-")} .. ${plain(summary.span?.to ?? "-")}`,
    `dispatched ${summary.dispatched.total} run-finish with provider=remote — status ${formatTally(summary.dispatched.status)}`,
    `undispatched ${summary.undispatched} run-finish never reached a provider`,
    /* Not a failure count: the runner emits these while a run waits, and the same run can still go
       on to finish green. */
    `deferred   ${formatTally(summary.deferred)} — waits, not outcomes; a deferred run can still finish green`,
  ];
  if (bootstrap.measured === 0) {
    lines.push("bootstrap  no per-phase records in this window");
  } else {
    lines.push(
      `bootstrap  ${bootstrap.measured} of ${bootstrap.of} dispatches carry per-phase spans — ${bootstrap.cold} cold (>=${bootstrap.coldThresholdMs}ms), median ${bootstrap.medianMs}ms, max ${bootstrap.maxMs}ms`,
      /* Deliberately not called "reclaimed": a cold bootstrap is consistent with retention having
         taken the workspace, but the log records no deletion event, and a failed fingerprint or
         `ensure` check produces the same span. */
      `returning  ${bootstrap.returningCold} of ${bootstrap.returning} identities that had dispatched before paid a cold bootstrap — consistent with a reclaimed workspace, not proof of one; a first-ever dispatch is excluded, being cold by construction`,
    );
  }
  if (summary.failures.length > 0) {
    lines.push(`failures   ${summary.failures.length} non-zero, newest first:`);
    for (const failure of summary.failures.slice(0, failureLimit)) {
      lines.push(
        `  ${plain(failure.at)}  ${plain(`${failure.consumer}/${failure.profile}`)}  ${plain(failure.identity).slice(0, 8)}  run ${plain(failure.runId ?? "?")}  status ${failure.status ?? "?"}  ${failure.durationMs ?? "?"}ms`,
      );
    }
    if (summary.failures.length > failureLimit) {
      lines.push(`  ... ${summary.failures.length - failureLimit} withheld; --json carries them all`);
    }
  }
  return lines.join("\n");
}
