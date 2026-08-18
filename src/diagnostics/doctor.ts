import type { PrewarmState } from "../prewarm/queue.js";

export type DiagnosticStatus = "ok" | "warn" | "fail";

export interface DiagnosticProbe {
  readonly id: string;
  readonly reason: string;
  readonly readOnly: true;
  readonly command: readonly string[];
}

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: DiagnosticStatus;
  readonly reason?: string;
  readonly detail?: string;
  readonly next: string;
}

const MAX_DETAIL_CHARS = 200;

function sanitizedDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const [first = ""] = value.split("\n");
  const detail = first.replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (detail.length === 0) return undefined;
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 3)}...` : detail;
}

export interface DoctorReport {
  readonly checks: readonly DiagnosticCheck[];
}

export interface DoctorProfileReport {
  readonly profile: string;
  readonly report: DoctorReport;
}

export interface DoctorRuntime {
  inspect(probe: DiagnosticProbe): Promise<{
    readonly status: DiagnosticStatus;
    /* Authored text only — an inspector must never pass through what a remote, a vendor binary or a
       native error produced, because this one is serialized into the report the operator shares.
       Sanitizing here bounds the shape, never the provenance. */
    readonly detail?: string;
    readonly rawOutput?: string;
  }>;
}

export const DIAGNOSTIC_PROBES = [
  {
    id: "network.dns",
    reason: "dns",
    readOnly: true,
    command: ["dscacheutil", "-q", "host", "-a", "name", "<remote>"],
  },
  { id: "ssh.host-key", reason: "host-key", readOnly: true, command: ["ssh-keygen", "-F", "<remote>"] },
  {
    id: "ssh.authentication",
    reason: "authentication",
    readOnly: true,
    command: ["ssh", "-o", "BatchMode=yes", "<remote>", "true"],
  },
  {
    id: "ssh.transport",
    reason: "transport",
    readOnly: true,
    command: ["ssh", "-o", "ConnectTimeout=5", "<remote>", "true"],
  },
  {
    id: "ssh.remote-shell",
    reason: "remote-shell",
    readOnly: true,
    command: ["ssh", "<remote>", "printf remote-shell-ok"],
  },
  { id: "remote.capacity", reason: "capacity", readOnly: true, command: ["ssh", "<remote>", "df -Pk <workspace>"] },
  {
    id: "remote.bootstrap",
    reason: "bootstrap",
    readOnly: true,
    command: ["ssh", "<remote>", "test -x <toolchain>/bin/node && test -x <toolchain>/bin/pnpm"],
  },
  { id: "runtime.lock", reason: "lock", readOnly: true, command: ["ls", "-ld", "<lock-root>"] },
  { id: "sync.session", reason: "sync", readOnly: true, command: ["mutagen", "sync", "list", "<session>"] },
  {
    id: "remote.workspace",
    reason: "workspace",
    readOnly: true,
    command: ["ssh", "<remote>", "git -C <workspace> status --short --branch"],
  },
  {
    id: "remote.workspace-registration",
    reason: "workspace-registration",
    readOnly: true,
    command: ["ssh", "<remote>", "inspect exact Git worktree registration for <workspace>"],
  },
  {
    id: "secrets.persistence",
    reason: "secrets",
    readOnly: true,
    command: [
      "ssh",
      "<remote>",
      'if found=$(find <workspace> -maxdepth 1 -name .env -print); then [ -z "$found" ]; else exit 1; fi',
    ],
  },
  {
    id: "controller.health",
    reason: "controller",
    readOnly: true,
    command: ["launchctl", "print", "gui/<uid>/com.lipchey.remote-runner"],
  },
  {
    id: "network.timeout",
    reason: "timeout",
    readOnly: true,
    command: ["ssh", "-o", "ConnectTimeout=2", "<remote>", "true"],
  },
  /* Not every stable reason has a probe, and this table must not grow one for the sake of coverage:
     a row here is executed, and its status feeds the doctor exit code, so a row without a check that
     can fail makes the exit code assert a check that never ran. `validation`, `child-start` and
     `unknown` were exactly that (two hardcoded `ok`, one `tail` proving only that the log file
     exists) and joined `consumer-setup` and `connection-lost` in the runbook's reason index, which
     is where a reason with no read-only check gets its operator next step. */
] as const satisfies readonly DiagnosticProbe[];

function isDiagnosticStatus(value: unknown): value is DiagnosticStatus {
  return value === "ok" || value === "warn" || value === "fail";
}

export async function doctor(runtime: DoctorRuntime): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  for (const probe of DIAGNOSTIC_PROBES) {
    let status: DiagnosticStatus;
    let detail: string | undefined;
    try {
      const observation = await runtime.inspect(probe);
      status = isDiagnosticStatus(observation.status) ? observation.status : "fail";
      detail = sanitizedDetail(observation.detail);
    } catch {
      status = "fail";
    }
    checks.push({
      id: probe.id,
      status,
      ...(status === "ok" ? {} : { reason: probe.reason }),
      ...(status === "ok" || detail === undefined ? {} : { detail }),
      next: probe.command.join(" "),
    });
  }
  return { checks };
}

export interface StatusSnapshot {
  readonly profile: string;
  readonly controller: "running" | "stopped" | "incompatible" | "unknown";
  readonly prewarm: PrewarmState;
  readonly session: "watching" | "paused" | "missing" | "unknown";
  readonly workspace: "ready" | "missing" | "dirty" | "unknown";
  readonly fingerprint: "current" | "stale" | "missing" | "unknown";
  readonly outage: "clear" | "active" | "pending" | "unknown";
}

const STATUS_FIELD = /^[a-z][a-z0-9-]{0,62}$/u;

function formatPrewarm(prewarm: PrewarmState): string {
  if (typeof prewarm === "string") return prewarm;
  return prewarm.outcome === "ok" ? `ok@${prewarm.at}` : `failed(${prewarm.status})@${prewarm.at}`;
}

export function formatStatus(snapshot: StatusSnapshot): string {
  if (!STATUS_FIELD.test(snapshot.profile)) throw new Error("status profile is invalid");
  return `${snapshot.profile} controller=${snapshot.controller} prewarm=${formatPrewarm(snapshot.prewarm)} session=${snapshot.session} workspace=${snapshot.workspace} fingerprint=${snapshot.fingerprint} outage=${snapshot.outage}`;
}

export interface DiagnosticLogRuntime {
  readRotation(index: 0 | 1 | 2 | 3): Promise<string | undefined>;
}

const MAX_LOG_LINE_CHARS = 4_096;
const MAX_LOG_LINES = 200;

export async function tailLogs(
  runtime: DiagnosticLogRuntime,
  requestedLines = MAX_LOG_LINES,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(requestedLines) || requestedLines < 1 || requestedLines > MAX_LOG_LINES) {
    throw new Error(`log line count must be between 1 and ${MAX_LOG_LINES}`);
  }
  const lines: string[] = [];
  for (const index of [3, 2, 1, 0] as const) {
    const contents = await runtime.readRotation(index);
    if (contents === undefined) continue;
    const rotationLines = contents.split("\n");
    if (rotationLines.at(-1) === "") rotationLines.pop();
    for (const line of rotationLines) lines.push(line.slice(0, MAX_LOG_LINE_CHARS));
  }
  return lines.slice(-requestedLines);
}
