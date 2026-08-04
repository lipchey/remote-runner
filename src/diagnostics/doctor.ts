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
  readonly next: string;
}

export interface DoctorReport {
  readonly checks: readonly DiagnosticCheck[];
}

export interface DoctorRuntime {
  inspect(probe: DiagnosticProbe): Promise<{
    readonly status: DiagnosticStatus;
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
  {
    id: "profile.validation",
    reason: "validation",
    readOnly: true,
    command: ["remote-runner", "validate", "<profile>"],
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
    command: ["ssh", "<remote>", "find <workspace> -maxdepth 1 -name .env -print"],
  },
  {
    id: "controller.health",
    reason: "controller",
    readOnly: true,
    command: ["launchctl", "print", "gui/<uid>/com.lipchey.remote-runner"],
  },
  { id: "workload.child-start", reason: "child-start", readOnly: true, command: ["tail", "-n", "50", "<runner-log>"] },
  {
    id: "network.timeout",
    reason: "timeout",
    readOnly: true,
    command: ["ssh", "-o", "ConnectTimeout=2", "<remote>", "true"],
  },
  { id: "runtime.unknown", reason: "unknown", readOnly: true, command: ["remote-runner", "status", "<profile>"] },
] as const satisfies readonly DiagnosticProbe[];

function isDiagnosticStatus(value: unknown): value is DiagnosticStatus {
  return value === "ok" || value === "warn" || value === "fail";
}

export async function doctor(runtime: DoctorRuntime): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  for (const probe of DIAGNOSTIC_PROBES) {
    let status: DiagnosticStatus;
    try {
      const observation = await runtime.inspect(probe);
      status = isDiagnosticStatus(observation.status) ? observation.status : "fail";
    } catch {
      status = "fail";
    }
    checks.push({
      id: probe.id,
      status,
      ...(status === "ok" ? {} : { reason: probe.reason }),
      next: probe.command.join(" "),
    });
  }
  return { checks };
}

export interface StatusSnapshot {
  readonly profile: string;
  readonly controller: "running" | "stopped" | "incompatible" | "unknown";
  readonly prewarm: "idle" | "queued" | "running" | "unknown";
  readonly session: "watching" | "paused" | "missing" | "unknown";
  readonly workspace: "ready" | "missing" | "dirty" | "unknown";
  readonly fingerprint: "current" | "stale" | "missing" | "unknown";
  readonly outage: "clear" | "active" | "pending" | "unknown";
}

const STATUS_FIELD = /^[a-z][a-z0-9-]{0,62}$/u;

export function formatStatus(snapshot: StatusSnapshot): string {
  if (!STATUS_FIELD.test(snapshot.profile)) throw new Error("status profile is invalid");
  return `${snapshot.profile} controller=${snapshot.controller} prewarm=${snapshot.prewarm} session=${snapshot.session} workspace=${snapshot.workspace} fingerprint=${snapshot.fingerprint} outage=${snapshot.outage}`;
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
