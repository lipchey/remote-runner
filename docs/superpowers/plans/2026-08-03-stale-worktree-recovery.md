# Stale Remote Worktree Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote Git workspace reconciliation self-heal prunable registrations and make diagnostics accurately identify the configured workspace and stale-registration state.

**Architecture:** Keep recovery inside the existing locked remote Git transaction: prune Git-admin records, list live worktrees, then reuse or recreate the confined candidate. Extend read-only diagnostics with manifest-aware workspace paths and a dedicated stale-registration probe; ordinary `run` remains the only mutating recovery path.

**Tech Stack:** TypeScript, POSIX shell transactions over SSH, Git worktrees, Vitest.

---

### Task 1: Recover prunable worktree registrations

**Files:**

- Modify: `tests/unit/workspace/git-workspace.test.ts`
- Modify: `src/workspace/git-workspace.ts`

- [ ] **Step 1: Write the failing regression and ordering assertions**

Add a real Git test that initializes a bare mirror and source repository, registers a detached candidate, removes only the candidate directory, confirms `worktree list --porcelain` reports it as `prunable`, executes the production reconciliation transaction, and asserts the candidate exists at the requested OID. Extend the transaction-order test with:

```ts
expect(transaction).toContain("git --git-dir=. worktree prune --expire=now");
expect(transaction!.indexOf("flock -x")).toBeLessThan(transaction!.indexOf("worktree prune"));
expect(transaction!.indexOf("worktree prune")).toBeLessThan(transaction!.indexOf("worktree list"));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/unit/workspace/git-workspace.test.ts`

Expected: FAIL because the stale registration survives and the transaction changes into a missing candidate; the ordering assertion also cannot find `worktree prune`.

- [ ] **Step 3: Add the minimal locked prune**

Immediately before `worktree_listing=...` in `RECONCILE_TRANSACTION`, add:

```sh
git --git-dir=. worktree prune --expire=now
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/unit/workspace/git-workspace.test.ts`

Expected: the stale candidate is recreated, valid reuse remains green, and the file passes.

- [ ] **Step 5: Commit the recovery slice**

```bash
git add src/workspace/git-workspace.ts tests/unit/workspace/git-workspace.test.ts
git commit -m "fix: recover prunable remote worktrees"
```

### Task 2: Resolve diagnostic paths from the manifest

**Files:**

- Modify: `tests/unit/app/default-dependencies.test.ts`
- Modify: `src/app/default-dependencies.ts`

- [ ] **Step 1: Write failing legacy and absolute-root tests**

Cover `statusProfile` and doctor probes with profiles using both the legacy literal and
`/mnt/DataAI/home/admin/.cache/remote-runner/workspaces`. Assert SSH arguments contain the exact
absolute workspace/mirror paths for DataAI and preserve `$HOME` resolution only for the legacy
form.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/unit/app/default-dependencies.test.ts`

Expected: FAIL because current diagnostics always build `.cache/remote-runner/workspaces/...` below
the remote home.

- [ ] **Step 3: Add a manifest-aware diagnostic path resolver**

Derive `generatedRoot`, `profileRoot`, `workspace`, and `mirror` from
`profile.workspace.generatedRoot`. Represent the legacy form as remote-home-relative and absolute
forms as canonical fixed arguments. Remote shell snippets must select either `$HOME/$relative` or
the absolute value without evaluating shell text from the manifest.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/unit/app/default-dependencies.test.ts`

Expected: legacy and DataAI paths both pass with bounded fixed argv.

- [ ] **Step 5: Commit diagnostic path correctness**

```bash
git add src/app/default-dependencies.ts tests/unit/app/default-dependencies.test.ts
git commit -m "fix: honor generated root in diagnostics"
```

### Task 3: Report stale worktree registrations explicitly

**Files:**

- Modify: `tests/unit/diagnostics/doctor.test.ts`
- Modify: `tests/unit/app/default-dependencies.test.ts`
- Modify: `src/diagnostics/doctor.ts`
- Modify: `src/app/default-dependencies.ts`
- Modify: `docs/RUNBOOK.md`

- [ ] **Step 1: Write failing doctor probe tests**

Require a read-only probe with id `remote.workspace-registration`, reason
`workspace-registration`, and a fixed command. In the runtime test, cover: existing workspace → ok;
missing mirror → ok; missing candidate without registration → ok; missing candidate with an exact
`worktree <candidate>` porcelain record → fail. Assert no raw path/output enters the JSON report.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/unit/diagnostics/doctor.test.ts tests/unit/app/default-dependencies.test.ts`

Expected: FAIL because the probe and inspector branch do not exist.

- [ ] **Step 3: Implement the read-only stale-registration probe**

Add the new stable probe. Its remote shell must return success for an existing candidate or absent
mirror and otherwise capture `git --git-dir="$mirror" worktree list --porcelain` before exact-line
matching. It returns failure only for the exact stale candidate registration and never prints the
listing.

- [ ] **Step 4: Document diagnosis and automatic recovery**

Update `docs/RUNBOOK.md` to explain `workspace-registration`, that ordinary `run` prunes the stale
record under the consumer lock, and that manual prune is reserved for diagnosing an older installed
runner.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/unit/diagnostics/doctor.test.ts tests/unit/app/default-dependencies.test.ts tests/unit/workspace/git-workspace.test.ts tests/unit/runbook.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Commit diagnostics**

```bash
git add src/diagnostics/doctor.ts src/app/default-dependencies.ts tests/unit/diagnostics/doctor.test.ts tests/unit/app/default-dependencies.test.ts docs/RUNBOOK.md
git commit -m "feat: diagnose stale worktree registrations"
```

### Task 4: Verify and publish

**Files:**

- Modify: `docs/superpowers/plans/2026-08-03-stale-worktree-recovery.md`

- [ ] **Step 1: Run complete verification**

Run: `pnpm verify`

Expected: format check, typecheck, all Vitest tests, and build pass.

- [ ] **Step 2: Record acceptance evidence in this plan**

Check completed steps and append exact focused/full test counts and the final commit SHA.

- [ ] **Step 3: Commit lifecycle evidence**

```bash
git add docs/superpowers/plans/2026-08-03-stale-worktree-recovery.md
git commit -m "docs: record stale recovery acceptance"
```

- [ ] **Step 4: Obtain independent review**

Review the full diff from `origin/main` to `HEAD`; resolve every Critical or Important finding and
rerun affected tests plus `pnpm verify` after any code change.

- [ ] **Step 5: Push and open a ready pull request**

```bash
git push -u origin codex/prune-stale-registration
gh pr create --base main --head codex/prune-stale-registration --title "fix: self-heal stale remote worktrees" --body-file <prepared-body>
```

Verify the returned PR URL and leave the worktree available for review follow-ups.
