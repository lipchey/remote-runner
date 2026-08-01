# Remote Workspace Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable remote workspace placement and bounded, concurrency-safe retention so Ariadne can use DataAI without stale workspaces filling a filesystem.

**Architecture:** Preserve the legacy generated-root literal while accepting a canonical absolute path and an optional closed retention policy. Resolve and probe that target filesystem, then use a pure retention planner plus confined remote quarantine operations, workload `flock`, and exact Mutagen-session termination to retain three identities with a 60-minute grace window without changing workload exit semantics.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest, YAML, SSH fixed-argv scripts, Mutagen, POSIX `flock`, pnpm.

---

### Task 1: Extend the closed manifest contract

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/load-manifest.ts`
- Modify: `tests/unit/config/manifest-fixture.ts`
- Modify: `tests/unit/config/load-manifest.test.ts`

- [x] **Step 1: Write failing manifest tests**

Add cases that accept `/mnt/DataAI/home/admin/.cache/remote-runner/workspaces` and:

```ts
workspace: {
  generatedRoot: "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces",
  retention: { keep: 3, graceMinutes: 60 },
}
```

Also add table cases rejecting relative paths, `/`, non-normalized absolute paths, unknown tilde forms, control characters, `keep` outside `1..64`, `graceMinutes` outside `1..10_080`, and unknown retention fields. Keep a test proving the legacy literal and omitted retention remain valid.

- [x] **Step 2: Run the focused tests and require red**

Run: `pnpm vitest run tests/unit/config/load-manifest.test.ts`

Expected: FAIL because absolute roots and `workspace.retention` are rejected.

- [x] **Step 3: Implement the minimal schema**

Define:

```ts
export interface WorkspaceRetentionPolicy {
  keep: number;
  graceMinutes: number;
}

workspace: {
  generatedRoot: string;
  baseRef?: string;
  retention?: WorkspaceRetentionPolicy;
};
```

Add a validator that accepts only the exact legacy literal or a normalized non-root absolute POSIX path without control characters. Parse the optional closed retention object with the specified integer bounds and return a fresh object.

- [x] **Step 4: Run focused green tests**

Run: `pnpm vitest run tests/unit/config/load-manifest.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the manifest contract**

```bash
git add src/config/types.ts src/config/load-manifest.ts tests/unit/config/manifest-fixture.ts tests/unit/config/load-manifest.test.ts
git commit -m "feat: configure remote workspace retention"
```

### Task 2: Resolve and probe the selected filesystem

**Files:**

- Modify: `src/app/pilot-services.ts`
- Modify: `tests/unit/app/pilot-services.test.ts`
- Modify: `tests/unit/app/default-dependencies.test.ts`

- [x] **Step 1: Write failing path and probe tests**

Cover both roots:

```ts
expect(resolveRemotePaths("/home/admin", legacyProfile, identity).generatedRoot).toBe(
  "/home/admin/.cache/remote-runner/workspaces",
);
expect(resolveRemotePaths("/home/admin", dataAiProfile, identity).generatedRoot).toBe(
  "/mnt/DataAI/home/admin/.cache/remote-runner/workspaces",
);
```

Add a service test requiring the capacity SSH request to run `df -Pk` against the resolved generated root, not `$HOME`, and to reject a generated root whose `realpath` differs from the requested canonical path.

- [x] **Step 2: Run focused tests and require red**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/app/default-dependencies.test.ts`

Expected: FAIL because the resolver hardcodes remote home and the probe checks `$HOME`.

- [x] **Step 3: Split home discovery from capacity validation**

Change `resolveRemotePaths` to accept `Pick<Profile, "consumer" | "id" | "workspace">`. Resolve the exact legacy literal below `remoteHome`; preserve an absolute root unchanged. In `probe()`, first discover the canonical remote home, derive paths, then execute a fixed-argv shell that:

```sh
umask 077
mkdir -p -- "$1"
resolved=$(realpath -- "$1")
[ "$resolved" = "$1" ]
blocks=$(df -Pk -- "$resolved" | awk 'NR==2 {print $4}')
printf '%s\n' "$((blocks * 1024))"
```

Parse one bounded byte-count record and apply `minimumFreeBytes` before sync or bootstrap.

- [x] **Step 4: Run focused green tests**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/app/default-dependencies.test.ts`

Expected: PASS.

- [x] **Step 5: Commit target-filesystem probing**

```bash
git add src/app/pilot-services.ts tests/unit/app/pilot-services.test.ts tests/unit/app/default-dependencies.test.ts
git commit -m "feat: probe configured workspace filesystem"
```

### Task 3: Add a deterministic retention planner

**Files:**

- Create: `src/workspace/retention.ts`
- Create: `tests/unit/workspace/retention.test.ts`

- [x] **Step 1: Write failing planner tests**

Define fixtures for the current identity, four stale identities, one 30-minute-old identity, one missing-marker legacy identity, hostile names, and equal timestamps. Assert `keep: 3` retains the current identity plus two newest valid identities, grace protects the recent identity, ties sort by identity, and only exact 24-character lowercase hexadecimal directory names enter the plan. Activity timestamps come from `<profileRoot>/.activity/<identity>`; only legacy identities without a marker fall back to directory mtime.

- [x] **Step 2: Run the new test and require red**

Run: `pnpm vitest run tests/unit/workspace/retention.test.ts`

Expected: FAIL because `src/workspace/retention.ts` does not exist.

- [x] **Step 3: Implement the pure planner**

Create explicit data contracts:

```ts
export interface WorkspaceActivity {
  readonly identity: string;
  readonly activityMs: number;
}

export interface WorkspaceRetentionPlan {
  readonly retained: readonly string[];
  readonly graceProtected: readonly string[];
  readonly candidates: readonly string[];
}

export function planWorkspaceRetention(
  entries: readonly WorkspaceActivity[],
  currentIdentity: string,
  policy: WorkspaceRetentionPolicy,
  nowMs: number,
): WorkspaceRetentionPlan;
```

Validate safe integers and identities, sort by descending activity then identity, reserve the current identity first, fill retained slots up to `keep`, and partition older remainder by `graceMinutes * 60_000`.

- [x] **Step 4: Run planner green tests**

Run: `pnpm vitest run tests/unit/workspace/retention.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the planner**

```bash
git add src/workspace/retention.ts tests/unit/workspace/retention.test.ts
git commit -m "feat: plan bounded workspace retention"
```

### Task 4: Quarantine stale identities and terminate owned sync sessions

**Files:**

- Modify: `src/workspace/retention.ts`
- Modify: `src/sync/mutagen.ts`
- Modify: `src/app/pilot-services.ts`
- Modify: `tests/unit/workspace/retention.test.ts`
- Modify: `tests/unit/sync/mutagen.test.ts`
- Modify: `tests/unit/app/pilot-services.test.ts`

- [x] **Step 1: Write failing runtime tests**

Use fake ports to require this order for an eligible identity:

```text
list -> quarantine-under-nonblocking-lock -> terminate-owned-mutagen -> remove-quarantine -> remove-activity -> remove-setup-state -> remove-lock
```

Require locked identities to be counted as skipped, symlink/special entries to be reported and ignored, `.gc-<identity>-<nonce>` remnants to resume cleanup, and one candidate failure not to widen targets or prevent bounded processing of later candidates.

- [x] **Step 2: Run focused tests and require red**

Run: `pnpm vitest run tests/unit/workspace/retention.test.ts tests/unit/sync/mutagen.test.ts tests/unit/app/pilot-services.test.ts`

Expected: FAIL because quarantine and exact session termination ports are absent.

- [x] **Step 3: Add exact Mutagen termination**

Add an idempotent method that derives the existing owned name with `mutagenSessionName`, lists that exact owned session, validates its endpoints, and runs `mutagen sync terminate <name>` only when present. Absence is success; duplicate or mismatched ownership fails closed.

- [x] **Step 4: Add confined remote retention execution**

Implement a `WorkspaceRetentionRuntime` adapter with bounded fixed-argv SSH commands. Listing returns only identity, marker/directory activity, and entry kind. Quarantine validates the exact profile root and runs a remote shell equivalent to:

```sh
exec 9>"$lock"
flock -n 9 || exit 75
[ -d "$workspace" ] && [ ! -L "$workspace" ]
mv -- "$workspace" "$quarantine"
```

Use a locally generated nonce that matches a strict safe-label pattern. After quarantine, terminate the exact Mutagen session, remove only the exact quarantined directory, then remove confined activity, setup-state, and lock files. Return a bounded summary of retained, grace-protected, locked, removed, and failed counts.

- [x] **Step 5: Run focused green tests**

Run: `pnpm vitest run tests/unit/workspace/retention.test.ts tests/unit/sync/mutagen.test.ts tests/unit/app/pilot-services.test.ts`

Expected: PASS.

- [x] **Step 6: Commit quarantine cleanup**

```bash
git add src/workspace/retention.ts src/sync/mutagen.ts src/app/pilot-services.ts tests/unit/workspace/retention.test.ts tests/unit/sync/mutagen.test.ts tests/unit/app/pilot-services.test.ts
git commit -m "feat: prune inactive remote workspaces"
```

### Task 5: Hold workload locks and preserve authoritative exits

**Files:**

- Modify: `src/app/pilot-services.ts`
- Modify: `tests/unit/app/pilot-services.test.ts`
- Modify: `tests/unit/app/profile-runtime.test.ts`
- Modify: `tests/unit/secrets/remote-launcher.test.ts`

- [x] **Step 1: Write failing lifecycle tests**

Require `remoteChildArguments` to create the profile lock directory, acquire the current identity's lock with `flock -x`, and hold descriptor 9 through launcher exit. Require preparation to touch the external activity marker before sync work begins and a marker-seen completion to touch it again. Add profile-service tests proving cleanup runs after a marker-seen exit `0` and exit `23`, does not run when the child marker is absent, and cleanup failure writes one bounded warning while returning the original child exit.

- [x] **Step 2: Run focused tests and require red**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/app/profile-runtime.test.ts tests/unit/secrets/remote-launcher.test.ts`

Expected: FAIL because the workload lock and post-child cleanup are absent.

- [x] **Step 3: Add workload locking and activity touch**

Derive `<profileRoot>/.locks/<identity>.lock` and `<profileRoot>/.activity/<identity>` in `RemotePaths`. Extend fixed child argv with the lock path and use a shell that creates the lock directory, opens descriptor 9, acquires `flock -x 9`, then changes into the workspace and `exec`s the existing env/launcher argv. Touch the external activity marker when preparation starts and after a marker-seen workload completes; never put lifecycle metadata inside the Mutagen beta root.

- [x] **Step 4: Invoke cleanup without changing child authority**

After `runStreamingProcess` returns, call retention only when `spawned && markerSeen` and policy is configured. Catch cleanup errors, write a secret-free bounded warning to the configured stderr sink, and return `{ kind: "completed", exitCode: result.exitCode }` unchanged.

- [x] **Step 5: Run focused green tests**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/app/profile-runtime.test.ts tests/unit/secrets/remote-launcher.test.ts`

Expected: PASS.

- [x] **Step 6: Commit lifecycle integration**

```bash
git add src/app/pilot-services.ts tests/unit/app/pilot-services.test.ts tests/unit/app/profile-runtime.test.ts tests/unit/secrets/remote-launcher.test.ts
git commit -m "feat: protect active remote workspaces"
```

### Task 6: Document, verify, publish, and install upstream

**Files:**

- Modify: `README.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/superpowers/specs/2026-08-01-workspace-retention-design.md` only if implementation evidence reveals a genuine contract correction
- Modify: `docs/superpowers/plans/2026-08-01-workspace-retention.md` to check completed steps and record acceptance evidence

- [x] **Step 1: Update operator documentation**

Document the legacy/absolute root forms, retention fields, target-filesystem capacity behavior, steady-state versus grace-protected growth, cleanup warnings, and DataAI example. State that retention never follows symlinks and never overrides a workload exit.

- [x] **Step 2: Run focused and full verification**

Run:

```bash
pnpm vitest run tests/unit/config/load-manifest.test.ts tests/unit/app/pilot-services.test.ts tests/unit/workspace/retention.test.ts tests/unit/sync/mutagen.test.ts tests/unit/app/profile-runtime.test.ts tests/unit/secrets/remote-launcher.test.ts
pnpm verify
```

Expected: all tests, typecheck, formatting, and build pass with exit 0.

- [x] **Step 3: Record acceptance in the plan and commit docs**

Check every completed box in this plan and append the exact test counts and command exit codes. Run `pnpm verify` again only if that documentation edit participates in a repository-owned documentation gate; otherwise use the already completed hook-visible verdict.

```bash
git add README.md docs/RUNBOOK.md docs/superpowers/plans/2026-08-01-workspace-retention.md
git commit -m "docs: document workspace retention"
```

- [x] **Step 4: Push and open a ready-for-review PR**

Run:

```bash
git push -u origin codex/workspace-retention
gh pr create --base main --head codex/workspace-retention --title "feat: bound remote workspace retention" --body "Adds canonical absolute workspace roots, target-filesystem capacity probing, and concurrency-safe keep-3/grace-60 retention. Verification and live migration evidence are recorded in the committed plan."
gh pr view --web
```

Expected: a non-draft PR URL that contains the implementation, tests, design, completed plan, and acceptance evidence.

- [ ] **Step 5: Verify CI and install the accepted build**

Poll the PR checks with bounded `gh pr checks`/API snapshots. After the required branch state is accepted, run `pnpm build && node dist/src/main.js install` from the verified worktree and verify `remote-runner --help` plus the immutable app target recorded below `~/.local/share/remote-runner/app`.

- [ ] **Step 6: Create the dependent Ariadne migration plan**

In a dedicated Ariadne worktree, write `docs/superpowers/plans/2026-08-01-dataai-runner-migration.md` using the installed runner commit as a hard dependency. The plan must update `.remote-runner.yaml`, synchronize the prepared DataAI copy, run forced-remote hostname and light verify canaries, run mandatory `./scripts/verify --full`, prove pruning and filesystem placement, remove the old home copy only after acceptance, update every lifecycle-tracking document, commit, push, and open a separate ready-for-review PR.

## Acceptance evidence

- Focused retention/lifecycle verification passed with exit `0`: 7 test files, 166 tests.
- Full `pnpm verify` passed with exit `0`: formatting, TypeScript typecheck, 42 test files with 442 tests, and production build.
- Implementation branch: `codex/workspace-retention`; publication target: this ready-for-review PR.
- Next action: verify this PR's CI, install the immutable build from commit `1f6cc53` plus documentation commit `75c43f7`, then execute the dependent Ariadne DataAI migration in its own worktree and PR.
