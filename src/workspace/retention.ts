import { posix } from "node:path";

import type { WorkspaceRetentionPolicy } from "../config/types.js";
import type { RemoteCommandResult } from "../node/remote-toolchain.js";

const IDENTITY = /^[0-9a-f]{24}$/u;
const MINUTES_TO_MS = 60_000;

export interface WorkspaceActivity {
  readonly identity: string;
  readonly activityMs: number;
}

export interface WorkspaceRetentionPlan {
  readonly retained: readonly string[];
  readonly graceProtected: readonly string[];
  readonly candidates: readonly string[];
}

export type WorkspaceRetentionEntry =
  | (WorkspaceActivity & { readonly kind: "directory" })
  | (WorkspaceActivity & { readonly kind: "quarantine"; readonly quarantineName: string })
  | (WorkspaceActivity & { readonly kind: "unsafe" });

export type WorkspaceQuarantineResult = "removed" | "locked" | "missing" | "unsafe" | "refreshed";

/* The clock ships with the listing because it must come from the same machine as the timestamps it
   is compared against: activity mtimes are remote. A local clock running more than `graceMinutes`
   ahead makes every marker look stale, so a preparing identity that has fallen outside `keep` is
   quarantined and `rm -rf`d mid-preparation — before its workload lock exists, and past the remote
   freshness guard in `withQuarantine`, which is handed the same skewed cutoff. */
export interface WorkspaceRetentionListing {
  readonly nowMs: number;
  readonly entries: readonly WorkspaceRetentionEntry[];
}

export interface WorkspaceRetentionRuntime {
  list(): Promise<WorkspaceRetentionListing>;
  withQuarantine(
    identity: string,
    quarantineName: string,
    existing: boolean,
    graceCutoffMs: number,
    cleanup: () => Promise<void>,
  ): Promise<WorkspaceQuarantineResult>;
  terminateOwnedSync(identity: string): Promise<void>;
  /* Re-read under the caller's lock, because `list()` runs before it and an identity can start
     preparing in between. Fails closed: anything but a proven-absent workspace with an
     absent-or-stale marker answers false. */
  isIdentityDead(identity: string, graceCutoffMs: number): Promise<boolean>;
  removeQuarantine(quarantineName: string): Promise<void>;
  removeActivity(identity: string): Promise<void>;
  removeSetupState(identity: string): Promise<void>;
  removePrivateRef(identity: string): Promise<void>;
}

export interface WorkspaceRetentionSummary {
  readonly retained: number;
  readonly graceProtected: number;
  readonly locked: number;
  readonly removed: number;
  readonly failed: number;
  readonly ignored: number;
}

export interface WorkspaceRetentionCommandPort {
  run(args: readonly string[]): Promise<RemoteCommandResult>;
  withLock(args: readonly string[], cleanup: () => Promise<void>): Promise<WorkspaceQuarantineResult>;
}

export interface RemoteWorkspaceRetentionPaths {
  readonly profileRoot: string;
  readonly setupStateRoot: string;
  readonly mirror: string;
  readonly privateRefPrefix: string;
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function planWorkspaceRetention(
  entries: readonly WorkspaceActivity[],
  currentIdentity: string,
  policy: WorkspaceRetentionPolicy,
  nowMs: number,
): WorkspaceRetentionPlan {
  if (!IDENTITY.test(currentIdentity)) throw new Error("current identity is invalid");
  requireSafeInteger(nowMs, "now");
  if (!Number.isSafeInteger(policy.keep) || policy.keep < 1 || policy.keep > 64) {
    throw new Error("retention keep is invalid");
  }
  if (!Number.isSafeInteger(policy.graceMinutes) || policy.graceMinutes < 1 || policy.graceMinutes > 10_080) {
    throw new Error("retention graceMinutes is invalid");
  }

  const activityByIdentity = new Map<string, number>();
  for (const entry of entries) {
    if (!IDENTITY.test(entry.identity)) continue;
    requireSafeInteger(entry.activityMs, "activity");
    const previous = activityByIdentity.get(entry.identity);
    if (previous === undefined || entry.activityMs > previous) {
      activityByIdentity.set(entry.identity, entry.activityMs);
    }
  }

  activityByIdentity.delete(currentIdentity);
  const ordered = [...activityByIdentity].sort(
    ([leftIdentity, leftActivity], [rightIdentity, rightActivity]) =>
      rightActivity - leftActivity || leftIdentity.localeCompare(rightIdentity),
  );

  const retained = [currentIdentity, ...ordered.slice(0, policy.keep - 1).map(([identity]) => identity)];
  const graceCutoffMs = nowMs - policy.graceMinutes * MINUTES_TO_MS;
  const graceProtected: string[] = [];
  const candidates: string[] = [];

  for (const [identity, activityMs] of ordered.slice(policy.keep - 1)) {
    (activityMs >= graceCutoffMs ? graceProtected : candidates).push(identity);
  }

  return { retained, graceProtected, candidates };
}

const NONCE = /^[0-9a-f]{16}$/u;
const QUARANTINE = /^\.gc-([0-9a-f]{24})-([0-9a-f]{16})$/u;
const PRIVATE_REF_PREFIX = /^refs\/remote-runner\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/u;
const CAPTURE_BYTES = 64 * 1024;

function canonicalRoot(value: string, label: string): void {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || value === "/") {
    throw new Error(`${label} must be a canonical non-root absolute path`);
  }
}

function checked(result: RemoteCommandResult, label: string): RemoteCommandResult {
  if (result.stdout.byteLength > CAPTURE_BYTES || result.stderr.byteLength > CAPTURE_BYTES) {
    throw new Error(`${label} exceeded the output limit`);
  }
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
  return result;
}

function decodeRecords(contents: Uint8Array): string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error("workspace retention listing returned invalid UTF-8");
  }
  if (!decoded.endsWith("\0")) throw new Error("workspace retention listing was not NUL terminated");
  const records = decoded.slice(0, -1).split("\0");
  if (records.length % 3 !== 1) throw new Error("workspace retention listing returned partial records");
  return records;
}

function parseSeconds(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("workspace retention listing returned an invalid timestamp");
  }
  const milliseconds = Number(value) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("workspace retention timestamp is unsafe");
  return milliseconds;
}

export class RemoteWorkspaceRetentionRuntime implements WorkspaceRetentionRuntime {
  private readonly activityRoot: string;
  private readonly lockRoot: string;

  constructor(
    private readonly commands: WorkspaceRetentionCommandPort,
    private readonly paths: RemoteWorkspaceRetentionPaths,
    private readonly terminateSync: (identity: string) => Promise<void>,
  ) {
    canonicalRoot(paths.profileRoot, "workspace profile root");
    canonicalRoot(paths.setupStateRoot, "setup state root");
    canonicalRoot(paths.mirror, "workspace mirror");
    if (!PRIVATE_REF_PREFIX.test(paths.privateRefPrefix)) throw new Error("workspace private ref prefix is invalid");
    this.activityRoot = posix.join(paths.profileRoot, ".activity");
    this.lockRoot = posix.join(paths.profileRoot, ".locks");
  }

  async list(): Promise<WorkspaceRetentionListing> {
    const result = checked(
      await this.commands.run([
        "sh",
        "-ceu",
        'umask 077; root=$1; activity=$2; mkdir -p -- "$root" "$activity" "$root/.locks"; printf "%s\\0" "$(date +%s)"; find "$root" -mindepth 1 -maxdepth 1 ! -name .activity ! -name .locks -exec sh -ceu \'activity=$1; shift; for path do name=${path##*/}; kind=u; mtime=0; if [ -d "$path" ] && [ ! -L "$path" ] && printf "%s\\n" "$name" | grep -Eq "^[0-9a-f]{24}$"; then kind=d; marker="$activity/$name"; if [ -f "$marker" ] && [ ! -L "$marker" ]; then mtime=$(stat -c %Y -- "$marker"); else mtime=$(stat -c %Y -- "$path"); fi; elif [ -d "$path" ] && [ ! -L "$path" ] && printf "%s\\n" "$name" | grep -Eq "^\\.gc-[0-9a-f]{24}-[0-9a-f]{16}$"; then kind=q; fi; printf "%s\\0%s\\0%s\\0" "$kind" "$name" "$mtime"; done\' remote-runner-retention-entry "$activity" {} +',
        "remote-runner-retention-list",
        this.paths.profileRoot,
        this.activityRoot,
      ]),
      "workspace retention listing",
    );
    const records = decodeRecords(result.stdout);
    const nowMs = parseSeconds(records[0]!);
    const entries: WorkspaceRetentionEntry[] = [];
    for (let index = 1; index < records.length; index += 3) {
      const kind = records[index]!;
      const name = records[index + 1]!;
      const activityMs = parseSeconds(records[index + 2]!);
      if (kind === "d" && IDENTITY.test(name)) {
        entries.push({ kind: "directory", identity: name, activityMs });
        continue;
      }
      const quarantine = kind === "q" ? QUARANTINE.exec(name) : null;
      if (quarantine) {
        entries.push({ kind: "quarantine", identity: quarantine[1]!, quarantineName: name, activityMs });
        continue;
      }
      entries.push({ kind: "unsafe", identity: name, activityMs });
    }
    return { nowMs, entries };
  }

  async withQuarantine(
    identity: string,
    quarantineName: string,
    existing: boolean,
    graceCutoffMs: number,
    cleanup: () => Promise<void>,
  ): Promise<WorkspaceQuarantineResult> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    requireSafeInteger(graceCutoffMs, "workspace retention grace cutoff");
    const match = QUARANTINE.exec(quarantineName);
    if (!match || match[1] !== identity) throw new Error("workspace quarantine name is invalid");
    const lock = posix.join(this.lockRoot, identity);
    const workspace = posix.join(this.paths.profileRoot, identity);
    const quarantine = posix.join(this.paths.profileRoot, quarantineName);
    const activity = posix.join(this.activityRoot, identity);
    return this.commands.withLock(
      [
        "sh",
        "-ceu",
        'umask 077; existing=$1; lock=$2; workspace=$3; quarantine=$4; activity=$5; cutoff=$6; mkdir -p -- "$(dirname -- "$lock")"; exec 9>"$lock"; flock -n 9 || exit 75; if [ "$existing" != 1 ] && [ -f "$activity" ] && [ ! -L "$activity" ] && [ "$(stat -c %Y -- "$activity")" -ge "$cutoff" ]; then exit 78; fi; if [ "$existing" = 1 ]; then [ -d "$quarantine" ] || exit 76; [ ! -L "$quarantine" ] || exit 77; else [ -d "$workspace" ] || exit 76; [ ! -L "$workspace" ] || exit 77; [ ! -e "$quarantine" ] || exit 77; mv -- "$workspace" "$quarantine"; fi; printf "\\0REMOTE_RUNNER_RETENTION_LOCKED\\0" >&2; IFS= read -r release; [ "$release" = release ]',
        "remote-runner-retention-lock",
        existing ? "1" : "0",
        lock,
        workspace,
        quarantine,
        activity,
        String(Math.floor(graceCutoffMs / 1000)),
      ],
      cleanup,
    );
  }

  async terminateOwnedSync(identity: string): Promise<void> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    await this.terminateSync(identity);
  }

  async isIdentityDead(identity: string, graceCutoffMs: number): Promise<boolean> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    requireSafeInteger(graceCutoffMs, "workspace retention grace cutoff");
    /* `-L` beside every `-e`: `-e` follows the link, so a dangling symlink at either path reads as
       absent and would answer "dead" — the one answer that authorises deleting live state. Anything
       that is not a plain missing path, or not a regular marker file, has to read as alive. */
    const result = await this.commands.run([
      "sh",
      "-ceu",
      'workspace=$1; activity=$2; cutoff=$3; { [ ! -e "$workspace" ] && [ ! -L "$workspace" ]; } || exit 1; if [ -e "$activity" ] || [ -L "$activity" ]; then { [ -f "$activity" ] && [ ! -L "$activity" ]; } || exit 1; [ "$(stat -c %Y -- "$activity")" -lt "$cutoff" ] || exit 1; fi',
      "remote-runner-retention-liveness",
      posix.join(this.paths.profileRoot, identity),
      posix.join(this.activityRoot, identity),
      String(Math.floor(graceCutoffMs / 1000)),
    ]);
    return result.exitCode === 0;
  }

  async removeQuarantine(quarantineName: string): Promise<void> {
    if (!QUARANTINE.test(quarantineName)) throw new Error("workspace quarantine name is invalid");
    checked(
      await this.commands.run(["rm", "-rf", "--", posix.join(this.paths.profileRoot, quarantineName)]),
      "workspace quarantine removal",
    );
  }

  async removeActivity(identity: string): Promise<void> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    checked(
      await this.commands.run(["rm", "-f", "--", posix.join(this.activityRoot, identity)]),
      "workspace activity removal",
    );
  }

  async removeSetupState(identity: string): Promise<void> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    checked(
      await this.commands.run(["rm", "-rf", "--", posix.join(this.paths.setupStateRoot, identity)]),
      "workspace setup state removal",
    );
  }

  async removePrivateRef(identity: string): Promise<void> {
    if (!IDENTITY.test(identity)) throw new Error("workspace retention identity is invalid");
    checked(
      await this.commands.run([
        "sh",
        "-ceu",
        /* A mirror the consumer never created is not a failure to clean up; update-ref -d already
           exits 0 on a ref that is gone, so only a missing git dir needs the guard. */
        /* `core.hooksPath=/dev/null` mirrors the push path: `update-ref` runs the mirror's
           reference-transaction hook, and no repository hook may execute inside a runner transaction. */
        'test -d "$1" || exit 0; exec git -c core.hooksPath=/dev/null --git-dir="$1" update-ref -d "$2"',
        "remote-runner-private-ref",
        this.paths.mirror,
        `${this.paths.privateRefPrefix}/${identity}`,
      ]),
      "workspace private ref removal",
    );
  }
}

export async function pruneRemoteWorkspaces(
  runtime: WorkspaceRetentionRuntime,
  currentIdentity: string,
  policy: WorkspaceRetentionPolicy,
  createNonce: () => string,
): Promise<WorkspaceRetentionSummary> {
  const { nowMs, entries } = await runtime.list();
  const directories = entries.filter(
    (entry): entry is WorkspaceActivity & { readonly kind: "directory" } =>
      entry.kind === "directory" && IDENTITY.test(entry.identity),
  );
  const plan = planWorkspaceRetention(directories, currentIdentity, policy, nowMs);
  const graceCutoffMs = nowMs - policy.graceMinutes * MINUTES_TO_MS;
  let locked = 0;
  let refreshed = 0;
  let removed = 0;
  let failed = 0;
  let ignored = entries.filter((entry) => entry.kind === "unsafe" || !IDENTITY.test(entry.identity)).length;

  const cleanup = async (identity: string, quarantineName: string, existing: boolean): Promise<void> => {
    try {
      const result = await runtime.withQuarantine(identity, quarantineName, existing, graceCutoffMs, async () => {
        /* A resumed quarantine is already detached, so it is garbage whatever the identity is doing
           now — but the identity-scoped resources below belong to the LIVE workspace, and an
           identity that has come back to life since the `mv` still needs them. */
        const scoped = !existing || (await runtime.isIdentityDead(identity, graceCutoffMs));
        if (scoped) {
          await runtime.terminateOwnedSync(identity);
          /* Before the quarantine goes: a failed ref deletion then leaves the quarantine directory
             for the next pass to resume, instead of orphaning the ref with nothing left to retry. */
          await runtime.removePrivateRef(identity);
        }
        await runtime.removeQuarantine(quarantineName);
        if (scoped) {
          await runtime.removeActivity(identity);
          await runtime.removeSetupState(identity);
        }
      });
      if (result === "removed") removed += 1;
      else if (result === "locked") locked += 1;
      else if (result === "refreshed") refreshed += 1;
      else if (result === "unsafe") ignored += 1;
    } catch {
      failed += 1;
    }
  };

  const seenQuarantines = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "quarantine" || !IDENTITY.test(entry.identity)) continue;
    const expectedPrefix = `.gc-${entry.identity}-`;
    const nonce = entry.quarantineName.startsWith(expectedPrefix)
      ? entry.quarantineName.slice(expectedPrefix.length)
      : "";
    if (!NONCE.test(nonce) || seenQuarantines.has(entry.quarantineName)) {
      ignored += 1;
      continue;
    }
    seenQuarantines.add(entry.quarantineName);
    await cleanup(entry.identity, entry.quarantineName, true);
  }

  for (const identity of plan.candidates) {
    const nonce = createNonce();
    if (!NONCE.test(nonce)) throw new Error("workspace retention nonce is invalid");
    await cleanup(identity, `.gc-${identity}-${nonce}`, false);
  }

  return {
    retained: plan.retained.length,
    graceProtected: plan.graceProtected.length + refreshed,
    locked,
    removed,
    failed,
    ignored,
  };
}
