# Cross-Identity Run-Log Corpus Read (`logs --all`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close [#44](https://github.com/lipchey/remote-runner/issues/44) — a supported read of the whole per-identity `runner.log` corpus, with the provenance a consumer needs to trust the figures, so `ariadne/scripts/remote-lane-report.mjs` can be deleted.

**Architecture:** A pure `src/diagnostics/corpus.ts` (walk → parse → summarize → render) behind an injected two-method runtime, mirroring how `diagnostics/doctor.ts` stays pure and `app/default-dependencies.ts` owns the Node I/O. `logs` grows `--all`, `--json`, `--since`; the existing `logs [profile]` path is untouched.

**Tech Stack:** TypeScript, Node fs, Vitest.

## Reference implementation

`/Users/admin/Projects/ariadne/scripts/remote-lane-report.mjs` + `.test.mjs` (289 + 263
lines, on `main` at `a8fe9c5e`) is the shape this ports, already run against ~1 700 live
records. Read both before Task 1. The test file holds exactly **19** `test(...)` cases;
Task 1 enumerates all of them, so a short port is detectable by count.

## Contracts (define these first — Tasks 3 and 4 both depend on them)

```ts
export interface CorpusOptions {
  readonly since?: string;
  readonly coldThresholdMs?: number; // default COLD_BOOTSTRAP_MS
}
export interface CorpusProvenance {
  readonly source: string;
  readonly files: number;
  readonly unparsed: number;
  readonly runner: string; // formatInstallVersion output, or "unknown"
}
export interface CorpusReport {
  readonly provenance: CorpusProvenance;
  readonly summary: CorpusSummary;
}
```

`CliDependencies` gains `readLogCorpus?(options: CorpusOptions): Promise<CorpusReport>`.
One optional-`since` shape across Task 1, Task 3 and Task 4 — the earlier draft had
`since: string` at the CLI seam and `since?: string` in the reader, which cannot both hold.

## Locked decisions

1. **Raw records are not the interface — the summary is.** #44 asks for JSON over
   formatting, but the four corrections below are exactly the ones a consumer holding raw
   records gets wrong. Upstream does the joins; JSON carries the joined figures. Text
   render exists too, because `logs --all` by hand must stay readable and it is what
   replaces ariadne's runbook recipe.
2. **`--all` never reads the manifest.** Today's `logs [profile]` resolves the profile
   through `loadManifest()` and the current worktree identity. The corpus outliving the
   worktree is the whole point of #44, so `--all` walks the state root directly and works
   from any cwd.
3. **Flag combinations.** `--all` with a profile argument → exit 2 (`--all` spans every
   profile). `--json` or `--since` without `--all` → exit 2. Keeps `logs [profile]`
   byte-identical.
4. **No `--failures <n>`.** The reference has it; `--json` carries every failure, so the
   text render just caps at 15 with a withheld count. One fewer flag to validate.
5. **`--since` stays.** Not for convenience: the window is what makes decision 4 in the
   list below non-trivial, and a consumer windowing raw records would compute it wrong.
6. **Version comes from the install receipt, not a subprocess.** The reader *is* the
   runner: `readInstalledReceipt` + `formatInstallVersion`, `"unknown"` when it throws
   (`node dist/src/main.js` has no receipt beside it). Drops the reference's
   spawn/timeout/SIGKILL block. **Resolve it as
   `readInstalledReceipt(new URL("../main.js", import.meta.url).href)`** — the receipt
   sits one level above the main module (`install-receipt.ts:70` joins `dirname(url)/..`,
   and `main.ts` passes `dist/src/main.js`), so passing `default-dependencies.ts`'s own
   `import.meta.url` would look in `dist/src` and degrade every real invocation to
   `"unknown"` silently. Same `new URL(…, import.meta.url)` idiom as
   `launcherAssetCandidates` in that file.
7. **A hardened, byte-oriented read — do NOT reuse `readOptionalUtf8`.** Two independent
   reasons, both fatal:
   - `readOptionalUtf8` decodes with `new TextDecoder("utf-8", { fatal: true })`
     (`default-dependencies.ts:42`), so a crash that truncated a record mid-multibyte
     character makes the **whole file throw** — the plan's own "a partial trailing line
     loses that record and keeps the rest" property fails, and one bad file kills the
     entire cross-identity read with exit 70. ASCII fixtures pass either way, so the test
     must feed real truncated multibyte bytes.
   - `open` on a FIFO blocks forever. The corpus read walks every path under a
     user-writable tree (363 today), and mode bits do not stop a same-UID replacement of a
     log by a FIFO or symlink.

   So: open `O_RDONLY|O_NONBLOCK`, decide on the **handle** (`fstat().isFile()`), read
   bytes, decode non-fatally. Share the hardened open with `logsProfile` — the hole is
   already there and one guard in the shared reader is a smaller diff than two readers with
   different exposure. Do **not** change `logsProfile`'s fatal decode: only the corpus read
   has the "one bad file must not kill the read" requirement, and flipping it there would
   change existing behaviour for no reason in scope.
8. **`--cold-threshold-ms <n>`, default 5000, echoed in the envelope**, and the sorted
   `bootstrapMs` values of the measured slice ship as a figure. The threshold is the one
   place judgment enters an otherwise deterministic join, and its only justification is
   one machine's observed bimodal gap. A flag plus the distribution lets a consumer on
   different hardware re-cut without an upstream release; without them the envelope is a
   verdict wearing a figure's clothes. This decision was contested — the Codex pass argued
   for a fixed 5 000 ms constant and no `measuredMs`, on the ground that #44 asked only for
   `--all [--json]`. Settled the other way: the issue's ask is not a ceiling on the surface,
   and it is the one place the envelope would otherwise decide something for its consumer.
   Do not relitigate; if it needs reopening, that is a new decision, not an implementation
   detail.
9. **`logs --all` exits 0 whenever the read succeeded**, however many failures the corpus
   holds. `doctor` returns 1 on a failed check (`cli.ts:139`); a reader that copies that
   would break every consumer script under `set -e` the day a lane goes red. Non-zero
   means the read itself failed.
10. **Do not reuse `tailLogs`.** It caps at `MAX_LOG_LINES = 200` and truncates each line
    to 4 096 chars (`diagnostics/doctor.ts`). It is the right reader for `logs [profile]`
    and the wrong one here: reusing it silently caps a whole-corpus answer at 200 records.

## The four corrections that must survive the port

Each was invisible until the reference ran against live data. Each gets a named test.

1. **`dispatched` counts `provider === "remote"` only.** Of 1 684 `run-finish` records
   only 986 reached a remote provider; counting the rest inflates every lane figure. 663
   of the total carry no `runId`, 0 of the remote slice are missing one.
2. **Phase coverage is disclosed as `n of m`.** 867 remote finishes predate the per-phase
   spans. A distribution over `phases` that does not say what it covers silently reports
   on whatever subset happens to be instrumented.
3. **A first-ever dispatch is cold by construction.** Raw "cold bootstrap" read 35 of 82
   where the number that means anything — a *returning* identity paying a cold bootstrap
   — was 11 of 58. Report the join (`returning`, `returningCold`), not a verdict: a cold
   bootstrap is consistent with a reclaimed workspace, and the log records no deletion.
4. **`firstDispatch` is computed over the whole corpus, never the `--since` window.**
   Otherwise an identity whose earlier dispatches fall outside the window is re-labelled a
   newcomer, and every such relabelling turns an eviction into an expected first build.

Plus: read rotated `runner.log.3 .. runner.log` oldest-first, and attribute each record to
the directory it was found in, never to its own `profile` field.

## JSON envelope

```json
{
  "schemaVersion": 1,
  "source": "/Users/admin/.local/state/remote-runner/profiles",
  "files": 359,
  "unparsed": 0,
  "runner": "remote-runner 0.1.0 (app f71f95d0a1b2c3d4e5f60718)",
  "since": "",
  "records": 197,
  "identities": 30,
  "profiles": ["ariadne/verify-full"],
  "span": { "from": "2026-08-17T12:28:57.512Z", "to": "2026-08-18T10:16:10.512Z" },
  "dispatched": { "total": 92, "status": { "0": 79, "1": 7, "75": 6 } },
  "undispatched": 1,
  "deferred": { "transport": 5, "lock": 2, "bootstrap": 1 },
  "bootstrap": {
    "measured": 82,
    "of": 92,
    "coldThresholdMs": 5000,
    "cold": 35,
    "medianMs": 2948,
    "maxMs": 14709,
    "returning": 58,
    "returningCold": 11,
    "measuredMs": [1712, 1804, 2233, "…sorted ascending, one per measured dispatch"]
  },
  "failures": [
    {
      "at": "2026-08-18T09:46:17.119Z",
      "consumer": "ariadne",
      "profile": "verify-full",
      "identity": "b1877903...",
      "runId": "86e528cf...",
      "status": 1,
      "durationMs": 48682
    }
  ]
}
```

`schemaVersion` is the drift signal a consumer gates on, alongside `unparsed` and
`runner`. `coldThresholdMs` ships with the counts so a number lifted out of this envelope
carries its own definition. `failures` is newest-first and complete — the 15-row cap is a
text-render concern only. An absent corpus emits the same envelope with zeroed counts and
`"span": null` (never prose, and never `""` — an empty string compares as a valid ISO
prefix downstream).

`measuredMs` is the one field that grows with the corpus rather than staying figure-scale;
it is bounded by the dispatches in the window, so a busy lane windows with `--since`. If
that stops being enough, the answer is an additive `--records`, not a cap here.

## Risks

1. **`schemaVersion` catches shape changes, not meaning changes.** If a later commit alters
   what an absent `provider` implies, every figure shifts silently at version 1. Guarded by
   the fixture-corpus test in Task 2 — a semantic change reds it, forcing a deliberate bump.
2. **`firstDispatch` is first-in-retained-corpus, not first-ever.** Rotation caps at `.3`,
   so an identity whose genuine first dispatch has rotated out is re-labelled a newcomer and
   its cold bootstraps stop counting against retention. Measured on the live corpus:
   363 log files, largest 992 B against a 5 MB `DEFAULT_LOG_MAX_BYTES`, and **zero rotated
   files have ever been produced**. Documented caveat, not a design change.
3. **The rotation reader is therefore untested against real data** — no `runner.log.1` has
   ever existed on this machine. Task 1's rotation cases are synthetic by necessity.

---

### Task 0: Worktree

- [ ] `git -C ~/Projects/git-packages/remote-runner fetch -q origin main`
- [ ] `git -C ~/Projects/git-packages/remote-runner worktree add /Users/admin/Projects/worktrees/remote-runner-logs-all -b feat/logs-all-json origin/main`
- [ ] `cd /Users/admin/Projects/worktrees/remote-runner-logs-all && pnpm install`
- [ ] Copy this plan in and commit it — it currently exists only as an untracked file in
      the main checkout: `cp ~/Projects/git-packages/remote-runner/docs/superpowers/plans/2026-08-18-logs-all-json.md docs/superpowers/plans/`,
      then `git add` + `git commit -m "docs(plan): cross-identity run-log corpus read"`.

All tasks below run inside that worktree; the main checkout never leaves `main`.

### Task 1: The pure corpus reader

**Files:**

- Create: `tests/unit/diagnostics/corpus.test.ts`
- Create: `src/diagnostics/corpus.ts`

- [ ] **Step 1: Write the failing suite**

Port all 19 reference cases. Titles verbatim from
`/Users/admin/Projects/ariadne/scripts/remote-lane-report.test.mjs` — 1–14 and 17–19 belong
here, 15–16 move to Tasks 3 and 2 respectively:

1. only a finish that reached the remote provider counts as a dispatch
2. a first-ever dispatch is excluded from the returning-cold count even when its bootstrap is cold
3. a returning identity paying a cold bootstrap is counted as returning-cold
4. an earlier dispatch outside the window still makes the identity a returning one
5. the median of an even sample is the midpoint of the two middles, not the upper one
6. a deferred run is reported as a wait, not as an outcome
7. run-unavailable is tallied by reason and never mixed into the dispatch statuses
8. collectRecords walks consumer/profile/identity and skips a directory with no log
9. rotated logs are read oldest-first alongside the live one
10. an unreadable corpus directory is not reported as an empty one
11. a partial trailing line loses that record and keeps the rest of the identity
12. a record missing the fields every reading depends on is counted, not silently dropped
13. the report leads with the provenance every figure below it depends on
14. an absent corpus reports where it was expected instead of failing
15. → Task 3 (argument parsing)
16. → Task 2 (failure list cap)
17. a finish that never reached a provider does not stand as the identity's first dispatch
18. a record cannot re-file itself into a lane the directory did not put it in
19. logs that exist but yield nothing readable are reported, not called an absent corpus

Three cases the reference does not have, added here:

20. a record truncated mid-multibyte character counts as one `unparsed` and the identity's
    earlier records survive — feed real bytes, not an ASCII prefix, or the case is vacuous
21. a non-regular file where a log was expected is skipped, not opened blocking
22. `bootstrap.measured === 0` is reported as such rather than divided by

Interfaces under test:

```ts
export interface CorpusRuntime {
  listDirectories(path: string): Promise<readonly string[]>; // sorted; [] on ENOENT
  readLog(path: string): Promise<string | undefined>; // undefined on ENOENT or non-regular
}
export async function readCorpus(runtime: CorpusRuntime, root: string): Promise<CorpusRead>;
export function summarizeCorpus(records: readonly CorpusRecord[], options?: CorpusOptions): CorpusSummary;
```

**Ordering is part of the contract.** `readdir` order is not defined, so `listDirectories`
sorts and `readCorpus` sorts the merged records by `at` before returning. Within one
identity the rotation order already gives append order, so `firstDispatch` is correct
without the global sort — but `span` and the newest-first `failures` are not. Test with a
runtime that returns directories in reverse order.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/unit/diagnostics/corpus.test.ts`

Expected: FAIL — `src/diagnostics/corpus.ts` does not exist.

- [ ] **Step 3: Implement `src/diagnostics/corpus.ts`**

Port `collectRecords` + `summarize` from the reference, TypeScript, `CorpusRuntime`
injected. Export `COLD_BOOTSTRAP_MS = 5000`. Keep the reference's comments that name a
constraint (the rotation order, the directory-wins attribution, the partial-line
tolerance, the whole-corpus `firstDispatch`, the provider filter, the "consistent with,
not proof of" wording); drop the ones restating the next line.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/diagnostics/corpus.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/corpus.ts tests/unit/diagnostics/corpus.test.ts
git commit -m "feat(diagnostics): read and summarize the run-log corpus across identities"
```

### Task 2: JSON envelope and text render

**Files:**

- Modify: `tests/unit/diagnostics/corpus.test.ts`
- Modify: `src/diagnostics/corpus.ts`

- [ ] **Step 1: Write the failing render assertions**

- `corpusJson(provenance, summary)` returns the envelope above, `schemaVersion: 1`,
  `status` keys stringified, `failures` complete
- `formatCorpus` renders the #44 reference block; `bootstrap.measured === 0` renders "no
  per-phase records in this window" instead of a distribution
- `files === 0` renders the absent-corpus line, while the JSON envelope still parses with
  zeroed counts and `span: null` (a JSON consumer must never receive prose)
- the failure tail caps at 15 and states how many were withheld
- a non-default `--cold-threshold-ms` moves `cold`/`returningCold` and is echoed back in
  `coldThresholdMs`; `measuredMs` is unchanged by it and stays sorted ascending

**Fixture corpus (the drift guard).** Check a small synthetic log tree into
`tests/fixtures/corpus/` — two consumers, three identities, a rotated `runner.log.1`, one
pre-`phases` finish, one `provider: "local"` finish, one `run-finish` with no provider, one
`run-unavailable`, one non-zero status — and pin the complete expected envelope in the
test. `schemaVersion` guards the shape; only this test guards the *meaning*. A commit that
changes what an absent `provider` implies must red here and force a deliberate version bump.

- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN**

Run: `pnpm vitest run tests/unit/diagnostics/corpus.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/corpus.ts tests/unit/diagnostics/corpus.test.ts
git commit -m "feat(diagnostics): render the corpus summary as JSON and text"
```

### Task 3: CLI surface

**Files:**

- Modify: `tests/unit/cli.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing CLI assertions**

Argument tests against a stub `readLogCorpus` (contract defined above):

- `logs --all` prints the text render, exit 0
- `logs --all --json` prints one line of JSON, exit 0
- **exit stays 0 with a corpus full of non-zero `failures`** — non-zero means the read
  failed, never that a lane did
- `logs --all verify-full` → stderr, exit 2
- `logs --json`, `logs --since 2026-08-17` and `logs --cold-threshold-ms 3000` without
  `--all` → stderr, exit 2
- `--cold-threshold-ms 0`, a negative, and a non-integer → exit 2
- `--since 2026-02-30` → exit 2 (the calendar check matters: the cut is a string compare
  against ISO timestamps, so an impossible date would compare fine and silently select a
  range no reader intended)
- `--since` with no value, and a duplicate flag → exit 2
- `logs verify-full` still prints raw lines through `logsProfile`
- `readLogCorpus` unset → "runtime is not configured", exit 70
- `HELP` lists the new form

- [ ] **Step 2: RED** — run `pnpm vitest run tests/unit/cli.test.ts`

- [ ] **Step 3: Implement**

`runReadOnlyDiagnostic` currently rejects any `-`-prefixed argument for all three
commands. Split `logs` out into its own parser rather than widening the shared one —
`status`/`doctor` must keep rejecting flags.

- [ ] **Step 4: GREEN**, **Step 5: Commit**

```bash
git add src/cli.ts tests/unit/cli.test.ts
git commit -m "feat(cli): logs --all --json reads every identity"
```

### Task 4: Node wiring

**Files:**

- Modify: `tests/unit/app/default-dependencies.test.ts`
- Modify: `src/app/default-dependencies.ts`

- [ ] **Step 1: Write the failing wiring test**

Following the temp-HOME pattern already at `tests/unit/app/default-dependencies.test.ts`
(the `runner.log.1` + `runner.log` rotation test): seed two identities under two profiles,
one with a rotated file, then assert `readLogCorpus` reports both identities, the right
`files` count, and the source root. Assert `runner` degrades to `"unknown"` rather than
throwing when the receipt is unreadable — and, separately, that a receipt placed where the
installed layout puts it **is** found, so decision 6's path resolution is pinned by a test
rather than by reasoning. A test that only checks the degradation passes either way.

- [ ] **Step 2: RED** — run `pnpm vitest run tests/unit/app/default-dependencies.test.ts`

- [ ] **Step 3: Implement**

Add `readLogCorpus` to `createNodeCliDependencies`. `listDirectories` from
`readdir(path, { withFileTypes: true })`, `[]` on ENOENT and rethrow otherwise — an
unreadable corpus reported as an empty one reads as a clean lane. `readLog` reuses
`readOptionalUtf8`. Root is `join(home, ".local", "state", "remote-runner", "profiles")`,
factored out of the existing `profileRoot` so the two cannot drift.

- [ ] **Step 4: GREEN**, **Step 5: Commit**

```bash
git add src/app/default-dependencies.ts tests/unit/app/default-dependencies.test.ts
git commit -m "feat(app): wire the cross-identity corpus reader"
```

### Task 5: Docs and full gate

**Files:**

- Modify: `README.md`
- Modify: `docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md`

- [ ] **Step 1: Document the command**

README diagnostics paragraph: `logs --all [--json] [--since <date>]
[--cold-threshold-ms <n>]` reads every identity under the state root and survives worktree
removal. Ops guide: a "Lane report" subsection carrying the reading rules — `dispatched`
is the `provider=remote` slice, `undispatched` runs never reached a provider, `deferred`
are waits and not outcomes (a deferred run can still finish green), `returningCold` and
not `cold` is the retention signal, and a non-zero `unparsed` or an unexpected `runner`
version means check the reader before trusting the figures. **`status 75` is
`INFRASTRUCTURE_EXIT_CODE` — a general fail-closed status returned from seven sites in
`run/run-profile.ts`, only one of them lock-related. Do not document it as lock
contention; contention is `run-unavailable` with `reason: "lock"`, i.e. `deferred.lock`.**
State the two caveats plainly: `coldThresholdMs` defaults to one
machine's observed bimodal gap and is a flag for that reason, and `returning` means
first-in-retained-corpus — an identity whose first dispatch has rotated out reads as a
newcomer.

- [ ] **Step 2: Full gate**

Run: `pnpm verify`

Expected: format, typecheck, lint, tests, build all green. `tests/unit/operations-guide.test.ts`
must stay green — it asserts required runbook topics.

- [ ] **Step 3: Commit, push, PR**

From inside the worktree:

```bash
git add README.md docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md
git commit -m "docs: document the cross-identity lane report"
git push -u origin feat/logs-all-json
gh pr create --base main --title "feat: read the run-log corpus across identities" --body "Closes #44"
```

- [ ] **Step 4: Remove the worktree**

`git -C ~/Projects/git-packages/remote-runner worktree remove /Users/admin/Projects/worktrees/remote-runner-logs-all`,
then confirm the main checkout is still on `main`.

---

## Consumer tail (separate ariadne PR, after this installs)

Do **not** start until `remote-runner install` has published this build and
`remote-runner logs --all --json` runs green on the machine — ariadne resolves the
globally installed CLI, not a pinned dependency, so merging upstream does not upgrade it.

In `~/Projects/ariadne`, one branch:

- delete `scripts/remote-lane-report.mjs` and `scripts/remote-lane-report.test.mjs`
- drop `scripts/remote-lane-report.test.mjs` from the `test-root-vitest` command string in
  `package.json`
- drop the `remote-lane-report.mjs` entry from `GUARDS` in `scripts/direct-run-coverage.mjs`
- rewrite the "Lane report" section of `.claude/runbooks/ci-operations.md` onto
  `remote-runner logs --all [--json]`, keeping the reading rules; also the
  `node scripts/remote-lane-report.mjs` pointer in the prewarm bullet above it
- drop the `scripts/remote-lane-report.mjs` exception paragraph from
  `.claude/memory/project-architecture.md` — the retirement condition it names is now met
- update the `#44` line in `.claude/memory/status.md`

The replacement reader asserts `schemaVersion === 1` and hard-fails on a mismatch rather
than parsing on: an unpinned CLI can change under it between two runs, and that assertion
is the only place the change can surface.

Also correct while there: the runbook's `status 75` line calls it per-identity lock
contention. It is `INFRASTRUCTURE_EXIT_CODE`, returned from seven sites in the runner's
`run/run-profile.ts` of which one is the lock. The claim is wrong in ariadne today,
independently of this port.
