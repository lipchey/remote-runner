/* The analysis subtracts the phase sum from the run's `durationMs` and reads the remainder as ssh
   idle, so two spans covering the same milliseconds are worse than one span missing. */
export const RUN_PHASES = [
  "validate",
  "lock",
  "probe",
  "sync-pause",
  "git-workspace",
  "sync-resume",
  "sync-flush",
  "bootstrap",
  "secrets",
  "child-start",
  "workload",
  "post-activity",
  "retention",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface SshAggregate {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface RunTelemetrySnapshot {
  readonly phases: Readonly<Record<string, number>>;
  readonly ssh: SshAggregate;
}

/* One instance per run only — shared with the controller or a concurrent run, it would count
   connections this run never made. */
export class RunTelemetry {
  private readonly totals = new Map<RunPhase, number>();
  private sshCount = 0;
  private sshTotalMs = 0;
  private sshMaxMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /* Negative deltas are legitimate — a retried step's span moves out of an outer span that already
     counted it. */
  add(phase: RunPhase, milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) return;
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + milliseconds);
  }

  start(phase: RunPhase): () => void {
    const startedAt = this.now();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.add(phase, this.now() - startedAt);
    };
  }

  async measure<T>(phase: RunPhase, run: () => Promise<T>): Promise<T> {
    const stop = this.start(phase);
    try {
      return await run();
    } finally {
      stop();
    }
  }

  async measureSsh<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await run();
    } finally {
      const elapsed = Math.max(0, this.now() - startedAt);
      this.sshCount += 1;
      this.sshTotalMs += elapsed;
      this.sshMaxMs = Math.max(this.sshMaxMs, elapsed);
    }
  }

  /* A phase the run never reached is absent rather than zero, which would read as work that
     happened instantly. */
  snapshot(): RunTelemetrySnapshot {
    const phases: Record<string, number> = {};
    for (const phase of RUN_PHASES) {
      const total = this.totals.get(phase);
      if (total !== undefined) phases[phase] = Math.max(0, Math.round(total));
    }
    return {
      phases,
      ssh: { count: this.sshCount, totalMs: Math.round(this.sshTotalMs), maxMs: Math.round(this.sshMaxMs) },
    };
  }
}
