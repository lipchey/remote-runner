# Run Queue and Prewarm Fairness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #22 — make a second run of the same workspace wait visibly
instead of dying at 120 s with an infrastructure exit code, serve the prewarm queue
in arrival order instead of by identity hash, report queue position and wait age in
`status`, and cap concurrent workloads per host.

**Architecture:** No new coordination service and no new state store. The three
existing primitives each get the missing property: the remote workload `flock`
gets a real wait budget plus a local progress notice, the prewarm queue gets its
arrival order from the request file's mtime (which the publish `link()` already
records), and the host cap becomes N slot files under the shared remote
`generatedRoot`, held by the same shell that holds the workload lock. Ordering
within the run path stays a scramble, not a FIFO; only the prewarm queue gets an
order guarantee, because only there is unfairness stable.

**Tech Stack:** TypeScript, POSIX shell over SSH, `flock`, Vitest.

---

## Premises (verified 2026-08-18, re-verify before trusting)

Issue #22 and its two comments carry three premises that the code and the
consumer corpus contradict. The plan is built on the corrected ones.

| Premise in the issue                         | What the source says                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runs time out on a 120 s lock wait           | the local profile lock budget is **15 min** (`LOCK_WAIT_MS`, `src/app/pilot-services.ts:260`). `120_000` is `leaseDurationMs` (`src/app/pilot-services.ts:622`), and the lease is **not enforced** — `src/runtime/lock.ts:382-389` reclaims on pid liveness only                                                                                                     |
| the 75s are host over-subscription           | 36 of 36 corpus runs in the 119–123 s cluster started while **another run of the same identity** was in flight; only 12 of 36 had any cross-identity run in flight                                                                                                                                                                                                   |
| `.locks/<consumer>.lock` guards provisioning | three distinct locks exist: local profile lock keyed by identity (`pilot-services.ts:449-450,620`), remote git lock per consumer (`src/workspace/git-workspace.ts:296`), remote workload lock per identity (`pilot-services.ts:104`). The ssh workload runs **outside** the local lock — it is released at the child-start marker (`src/run/run-profile.ts:118-129`) |

**The 120 s mechanism, confirmed end to end.** `pauseSync()` calls
`touchActivity()` first (`src/app/pilot-services.ts:715-717`), which runs
`flock -w 60 9 || exit 75` on the _workload_ lock (`pilot-services.ts:706`). The
workload lock is held for the whole run by the remote child
(`flock -x 9`, unbounded, `pilot-services.ts:172-173`), so a second run of the
same worktree waits 60 s, gets exit 75, and raises
`PreparationError("lock", true)` (`pilot-services.ts:711`). `retryable: true`
means `runProfile` tries again (`MAX_PREPARATION_ATTEMPTS = 2`,
`src/run/run-profile.ts:28,101`), the retry waits another 60 s, and the run
fails closed with exit 75 (`run-profile.ts:110-111`).

Corpus (363 `runner.log` files, 1691 `run-finish`, consumer `ariadne`, profile
`verify-full`): 125 records with `status: 75`; of the 70 that carry
`durationMs`, 37 sit in 120–130 s and every one of them carries
`reason: "lock"`. Of the 13 that also carry phase spans, `lock` costs 1–5 ms
while `sync-pause` costs 120303–120434 ms with `ssh.maxMs ≈ 60.2 s` — the two
stacked 60 s `flock -w 60` calls, attributed to the `sync-pause` span because
`touchActivity` has no span of its own.

The bounded wait is deliberate, not an oversight — `pilot-services.ts:700-702`
records why: an unbounded flock there "hangs the second run silently and without
end". Issue #22's queue is exactly the missing piece that lets it wait instead,
which is why Task 1 supplies the wait budget and the visibility together.

## Owner decisions taken into this plan (2026-08-18)

1. **Scope** — all three asks, sequenced by evidence: same-identity wait first,
   prewarm arrival + visibility second, host semaphore last.
2. **Arrival timestamp** — the request file's **mtime**, not a new
   `PrewarmRequest` field. Publish writes the generation file and `link()`s it
   (`src/prewarm/queue.ts:125-130`), so mtime is the enqueue instant; claim is a
   `rename` (`:176-183`), which preserves it; `inspectPrewarmRequest` already
   `lstat`s (`:91-99`). Zero schema change, zero migration, and requests already
   on disk get an order. Known ceiling: a tool that rewrites mtimes (rsync,
   restore-from-backup) reorders the queue.
3. **ETA** — position, depth and wait age only. No duration model, no ETA.

## Review gates cleared (2026-08-18)

Both cross-model gates ran against the first draft; every finding below was
verified against the repo before being accepted, and the plan text above already
carries the accepted ones.

**Rejected, with the reason:**

- _"`link()` does not make mtime the enqueue instant — the premise is false."_
  It does: `writeFile` stamps the generation inode and `link()` changes ctime and
  link count, not mtime, which is what the plan claims. The finding's usable
  core — the write→link window and equal-timestamp ties — is accepted and
  written into Task 2 as a downgrade of the guarantee to best-effort.
- _"Keep `remote.concurrency` as an optional lowering bound."_ A second knob that
  can only ever agree with the first. Add it when a consumer actually wants to
  be more conservative than its host.
- _"Older releases reject a manifest carrying the new closed key, so document a
  downgrade path."_ Moot — the manifest key was removed when the cap moved
  host-side.

### Task 1: Make same-identity contention a visible wait, not a 120 s failure

**Files:**

- Modify: `tests/unit/app/pilot-services.test.ts` (or the file that covers
  `touchActivity` — locate it first; `tests/unit/run/prepare.test.ts` and
  `tests/unit/run/run-profile.test.ts` cover the retry arithmetic)
- Modify: `src/app/pilot-services.ts`
- Modify: `src/runtime/telemetry.ts`

- [ ] **Step 1: Write the failing tests**

  Three assertions, each failing for a different reason today:

  1. `touchActivity` emits `flock -w <budget>` with the budget derived from
     `LOCK_WAIT_MS` (`pilot-services.ts:260`), not the literal `60`. Assert on
     the remote argv string.
  2. A workload-busy exit raises a **non-retryable** preparation failure:
     `expect(result).toEqual({ ok: false, reason: "lock", retryable: false })`
     from `prepareRemote`, and `runProfile` performs **one** preparation
     attempt, not two. The existing retry test in
     `tests/unit/run/run-profile.test.ts` is the model for counting attempts.
  3. When the marker call has not returned after the notice delay, stderr
     carries a one-line notice. Mirror the existing local-lock notice test for
     `LOCK_WAIT_NOTICE_MS` (`pilot-services.ts:261,608-610`).

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/run/run-profile.test.ts`

  Expected: the argv still contains `flock -w 60`, `retryable` is still `true`,
  and no notice is written.

- [ ] **Step 3: Widen the budget and stop the doubling**

  In `touchActivity` (`src/app/pilot-services.ts:697-713`):

  - widen the flock budget, but **not** to `LOCK_WAIT_MS` itself. `prepareRemote`
    takes the local profile lock at step `lock` (`src/run/prepare.ts:116`) and
    only reaches `pauseSync` at step `sync-pause` (`:120`), so this wait is spent
    **while holding the local lock** for the same identity. Reusing the local
    lock's own 15-minute constant therefore stacks: a third run of the worktree
    waits up to 15 min on the local lock and then up to 15 min more here. Pick a
    remote budget that is a fraction of `LOCK_WAIT_MS` and state the worst-case
    total in a comment at the constant. A new constant is warranted here — the
    two numbers govern different queues and must not be tied. **Units:**
    `flock -w` takes **seconds** and `LOCK_WAIT_MS` is milliseconds; pin the
    conversion in a test, because substituting the constant directly yields a
    900000-second wait that no test would notice and no operator would survive;
  - **stop keying the busy case on exit 75.** `src/node/process.ts:64` synthesizes
    exit 75 whenever output is truncated and the real code was 0
    (`outputTruncated && observedExitCode === 0 ? 75 : observedExitCode`), so
    `pilot-services.ts:711` classifies a capture anomaly as lock contention.
    Today that is survivable because the error is retryable; the moment it
    becomes terminal, a truncated capture fails the run closed. Give the marker
    script its own exit code that the capture path cannot synthesize (75 and 0
    are the only ones it produces) and match on that.

    `pilot-services.ts:516` conflates the same two things (`exitCode === 75`
    → `"locked"`). Fix both sites in this step — one distinguishable signal for
    every remote script that reports "busy", not a second special case;

  - on the busy signal, throw
    `new PreparationError("lock", false)` — the full budget was already spent, so
    a second identical wait can only double the delay. This one word is what
    turns today's 2 × 60 s into a single bounded wait;
  - keep the reason string `lock`. It is already in `NOTIFICATION_REASONS` and
    already has a runbook row, so no new reason and no doc churn
    (`tests/unit/operations-guide.test.ts:31-33` enforces that pairing).

  Replace the comment at `pilot-services.ts:700-702` only if the widened budget
  changes what it warns about; the constraint it records (why the lock stays at
  all) still holds.

  Scope check before editing: `PreparationError("lock", true)` is raised at two
  sites — this one and the local `LockTimeoutError` path
  (`pilot-services.ts:632`). Only the first changes. Grep
  `WORKLOAD_LOCK_BUSY_EXIT_CODE` to confirm no third consumer exists.

- [ ] **Step 4: Add the wait notice**

  Start a timer before the marker ssh call and clear it after. If it fires,
  write one line to stderr naming the cause in the operator's terms — another
  run of this worktree, not a broken host. Reuse `LOCK_WAIT_NOTICE_MS`.

  ```
  remote-runner: another run of this workspace is still finishing; waiting for it
  ```

  This is ask (2) of the issue for the run path: without it, widening the budget
  converts a loud 120 s failure into a silent 15 min stall, which is worse.

- [ ] **Step 5: Give the wait its own telemetry span — by moving it, not nesting it**

  Without a span the wait keeps being billed to `sync-pause` and the fix cannot
  be measured against the corpus, which is the only acceptance evidence
  available. But a span _inside_ `touchActivity` would double-count: `pauseSync`
  is already wrapped whole (`src/app/profile-runtime.ts:38`), and
  `src/runtime/telemetry.ts:1-2` states the invariant this breaks — "the analysis
  subtracts the phase sum from the run's `durationMs` and reads the remainder as
  ssh idle, so two spans covering the same milliseconds are worse than one span
  missing".

  So promote the activity touch out of `pauseSync` (`pilot-services.ts:715-717`)
  into its own preparation step: add it to `PREPARATION_STEPS`
  (`src/run/prepare.ts:12`), call it from `prepareRemote` before `pauseSync`,
  wrap it in `timedPreparation` (`profile-runtime.ts:33-44`) with its own
  `RUN_PHASES` entry. This also fixes the reason attribution the corpus
  exposed — a 120 s wait currently reports as `sync-pause`, a phase that did no
  syncing.

  Check `reasonFor(step)` and the outage reason list (`src/notifications/outage.ts`)
  when adding the step; a step with no reason mapping is a silent gap. Assert
  that the phase totals of a contended run do not overlap.

- [ ] **Step 6: Run the focused tests and verify GREEN**

  Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/run/run-profile.test.ts tests/unit/runtime/telemetry.test.ts`

- [ ] **Step 7: Commit**

  ```bash
  git add src/app/pilot-services.ts src/runtime/telemetry.ts tests/unit
  git commit -m "fix(run): wait out same-workspace contention instead of failing at twice the budget"
  ```

### Task 2: Serve the prewarm queue in arrival order

**Files:**

- Modify: `tests/unit/prewarm/queue.test.ts`
- Modify: `src/prewarm/queue.ts`

- [ ] **Step 1: Write the failing fairness test**

  Publish two requests whose identities sort in the opposite order to their
  arrival: enqueue the hash-late identity first, then the hash-early one, and
  set their mtimes explicitly with `utimes` so the test does not depend on
  filesystem timestamp granularity. Assert `consumeNextPrewarmRequest` observes
  the **first-enqueued** identity.

  Add a second assertion that `.running` still sorts ahead of any pending entry
  regardless of mtime — recovery priority must survive the change
  (`tests/unit/prewarm/queue.test.ts:73` is the existing recovery test).

  Add a third test that guards the mechanics the whole ordering rests on: with
  **no** `utimes` call, publish a request, read its mtime, claim it, and assert
  the `.running` file carries the same mtime. Ordering here is a property of
  `writeFile` setting the mtime and of `link()` (publish,
  `src/prewarm/queue.ts:125-130`) and `rename()` (claim, `:176-183`) both
  preserving it; a later refactor to a copy breaks arrival order with no other
  test failing. This test is the only thing standing between that refactor and a
  silent regression.

  Add a fourth that runs the **production path** with no timestamp injection at
  all: two ordinary `publishPrewarmRequest` calls in sequence, then assert the
  first is served first. The `utimes` test proves the sort; only this one proves
  the sort is fed by something real.

  **State the guarantee honestly: best-effort arrival order, not FIFO.** The
  mtime is stamped by `writeFile` on the generation file, and publication is the
  later `link()`, so two publishers interleaving between those two calls can be
  served in the opposite order to the one in which their requests became
  visible. And exactly-equal mtimes fall back to `localeCompare`, i.e. to the
  identity-hash order this task exists to remove — a tie reinstates the bias for
  that pair. Neither matters at the scale this queue runs (worktree creations
  seconds apart, single-digit depth), but a plan that claims FIFO here is
  claiming something the implementation does not deliver.

  The existing suite uses a real `mkdtemp` home (`:26`) and a real `sourceRoot`
  because `validateRequest` calls `realpath` (`:29-33`); follow that fixture.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm vitest run tests/unit/prewarm/queue.test.ts`

  Expected: the hash-early identity is served first — the stable bias this task
  removes.

- [ ] **Step 3: Sort by arrival**

  In `ownedEntries` (`src/prewarm/queue.ts:144-161`), `lstat` each candidate and
  sort `.running` first (unchanged), then by `mtimeMs` ascending, with
  `localeCompare` kept only as the tiebreak for equal timestamps so the order
  stays deterministic. Drop entries whose `lstat` raises `ENOENT` — a request
  claimed by the same pass is a normal race, not an error.

  The queue is capped at `MAX_QUEUE_ENTRIES = 1_024` (`:10`) and realistically
  holds single digits, so one `lstat` per entry per 1 s controller pass
  (`src/node/controller.ts:74`) is not worth avoiding.

  Leave one line at the publish site recording that arrival order depends on
  `link()` preserving the write mtime — the constraint is invisible from
  `ownedEntries`, which is where the sort lives.

  Note deliberately: a coalesced re-request keeps the **first** arrival's mtime,
  because `link()` returning `EEXIST` (`:132-133`) leaves the existing file
  untouched. That is the intended FIFO semantic. Do not "refresh" the mtime on
  coalesce — it would push a repeatedly-requested worktree to the back of the
  queue forever, which is the same starvation class this task removes.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `pnpm vitest run tests/unit/prewarm/queue.test.ts`

- [ ] **Step 5: Commit**

  ```bash
  git add src/prewarm/queue.ts tests/unit/prewarm/queue.test.ts
  git commit -m "fix(prewarm): serve queued requests in arrival order, not identity-hash order"
  ```

### Task 3: Report prewarm queue position, depth and wait age

**Files:**

- Modify: `tests/unit/prewarm/queue.test.ts`
- Modify: `src/prewarm/queue.ts`
- Modify: `src/diagnostics/doctor.ts`
- Modify: `src/app/default-dependencies.ts`
- Modify: `tests/unit/diagnostics/doctor.test.ts`
- Modify: `tests/unit/app/default-dependencies.test.ts`
- Modify: `docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md`

- [ ] **Step 1: Pin the output contract before writing code**

  `formatStatus` (`src/diagnostics/doctor.ts:164-167`) prints one flat line and
  validates its fields; `StatusSnapshot.prewarm` is a closed enum
  (`doctor.ts:152-160`) asserted by `tests/unit/app/default-dependencies.test.ts:160-163`.
  Keep the enum as the state and carry the detail alongside it, so the four
  existing states stay parseable:

  ```
  ariadne controller=running prewarm=queued(2/5,4m12s) session=...
  ariadne controller=running prewarm=running(0/3,11m02s) session=...
  ariadne controller=running prewarm=idle session=...
  ```

  Position is **dispatch entries ahead of this one**, counted in the exact order
  the controller consumes — which puts every `.running` entry ahead of every
  pending one (`src/prewarm/queue.ts:152-156`). "Pending entries ahead" would be
  a different and smaller number, and would tell a waiting consumer it is next
  while a recovered claim is still in front of it. Depth counts all entries.
  `idle` and `unknown` print bare, with no parenthesis. Test the
  `[running, queued, queued]` arrangement explicitly.

  The duration is **age since enqueue**, in both states — mtime is the enqueue
  instant and `rename` preserves it, so a `.running` request reports how long
  ago it was asked for, not how long it has been running. Say so in the runbook
  line; `running(0/3,11m02s)` otherwise reads as an 11-minute runtime, which is
  the number an operator would act on. Reporting runtime instead would require
  recording the claim instant — exactly what owner decision 2 declined.

- [ ] **Step 2: Write the failing tests**

  - `inspectPrewarmRequest` returns position, depth and `waitedMs` for a queued
    request placed behind two others, and for a `.running` one.
  - `formatStatus` renders each of the four states in the pinned syntax and
    still rejects an invalid profile name.
  - The status-line regex test in `tests/unit/app/default-dependencies.test.ts`
    accepts the new token.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run: `pnpm vitest run tests/unit/prewarm/queue.test.ts tests/unit/diagnostics/doctor.test.ts tests/unit/app/default-dependencies.test.ts`

- [ ] **Step 4: Widen `inspectPrewarmRequest` and the status line**

  `inspectPrewarmRequest` (`src/prewarm/queue.ts:101-113`) currently `lstat`s
  two fixed paths. Have it reuse `ownedEntries` so position comes from exactly
  the order the controller will consume, then locate this request's basename in
  that list. Return the state plus the numbers; keep the four state strings
  unchanged.

  **Keep `entryKind` for the state, use `ownedEntries` only for the numbers.**
  The two disagree on purpose: `entryKind` returns `unknown` for anything that
  is not a plain file (`src/prewarm/queue.ts:94`), while `ownedEntries` filters
  `isFile() || isSymbolicLink()` (`:151`) and so _accepts_ symlinks. Deriving
  the state from `ownedEntries` would report a symlinked `<basename>.json` as
  `queued`, and `publishPrewarmRequest` — which self-checks through this same
  function (`:121-123`) and throws `"prewarm queue entry is unsafe"` on
  `unknown` (`:123`) — would silently return `coalesced` instead. That is a
  safety regression in a security check, delivered as a status feature. Add
  tests for a symlinked and a directory target.

  `ownedEntries` **throws** above `MAX_QUEUE_ENTRIES` (`src/prewarm/queue.ts:147`),
  and it is about to be reachable from the read-only status path, which today
  cannot fail that way. Degrade to `unknown` rather than propagating: a status
  command that throws because the queue is deep is a diagnostic that breaks
  exactly when it is needed. Cover it with a test.

  Publish now pays one `readdir` plus an `lstat` per entry on top of its two
  fixed `lstat`s. Irrelevant at real queue depths; do not add a cache for it.

  Thread the numbers through `statusProfile`
  (`src/app/default-dependencies.ts:612-619`) into `StatusSnapshot` and
  `formatStatus`.

- [ ] **Step 5: Run the focused tests and verify GREEN**

  Run: `pnpm vitest run tests/unit/prewarm/queue.test.ts tests/unit/diagnostics/doctor.test.ts tests/unit/app/default-dependencies.test.ts`

- [ ] **Step 6: Document the new status token**

  Add the `prewarm=queued(p/d,age)` syntax to the operations guide next to the
  existing status description, with the one-line reading: a position that does
  not fall over successive `status` calls means the controller is stuck, not
  that the queue is deep.

- [ ] **Step 7: Commit**

  ```bash
  git add src/prewarm/queue.ts src/diagnostics/doctor.ts src/app/default-dependencies.ts tests/unit docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md
  git commit -m "feat(status): report prewarm queue position, depth and wait age"
  ```

### Task 4: Cap concurrent workloads per host

**Read before starting:** this task has no failure in the corpus attributed to
it. It targets the degradation data in the issue body (cheap gates degrading
monotonically with overlap; `io some=73.1s` PSI), not the exit-75 cluster, which
Tasks 1–3 own. If Tasks 1–3 change the observed behaviour enough, re-measure
before building this.

It also does not compose with Task 1 as cleanly as the ordering suggests: once a
run can be parked waiting for a host slot, a second run of the **same** worktree
spends its whole Task 1 budget waiting on a holder that has not started. Cap the
two budgets against each other, and prefer a slot deadline shorter than the
same-identity wait so the queue drains from the head.

**Ownership (Fable consultation, 2026-08-18 — reverses the first draft):** the
cap integer lives on the **host**, not in the consumer manifest. A manifest key
with "largest declared N wins" means the least conservative client governs a
resource it does not own; today that is invisible because host and consumer have
the same owner, and the day a second consumer appears the failure is silent
over-subscription — precisely the pathology being fixed. A host-side file costs
no more to read than a manifest key costs to validate, and it removes the
footgun permanently. It is also the smaller diff: no config type, no validator,
no `closed()` whitelist entry, no manifest tests.

Fable would additionally keep `remote.concurrency` in the manifest as an
optional _lowering_ bound (`effective = min(host, consumer)`). Not built: no
consumer needs to lower it today, and a second knob that can only ever agree
with the first is a config for a value that never changes. Add it the day a
consumer actually wants to be more conservative than its host.

**Files:**

- Modify: `tests/unit/app/pilot-services.test.ts`
- Modify: `src/app/pilot-services.ts`
- Modify: `docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md`

- [ ] **Step 1: Write the failing wrapper tests**

  Assert the shell built by `remoteChildArguments`
  (`src/app/pilot-services.ts:172-173`):

  - the emitted script reads the cap from a host-side file at run time —
    `~/.config/remote-runner/concurrency` on the host, resolved by the remote
    shell's own `$HOME`, absent or unreadable meaning **no cap**. A malformed
    value must also mean no cap, never a cap of zero: a typo that wedges every
    run on the workstation is a far worse failure than an uncapped one;
  - with no cap file, the run reaches `exec "$@"` having taken no slot, and the
    behaviour is indistinguishable from today's;
  - the slot scan runs **after** the per-identity workload lock, so a run
    waiting on its own worktree does not occupy a scarce host slot;
  - the slot fd stays open across `exec "$@"`, so the slot is held for the
    workload's life and released by the kernel when the child dies — no stale
    slot to reclaim, whether the child exits, is killed, or the ssh channel
    drops.

  **Scope the namespace honestly — it is not host-wide.** `generatedRoot` is a
  per-profile manifest field (`src/config/types.ts:19`,
  `src/config/load-manifest.ts:216,285`), and every remote path resolves against
  the SSH account's home, so slots under `<generatedRoot>/.slots` are shared
  only by profiles that agree on both the account and the root. Two profiles
  pointing at the same physical workstation through different accounts, or with
  different `generatedRoot` values, get independent semaphores and the cap
  silently doubles.

  Put the slots next to the cap file, under a fixed remote path
  (`~/.local/state/remote-runner/slots/<i>`, sibling to the existing remote
  state root), so cap and slots always share one scope, and call the feature
  what it is: **per-account**, one workstation account being the unit. Document
  that a second SSH account on the same box is a second, uncapped pool.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts`

- [ ] **Step 3: Resolve the exit-reason problem before writing the scan**

  A slot deadline fires inside the child wrapper, whose exit code **is** the
  run's exit code. `WORKLOAD_LOCK_BUSY_EXIT_CODE` works today only because it is
  observed on the separate `touchActivity` ssh call
  (`src/app/pilot-services.ts:711`), never on the child. So a bare `exit 75`
  from the scan is indistinguishable from a workload that itself exited 75 —
  which defeats ask (3) of the issue, the one thing this task owes the consumer.

  Worse than indistinguishable: the deadline fires **before** the child emits
  `RR_CHILD_STARTED` (`pilot-services.ts:267`), so the run resolves as
  `{ kind: "not-started", reason: "child-start" }` (`pilot-services.ts:981`,
  `src/app/profile-runtime.ts:112`). `child-start` is not in
  `LOCAL_RERUN_POINTLESS_REASONS` (`src/run/run-profile.ts:26`), so in auto mode
  the runner falls back to running the whole workload **locally** — a host cap
  whose enforcement path pushes the work onto the laptop it was protecting the
  host from. Whatever signal Step 3 picks must also be added to the
  pointless-fallback set, and an SSH-channel drop while the shell is mid-wait
  must not race a late remote acquisition against that fallback.

  Decide and record the choice in the plan before implementing. Options, in
  increasing cost:

  1. the scan writes a fixed sentinel line to fd 2 before exiting 75, and the
     client matches it on the stream it already reads;
  2. the scan writes a marker file the client stats after a 75;
  3. a bounded pre-flight ssh call that waits for a free slot, then a `flock -n`
     in the child that is expected to succeed — racy, but the race degrades to
     one extra sweep, and the _wait_ is then observed exactly where
     `touchActivity` already observes one.

  Option 1 is the smallest thing that works and reuses a stream the client
  already consumes.

- [ ] **Step 4: Add the slot semaphore**

  Bounded scan over `1..N` slot files with `flock -n`, sleeping between sweeps,
  deadline → the chosen explicit exit path from Step 3.

  Mark the ceiling with a `ponytail:` comment where the code makes it:

  ```
  # ponytail: slot scramble, not FIFO — no stable starvation because the loser
  # re-races every sweep; build a real queue only if a run is observed starved.
  ```

- [ ] **Step 5: Run the generated shell for real, then verify GREEN**

  Asserting on the wrapper string proves the script was composed, not that it
  locks. Execute the generated shell in a tmpdir with competing children and
  assert the four properties that matter: a slot is held while a child runs, the
  N+1-th competitor blocks, the deadline fires and reports itself, and the slot
  is released when the child is **killed**, not only when it exits. The whole
  design rests on kernel fd release; nothing else in the suite tests it.

  Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts`

- [ ] **Step 6: Document the cap and its caveats**

  Runbook: where the host cap file lives, that it is read per run so it needs no
  restart, that absent/malformed means uncapped, and how a run stopped by the
  slot deadline identifies itself.

- [ ] **Step 7: Commit**

  ```bash
  git add src/app/pilot-services.ts tests/unit docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md
  git commit -m "feat(run): cap concurrent workloads per host with a slot semaphore"
  ```

---

## Acceptance

- `pnpm vitest run` green; lint and typecheck green.
- Task 1 verified against behaviour, not only tests: start a long run for one
  worktree, start a second run of the **same** worktree, and confirm the second
  prints the wait notice, waits, and proceeds — and that its `run-finish` record
  carries the new wait phase rather than a 120 s `sync-pause`.
- Task 2 verified by the fairness test; the enqueue-order assertion is the whole
  proof, since production order is otherwise unobservable.
- Task 3 verified by running `remote-runner status` against a queue with at
  least two pending requests and reading the position.
- Task 4 verified by the wrapper-argv tests plus one live run with
  `concurrency: 1` from two worktrees at once.

## Named follow-up: prewarm yields to a user-initiated run

Task 1 makes the second run wait. It does not question **who** should wait. The
in-flight holder is usually a prewarm of the same worktree, profile and command
— a best-effort job the user is now queued behind, whose warming effect (mirror,
worktree, caches) is already on disk and survives cancellation. Yielding costs
only a cancellation path; the user's run then takes the lock immediately, and
nothing of value is discarded.

Not built now, and deliberately preferred over the heavier alternative of
_adopting_ the in-flight run's result, which would need a durable replayable
result and exit-code contract — too much machinery for one consumer on one host.

**Trigger to build it:** the wait span added in Task 1 Step 5. If the median
same-identity wait exceeds ~30 s, users are routinely sitting behind a
preemptible job and yield has paid for itself. File the follow-up issue when
Task 1 merges, with that threshold in it — the span is worthless as a trigger if
nobody is watching for a number.

## Deliberately out of scope

- **ETA.** Owner decision 3. Position plus wait age answers "is it moving?";
  a duration model is only worth building if that turns out not to.
- **FIFO on the run path.** Only the prewarm queue had a _stable_ bias. A flock
  scramble re-races every sweep, so no run is starved indefinitely.
- **`enqueuedAt` in `PrewarmRequest`.** Owner decision 2 — mtime carries it.
  Add it the next time the schema is touched for any other reason (optional
  field, mtime fallback for legacy files), not before. The queue carries only
  best-effort prewarms, so a reordered queue means suboptimal warming, never a
  wrong result — which is what makes filesystem metadata tolerable here and
  would not make it tolerable for user-initiated work.
- **A fixed cap of one instead of N slots.** Genuinely simpler — one host-scoped
  `flock`, no cap file, no scan — and rejected on the evidence: the degradation
  data buckets by overlap (884 → 1066 → 1177 → 1299 ms at 0 / 1-2 / 3-5 / 6-9),
  so the harm is over-subscription, not concurrency itself. Serializing a
  24-core workstation to one run would trade a measured 40 % slowdown for an
  unmeasured queue.

- **`status --json`.** The command takes no flags at all today
  (`src/cli.ts:124-127`) and nothing consumes its output programmatically.
- **Stale `.running` reclamation.** The queue has no TTL and no attempt counter:
  a claim orphaned by a controller crash sorts first (`src/prewarm/queue.ts:152-156`)
  and is retried on the next pass. Recovery is at-least-once, not perpetual
  replay — the `finally` at `:200-206` removes the claim even when `run()`
  rejects. Separate defect from #22; file it if Task 3's position display starts
  showing requests parked in `running`.
