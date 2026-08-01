import type { WorkspaceRetentionPolicy } from "../config/types.js";

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
