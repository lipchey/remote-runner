# Local Fallback Child Environment Implementation Plan

**Status:** done.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply manifest `workload.childEnvironment` to automatic and explicit local workloads.

**Architecture:** Keep mode selection unchanged. At the concrete local process boundary, pass the
validated manifest environment into `runStreamingProcess`, whose existing merge semantics preserve
unrelated parent variables and let manifest values override matching keys.

**Tech Stack:** TypeScript, Node.js child processes, Vitest, pnpm.

---

### Task 1: Characterize the local child environment

**Files:**

- Modify: `tests/unit/app/pilot-services.test.ts`
- Modify: `src/app/pilot-services.ts`

- [x] **Step 1: Write the failing real-child test**

Instantiate `NodeProfileServices` with a profile whose `workload.childEnvironment` contains a unique
`LOCAL_FALLBACK_CANARY=manifest` entry. Run `process.execPath -e` through `runLocal()` and assert the
captured child stdout equals `manifest`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `rtk pnpm exec vitest run tests/unit/app/pilot-services.test.ts`

Expected: FAIL because the local child prints `missing`.

- [x] **Step 3: Implement the minimal environment handoff**

Add the existing manifest map to the local `runStreamingProcess` request:

```ts
environment: this.profile.workload.childEnvironment,
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `rtk pnpm exec vitest run tests/unit/app/pilot-services.test.ts`

Expected: PASS.

### Task 2: Verify and publish

**Files:**

- Modify: `docs/superpowers/specs/2026-08-01-local-fallback-child-environment-design.md`
- Modify: `docs/superpowers/plans/2026-08-01-local-fallback-child-environment.md`

- [x] **Step 1: Run repository acceptance**

Run:

```bash
rtk pnpm test
rtk pnpm run typecheck
rtk pnpm run format:check
rtk pnpm run build
```

Expected: all commands pass.

- [x] **Step 2: Reinstall and run the consumer acceptance**

Install the fixed CLI from this worktree, then in Ariadne run:

```bash
REMOTE_RUNNER_MODE=local ./scripts/verify --full
```

Expected: the complete full tier passes without explicit `PNPM_CONFIG_*` exports.

- [x] **Step 3: Publish**

Mark both documents done with acceptance evidence, commit under the configured Git identity, push
`codex/local-fallback-child-env`, and open a ready-for-review PR against `main`.

**Acceptance evidence:** The focused real-child regression is green; the complete remote-runner
suite passed 415/415 tests with typecheck, formatting, and build; the fixed CLI was installed; and
Ariadne's full tier passed with `REMOTE_RUNNER_MODE=local` and no manually exported manifest child
environment.
