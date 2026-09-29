# Remote Profile Fallback Implementation Plan

**Status:** proposed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A profile may name another profile as `fallback`; when its host is unreachable the run
executes as that profile, with one Telegram message per transition and a `resolve` query for
consumers. Design: `docs/superpowers/specs/2026-09-29-remote-profile-fallback-design.md` (§ numbers
below refer to it).

**Architecture:** Typed `FailureClass` from enrollment/probe/Mutagen → `runProfileLeg` returns
`failover` for reachability-only preparation failures → `executeRequested` in
`default-dependencies.ts` chooses the leg through a locked v2 state file (negative cache + lease +
transitions) → each leg runs the unchanged per-profile runtime.

**Tech Stack:** TypeScript, Node.js, Vitest, pnpm.

**Order and independence.** One implementer, sequential. Tasks 1, 2, 5 and 7 touch disjoint files
and are **independent** of each other (any order). Task 3 needs 2; Task 4 needs 3; Task 6 needs 5;
Task 8 needs 1, 3, 4, 6 and 7; Tasks 9 and 10 need 8 and are independent of each other; Task 11 needs
9 and 10; Task 12 is last.

**Comment rule for all code written under this plan:** avoid redundant comments. Keep only
non-derivable why/constraint, in the shortest form that carries it — one sentence by default; never
the paper trail (no dates, names, ticket/plan/PR/gate IDs, doc or evidence paths); no header
retellings.

**Focused test command** (used by every task): `pnpm exec vitest run <test file>`.

---

### Task 1: Manifest grammar, cross-profile rules, reserved names (independent)

**Files:**

- Modify: `src/config/types.ts`, `src/config/load-manifest.ts`
- Modify: `tests/unit/config/load-manifest.test.ts`

- [ ] **Step 1: Write failing tests** in `load-manifest.test.ts`, building two-profile manifests from
  `validManifest` (`tests/unit/config/manifest-fixture.ts`):
  - `accepts a fallback naming another profile of the same consumer` — `verify-full-pop-os` with
    `fallback: verify-full`; `remoteFallbackOf(manifest, primary)?.id === "verify-full"`.
  - `rejects a profile falling back to itself` → `/falls back to itself/`.
  - `rejects an unknown fallback profile` → `/unknown fallback profile/`.
  - `rejects a fallback target that names a remote fallback` (A → B → C) → `/must not name a remote fallback/`.
  - `rejects a fallback target of another consumer` → `/belongs to another consumer/`.
  - `reserves the profile ids local and fail` → `/reserved profile id/`.
  - `rejects the runner's reserved markers as childEnvironment keys` — each of
    `REMOTE_RUNNER_SELECTED_PROFILE`, `REMOTE_RUNNER_REMOTE_LABEL`.
  - `rejects the runner's reserved markers as secret names`.
  - `keeps REMOTE_RUNNER_CHILD legal as a childEnvironment key` (Ariadne sets it).
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/config/load-manifest.test.ts`; expected
  failures: `fallback must be one of local, fail`, missing export `remoteFallbackOf`.
- [ ] **Step 3: Implement.**
  - `types.ts`: `fallback: "local" | "fail" | string;`
  - `load-manifest.ts`: export `RESERVED_CHILD_ENVIRONMENT`; reject those names in `environment()`
    and `secretNames()`; `fallback` = `nonEmptyString` matching `PROFILE_ID`; after the id loop, run
    the five rules of design §2; export:

    ```ts
    export function remoteFallbackOf(manifest: ManifestV1, profile: Profile): Profile | undefined {
      if (profile.fallback === "local" || profile.fallback === "fail") return undefined;
      return manifest.profiles.find(({ id }) => id === profile.fallback);
    }
    ```

- [ ] **Step 4: GREEN** — same command; then `pnpm typecheck` (callers comparing
  `fallback === "local"` still compile).

### Task 2: Failure classes at enrollment, probe and Mutagen (independent)

**Files:**

- Modify: `src/run/prepare.ts`, `src/ssh/probe.ts`, `src/ssh/client.ts`, `src/sync/mutagen.ts`,
  `src/app/pilot-services.ts` (`validate`, `probe`, `pauseSync`, `resumeAndFlush`)
- Modify: `tests/unit/run/prepare.test.ts`, `tests/unit/ssh/probe.test.ts`,
  `tests/unit/ssh/client.test.ts`, `tests/unit/sync/mutagen.test.ts`,
  `tests/unit/app/pilot-services.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `probe.test.ts` — `failureClassOf`: not spawned (ENOENT and EMFILE) → `local`;
    `Could not resolve hostname` → `reachability`; `Connection timed out`, `Connection refused`,
    `No route to host` → `reachability`; `Host key verification failed` → `security`;
    `Permission denied (publickey)` → `security`; exit 1 → `remote`. Assert `classifySshFailure`
    results are unchanged for the same inputs.
  - `client.test.ts` — `enrollKnownHost` throws `HostKeyScanError`: keyscan not spawned → `local`;
    empty stdout + `getaddrinfo … nodename nor servname provided` → `dns`/`reachability`;
    empty stdout + no stderr → `transport`/`reachability`; keys present, none match → `host-key`/`security`;
    two matches → `host-key`/`security`.
  - `prepare.test.ts` — a `PreparationError` with `failureClass: "security"` surfaces it on the
    result; an untyped throw at `validate` → `local`; at `git-workspace` → `remote`.
  - `mutagen.test.ts` — `pauseForGitReconcile` with an owned-name session whose beta differs throws
    `MutagenOwnershipError`; same for mode mismatch, duplicate owned name, and post-pause ignore
    mismatch in `resumeAndFlush`.
  - `pilot-services.test.ts` — the six named contract cases, each asserting `prepareRemote` result
    `{reason, failureClass}` through `NodeProfileServices` with a fake `processes`:
    **missing ssh** (probe `spawned: false, spawnErrorCode: "ENOENT"`) → `transport`/`local`;
    **un-enrolled unreachable primary** (empty known_hosts, keyscan exit 1, empty stdout) →
    `transport`/`reachability`; **DNS** (probe 255 + resolve stderr) → `dns`/`reachability`;
    **auth** → `authentication`/`security`; **stale pin** (known_hosts pin matches, probe 255
    `REMOTE HOST IDENTIFICATION HAS CHANGED`) → `host-key`/`security`; **endpoint mismatch** (Mutagen
    list returns the owned name with another beta) → `sync`/`security`.
- [ ] **Step 2: RED** — run each of the five files; expected: missing exports
  (`failureClassOf`, `HostKeyScanError`, `MutagenOwnershipError`) and `failureClass` undefined.
- [ ] **Step 3: Implement** (design §3).
  - `prepare.ts`: `FailureClass`; `PreparationError(reason, retryable, options?: ErrorOptions & {
    failureClass?: FailureClass })`; the failure branch of `PrepareResult` gains
    `readonly failureClass: FailureClass`, computed as the error's own class, else `local` for step
    `validate`, else `remote`. The release-failure branch (`prepare.ts:136-141`) returns `local`.
  - `probe.ts`: `failureClassOf(reason, result)`.
  - `client.ts`: `HostKeyScanError`; classify the keyscan result before the `exitCode` check.
  - `mutagen.ts`: `MutagenOwnershipError`; use it in `assertOwnedRecord` and the two duplicate-name throws.
  - `pilot-services.ts`: `validate` rewraps `HostKeyScanError` as a retryable `PreparationError`;
    `probe` passes `failureClassOf`; `pauseSync`/`resumeAndFlush` rewrap `MutagenOwnershipError` as
    `PreparationError("sync", false, { cause, failureClass: "security" })`.
- [ ] **Step 4: GREEN** — the five files, then `pnpm exec vitest run tests/unit/app/profile-runtime.test.ts`
  (unchanged behaviour).

### Task 3: `runProfileLeg` and the child-start window (needs 2)

**Files:**

- Modify: `src/run/run-profile.ts`, `tests/unit/run/run-profile.test.ts`

- [ ] **Step 1: Write failing tests** with the existing `FakeRuntime`, profile
  `{ mode: "auto", fallback: "verify-full" }`:
  - `fails over when preparation stays unreachable` — two `{ok:false, reason:"transport",
    retryable:true, failureClass:"reachability"}` → `{kind:"failover", reason:"transport"}`;
    calls `["prepare","prepare"]`, no `fail-closed`, no `local:`.
  - `fails over under --mode remote too` — same with `modeOverride: "remote"`.
  - `never fails over in local mode` — `local:` only.
  - `fails closed on a security failure` — `failureClass:"security"` → exit 75, `fail-closed`.
  - `fails closed on a local fault` and `on a remote-class failure` (e.g. `sync`/`remote`).
  - `does not fail over when transport is lost just before the start acknowledgement` —
    `remoteKind:"not-started"`, `notStartedReason:"connection-lost"` → exit 75, no failover.
  - `does not fail over when transport is lost just after the start acknowledgement` —
    `marker:true`, `remoteExit:75` → exit 75, no failover.
  - `does not fail over when the ssh client never spawned at child start` (`child-start`) → 75.
  - `keeps local fallback semantics for fallback: local` — the existing suite still passes against
    the `runProfile` wrapper.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/run/run-profile.test.ts`; `runProfileLeg` is
  not exported.
- [ ] **Step 3: Implement** (design §4): export `LegResult` and `runProfileLeg`; the only new
  branch sits in the preparation-failure block:

  ```ts
  if (mode !== "local" && isRemoteFallback(profile.fallback) && prepared?.ok === false &&
      prepared.failureClass === "reachability") {
    return { kind: "failover", reason: stableReason(prepared.reason) };
  }
  ```

  `runProfile` becomes `(await runProfileLeg(...))` mapped to `status` — a plain profile never
  produces `failover`, so the wrapper is total.
- [ ] **Step 4: GREEN** — same command.

### Task 4: Failure class through `profile-runtime` (needs 3)

**Files:**

- Modify: `src/app/profile-runtime.ts`, `src/app/pilot-services.ts` (`recordOutage` signature)
- Modify: `tests/unit/app/profile-runtime.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `hands the preparation's failure class to the fail-closed alert` — a `security` failure on a
    remote-fallback profile calls `recordOutage("host-key", "security")`.
  - `records nothing when the leg fails over` — reachability failure: neither `recordOutage` nor
    `recordFallback` is called (the orchestrator owns that transition).
  - `passes remote as the class of a not-started outage` (e.g. `connection-lost`).
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/app/profile-runtime.test.ts`.
- [ ] **Step 3: Implement.** Keep `pendingFailureClass` beside `pendingFallbackReason`; expose
  `runProfileLeg` via the runtime unchanged; `failClosed` calls `services.recordOutage(reason,
  failureClass)`; `ProfileExecutionServices.recordOutage(reason, failureClass?)`;
  `NodeProfileServices.recordOutage` forwards the class to a new optional
  `options.recordRefusal?: (failureClass, reason) => Promise<void>`, used instead of
  `options.recordFallback` when present.
- [ ] **Step 4: GREEN** — `profile-runtime.test.ts` and `pilot-services.test.ts`.

### Task 5: v2 state transitions, pure (independent)

**Files:**

- Modify: `src/notifications/outage.ts`, `src/notifications/telegram.ts`
- Create: `tests/unit/notifications/fallback-state.test.ts`
- Modify: `tests/unit/notifications/telegram.test.ts`

- [ ] **Step 1: Write failing tests** against an in-memory `FallbackRuntime` (`readState`,
  `writeState`, `nowMs`, `send`, `withLock: (fn) => fn()`):
  - `sends one failover and sets a 60 s negative entry` — `observeUnreachable("transport")`.
  - `repeats extend the TTL without a second message` — three calls → 1 send; `ttlMs` 60→120→240 s;
    capped at 600 s after enough calls.
  - `selectPrimary skips a fresh entry and leases an expired one once` — at `checkedAt+61 s`, first
    call → use P + lease; second call → skip; at `lease.takenAt+61 s` → use P again.
  - `a backward clock step expires the entry` — `nowMs < checkedAt` → use P.
  - `an entry whose ttlMs exceeds the cap is clamped` — hand-written `ttlMs: 10**9` → expired after 10 min.
  - `sends one recovery on a primary child start and clears the cache`.
  - `observeReachable clears the cache but sends no recovery`.
  - `a security refusal is delivered while a transport outage is active` — `observeUnreachable`
    then `observeRefused("security","host-key")` → 2 sends; repeat refusal → still 2.
  - `a remote-class refusal with a local reason is silent` — `("remote","lock")` → 0 sends.
  - `a flap within 15 min resumes the doubled TTL`.
  - `rejects a corrupt or v1 file` — `schemaVersion: 1` → throws `fallback state is corrupt`.
  - `telegram.test.ts`: one assertion per kind on the rendered heading and fields
    (`requested=`, `fallback=`, `class=`).
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/notifications/fallback-state.test.ts
  tests/unit/notifications/telegram.test.ts`.
- [ ] **Step 3: Implement** design §6 as exported functions in `outage.ts` (`FallbackState`,
  `FallbackEvent`, `FallbackRuntime`, `selectPrimary`, `observeUnreachable`, `observeReachable`,
  `observeRefused`, `observePrimaryChildStarted`), reusing `deliver` generically (make it accept any
  queue element) and `isOutageReason`. Constants: `NEGATIVE_BASE_MS = 60_000`,
  `NEGATIVE_MAX_MS = 600_000`, `FLAP_WINDOW_MS = 900_000`, `LEASE_MS = 60_000`,
  `MAX_DELIVERIES_PER_HOLD = 4`. `eventMessage` in `telegram.ts` accepts `NotificationEvent |
  FallbackEvent` and branches on `kind`.
- [ ] **Step 4: GREEN** — same command, then `pnpm exec vitest run tests/unit/notifications/outage.test.ts`
  (v1 unchanged).

### Task 6: Node v2 adapter, lock, v1 reset (needs 5)

**Files:**

- Create: `src/node/lock-files.ts`
- Modify: `src/app/pilot-services.ts` (use `nodeLockFiles()` in `acquireLock`), `src/node/notifications.ts`
- Modify: `tests/unit/node/notifications.test.ts`

- [ ] **Step 1: Write failing tests** on a real temp `home`:
  - `twenty concurrent transitions send exactly one failover` — 20 × `Promise.all` of
    `createFallbackCallbacks(...).observeUnreachable("transport")` with a counting fake Telegram
    runtime → 1 send; state `outage.reason === "transport"`.
  - `twenty concurrent primary child starts send exactly one recovery`.
  - `writes state under fallback/<consumer>/<primary>/state.json with mode 0600`.
  - `retires v1 outage files of the primary once` — seed
    `profiles/ariadne/<P>/<id>/outage.json` (with a queued event); first access renames it to
    `outage.v1-retired.json`, sends nothing for it, and a second access does not rename again;
    `profiles/ariadne/verify-full/<id>/outage.json` is untouched.
  - `selects from a lock-free read when the lock is held past the budget` — hold the lock from a
    second acquirer with a short injected budget; `selectPrimary` answers from the file and takes no lease.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/node/notifications.test.ts`.
- [ ] **Step 3: Implement.** `lock-files.ts` exports `nodeLockFiles(): LockFileSystem` (the adapter
  now inline in `NodeProfileServices.acquireLock`, `src/app/pilot-services.ts:602-624`).
  `notifications.ts` exports `createFallbackCallbacks({ home, context, configPath, stderr, telegram?,
  lockWaitMs? })` returning `{ selectPrimary, observeUnreachable, observeReachable, observeRefused,
  observePrimaryChildStarted }`, each wrapped in the existing `visible` pattern; `withLock` uses
  `acquireProfileLock` with `lockDirectory: () => join(dir, "lock")`, `leaseDurationMs: 120_000`,
  `pollIntervalMs: 100`, wait `lockWaitMs ?? 30_000`.
- [ ] **Step 4: GREEN** — same file, then `pnpm exec vitest run tests/unit/runtime/lock.test.ts
  tests/unit/app/pilot-services.test.ts`.

### Task 7: Reserved child markers (independent)

**Files:**

- Modify: `src/app/pilot-services.ts` (`remoteChildArguments`, `runLocal`), `assets/remote-launcher.mjs`
- Modify: `tests/unit/app/pilot-services.test.ts`, `tests/unit/secrets/remote-launcher.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `remoteChildArguments` output contains `REMOTE_RUNNER_SELECTED_PROFILE=<id>` and
    `REMOTE_RUNNER_REMOTE_LABEL=<label>` after every `childEnvironment` entry and after
    `REMOTE_RUNNER_PROVIDER=remote`.
  - real local child (pattern of the existing `LOCAL_FALLBACK_CANARY` test,
    `tests/unit/app/pilot-services.test.ts:148`): prints `SELECTED_PROFILE|REMOTE_LABEL` → `<id>|`
    even when the parent env sets `REMOTE_RUNNER_REMOTE_LABEL=inherited`.
  - launcher: spawn `assets/remote-launcher.mjs` with env `REMOTE_RUNNER_SELECTED_PROFILE=p` and a
    frame whose allowlist names that variable → child sees `p` (markers win over secrets).
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/app/pilot-services.test.ts
  tests/unit/secrets/remote-launcher.test.ts`.
- [ ] **Step 3: Implement** design §7. Launcher:

  ```js
  const RUNNER_MARKERS = ["REMOTE_RUNNER_SELECTED_PROFILE", "REMOTE_RUNNER_REMOTE_LABEL"];

  function runnerMarkers() {
    return Object.fromEntries(
      RUNNER_MARKERS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
    );
  }
  ```

  and the spawn uses `env: { ...process.env, ...secrets, ...runnerMarkers() }`.
- [ ] **Step 4: GREEN** — same command.

### Task 8: `executeRequested`, per-leg runtime, logs, CLI wiring (needs 1, 3, 4, 6, 7)

**Files:**

- Modify: `src/app/default-dependencies.ts`, `src/cli.ts`
- Modify: `tests/unit/app/default-dependencies.test.ts`, `tests/unit/cli.test.ts`

- [ ] **Step 1: Write failing tests** in `default-dependencies.test.ts`. Add an injectable
  `executeLeg?: (profile, command, mode, hooks) => Promise<LegResult>` option (beside the existing
  `executeProfile`, `src/app/default-dependencies.ts:69-77`) and inject v2 callbacks via a
  `fallbackState?` option:
  - `runs the fallback profile when the primary is unreachable` — P leg → `failover("transport")` →
    F leg runs with F's profile object; one `observeUnreachable`.
  - `double unreachable under auto ends on the fallback's local leg` — P failover; F leg is the real
    `runProfileLeg` over a fake runtime whose preparation is unreachable → `local:` called.
  - `double unreachable under --mode remote fails closed with 75` — same, `mode: "remote"` → 75,
    no local leg.
  - `a fresh negative entry skips the primary without probing it` — `selectPrimary` returns skip → P
    leg never called.
  - `a fallback child start is not recovery` — P skipped, F leg fires `onRemoteChildStarted` →
    `observePrimaryChildStarted` not called.
  - `a primary child start is recovery` — P leg fires it → called once.
  - `a security failure on the primary does not run the fallback` — P leg exit 75 after
    `recordRefusal("security","host-key")` → F never runs.
  - `records requested and selected on every record` — read both `runner.log` files: P's has
    `run-start`, `run-failover {to:"verify-full"}`; F's has `run-start`/`run-finish` with
    `requested:"verify-full-pop-os", selected:"verify-full"`, same `runId`.
  - `a plain profile keeps today's records plus requested === selected`.
  - `cli.test.ts`: `run` passes the resolved fallback profile to `runProfile`; controller-repair
    failure continues for `auto` P whose F has `fallback: local`, exits 70 when F has `fallback: fail`.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/app/default-dependencies.test.ts tests/unit/cli.test.ts`.
- [ ] **Step 3: Implement** design §4–§5.
  - `CliDependencies.runProfile(profile, command, mode?, controllerEnsureMs?, fallback?: Profile)`;
    `runSelectedProfile` resolves `remoteFallbackOf` and applies the chain rule to the controller
    branch (`src/cli.ts:429`).
  - Split `executeWorkload` into `executeLeg(legProfile, requested, command, mode, notifier)` that
    returns `LegResult`; P's leg passes `recordRefusal`/`recordRemoteChildStarted` wired to the v2
    callbacks, F's and plain legs keep the v1 notifier. `executeProfile` takes `requested` and
    writes `requested`/`selected` on every record, plus `run-failover` when a leg fails over.
  - `executeRequested(P, F, command, mode)` per design §4; F's command is the override or
    `F.workload.command` — `cli.ts` passes `commandOverride` separately so the default can be chosen
    per leg.
  - `benchmarkProfile` keeps calling the plain `executeProfile` path with failover disabled (D8).
- [ ] **Step 4: GREEN** — same files, then `pnpm exec vitest run tests/unit/main.test.ts`.

### Task 9: `resolve` command (needs 8; independent of 10)

**Files:**

- Modify: `src/cli.ts`, `src/app/default-dependencies.ts`
- Modify: `tests/unit/cli.test.ts`, `tests/unit/app/default-dependencies.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `cli.test.ts` (fake `resolveProfile` dependency): prints the JSON verbatim and exits 0/3/4 by
    the returned `outcome`; `resolve` without `--json` → 2; unknown profile → 2; extra argument → 2;
    dependency throws → 70; HELP lists `remote-runner resolve <profile> [--manifest <path>] --json`.
  - `default-dependencies.test.ts` (fake `processes`, fake v2 callbacks):
    `answers the primary when reachable` (`fallbackActive:false`, `reason:null`);
    `answers the fallback and records the transition when the primary is unreachable`
    (`observeUnreachable` once, `selected:"verify-full"`, `remoteLabel:"ariadne-runner"`);
    `uses the cached negative entry without probing the primary` (no ssh to P's target);
    `answers the local end under auto when both are unreachable` (`remoteLabel:null`, exit 0);
    `returns nothing-reachable under REMOTE_RUNNER_MODE=remote` (exit 3);
    `returns a security refusal` (stale pin → exit 4, `observeRefused("security","host-key")`);
    `returns 70 on a local fault` (ssh missing);
    `creates no Mutagen session` — the fake `processes` records no `mutagen` invocation;
    `takes no profile lock` — no `locks/<identity>` directory is created.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/cli.test.ts tests/unit/app/default-dependencies.test.ts`.
- [ ] **Step 3: Implement** design §8: `CliDependencies.resolveProfile?(profile, fallback?, mode) →
  Promise<{ outcome: "selected" | "unreachable" | "security"; answer: ResolveAnswer }>`; a
  `local`-class fault throws (→ 70). The node side builds `NodeProfileServices` per hop and calls
  only `validate()` and `probe()`.
- [ ] **Step 4: GREEN** — same command.

### Task 10: `prewarm` and `status` for a remote-fallback profile (needs 8; independent of 9)

**Files:**

- Modify: `src/app/default-dependencies.ts` (`statusProfile`, `inspectOutage`)
- Modify: `tests/unit/main.test.ts`, `tests/unit/app/default-dependencies.test.ts`

- [ ] **Step 1: Write failing tests.**
  - `main.test.ts`: `prewarm of a remote-fallback profile prewarms the selected profile` — the
    controller callback (`src/main.ts:110-117`) with injected dependencies whose v2
    `selectPrimary` skips P → the executed leg is F with mode `remote`, and no local leg runs.
  - `default-dependencies.test.ts`: `status reads the v2 outage for a remote-fallback profile` →
    `outage=active fallback=active(verify-full)`; a plain profile's line is byte-identical to today's.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/main.test.ts tests/unit/app/default-dependencies.test.ts`.
- [ ] **Step 3: Implement** design §6 (Status) and §9; the prewarm path needs no code beyond Task 8
  if the test passes on its own — then keep the test and change nothing.
- [ ] **Step 4: GREEN** — same command.

### Task 11: README and operator guide (needs 9 and 10)

**Files:**

- Modify: `README.md`, `docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md`
- Modify: `tests/unit/operations-guide.test.ts`

- [ ] **Step 1: Write failing test** in `operations-guide.test.ts`: the guide contains
  `Remote fallback`, `Rollback from remote fallback`, `remote-runner resolve`,
  `REMOTE_RUNNER_SELECTED_PROFILE`, `REMOTE_RUNNER_REMOTE_LABEL`, and the resolve exit codes `3` and
  `4` in a table row.
- [ ] **Step 2: RED** — `pnpm exec vitest run tests/unit/operations-guide.test.ts`.
- [ ] **Step 3: Write the docs.**
  - README "Consumer commands": `remote-runner resolve <profile> [--manifest <path>] --json`, the
    `fallback: local | fail | <profile id>` grammar, the one-hop rule and mode interaction, the
    resolve exit table (design §8), a pointer to the rollback section.
  - Operator guide "Remote fallback": failure-class table (design §3), what each Telegram kind means
    (`refused … class=security reason=sync` = Mutagen session under the owned name with foreign
    endpoints), v2 state path and schema, TTL/lease behaviour, how to read `run-failover` records.
  - Operator guide "Rollback from remote fallback": design §10 verbatim in steps, including that
    0.1.0 rejects the whole manifest.
  - "Upgrade": note the one-time v1 retirement.
- [ ] **Step 4: GREEN** — same command, then `pnpm format:check`.

### Task 12: Full verification

**Files:** none.

- [ ] **Step 1: Run the repository gate.** `pnpm verify` expands (package.json `scripts.verify`) to:

  ```bash
  pnpm format:check   # prettier . --check --ignore-unknown
  pnpm typecheck      # tsc -p tsconfig.json --noEmit
  pnpm lint           # eslint . --max-warnings=0
  pnpm test           # vitest run
  pnpm build          # rm -rf dist && tsc -p tsconfig.json
  ```

  Run `pnpm verify`. Expected: all green; the test count rises above the base 763 passed / 5 skipped
  with no newly skipped tests. Read prettier's exit code, not its summary line.
- [ ] **Step 2: Consumer smoke (manual, with the owner).** Install from the worktree
  (`node dist/src/main.js install`), add `verify-full-pop-os` to Ariadne's manifest in an Ariadne
  worktree, then: `remote-runner resolve verify-full-pop-os --json` (pop-os up → `selected` is the
  primary); stop sshd on pop-os or block it, re-run `resolve` → `selected:"verify-full"` and exactly
  one Telegram "unreachable" message; `remote-runner run verify-full-pop-os -- true` → runs on
  `ariadne-runner`; restore pop-os, wait out the TTL, run again → one recovery message.

## Traceability

| Contract item                         | Design §      | Plan task(s) | Concrete tests                                                                                                  |
| ------------------------------------- | ------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| 1 `fallback` = local or profile id    | §2, §4        | 1, 8         | self-reference, unknown id, remote-of-remote target rejected; fallback runs with F's profile object             |
| 2 One remote hop (A1)                 | §4            | 3, 8         | fail over under `auto` and `--mode remote`; double unreachable under auto → local; under remote → 75            |
| 3 Classification (A2)                 | §3            | 2, 3         | missing ssh, un-enrolled unreachable primary, DNS, auth, stale pin, endpoint mismatch; security/local/remote fail closed |
| 4 Runtime per selected profile (A3)   | §5            | 4, 8         | fallback child start is not recovery; primary child start is; requested/selected on every log record           |
| 5 Child-start window (A4)             | §4            | 3            | transport loss just before and just after the start acknowledgement → 75, no failover                            |
| 6 Reserved env (A5)                   | §2, §7        | 1, 7         | markers rejected as childEnvironment keys and secret names; set after secrets remote (launcher) and local        |
| 7 Outage state v2 (A6)                | §6            | 5, 6         | 20 concurrent transitions → 1 message; recovery once; TTL/lease/clock step; security during outage; v1 retirement |
| 8 `resolve`                           | §8            | 9            | JSON shape; exit 0/3/4/70/2; cache shared with run; no Mutagen session; no profile lock                         |
| 9 `prewarm` selects                   | §9            | 10           | prewarm of P while P is skipped executes F in remote mode                                                        |
| 10 Rollback (A7)                      | §10           | 11           | guide contains the rollback section (operations-guide test)                                                     |
| 11 Operator doc + README              | §11           | 11           | operations-guide test asserts the new sections, markers and exit codes                                          |

## Review amendments (binding — they override the tasks and the design where they differ)

Each amendment names the task it changes; the design spec is updated to match in Task 11.

- **G1 Refusal outranks the negative cache (Tasks 5–6).** `observeRefused` clears `negative` and
  `lease`. `selectPrimary` never skips P while `refusal` is set: P is probed and fails closed by its
  own probe, and a fixed P can recover. A live lease skips to F only while `outage` is set. Tests:
  outage → expired entry → lease holder hits `host-key` → the next callers probe P and fail closed
  instead of running on F; a concurrent caller during the holder's probe.
- **G2 Delivery guarantee (Tasks 5–6, 11).** The guarantee is exactly-once durable enqueue per
  transition plus at-least-once delivery (a crash between `send` and the queue write can repeat one
  message, as v1 already can). The lock-timeout skip stays; tests prove a skipped `observeUnreachable`
  is re-observed by the next probe and a skipped recovery by the next primary child start (the
  `outage` field stays set). Docs state this guarantee, not "exactly one".
- **G3 Mid-preparation loss (design D4).** Stays fail-closed (75). Correct the wording: the next run
  finds no negative entry, probes P, and falls over through the probe. No shared classifier.
- **G4 Request context (Tasks 8–9).** One `RunRequest { requested, commandOverride?, runId }` is
  created before any leg and passed unchanged to every leg; `cli.ts` passes `commandOverride`, never a
  pre-resolved command; each leg uses `commandOverride ?? leg.workload.command`. Both legs log the same
  `runId`. Tests: no override, explicit override, direct failover, cached-primary skip.
- **G5 Namespace and topology (Tasks 1, 5–6).** Manifest load validates `consumer` with the Mutagen
  session-component rule (`src/sync/mutagen.ts` `COMPONENT`). v2 state stores
  `topology: { target, hostKeySha256, fallback, fallbackTarget }` of P; a mismatch read under the lock
  resets the state to empty (no outage/negative/lease/refusal, queue kept), writes one stderr line and
  sends nothing. Tests: an unsafe consumer is rejected; two manifests with the same key and different
  targets.
- **G6 Drain criterion (design §10, Task 11).** Terminal records for drain are `run-finish`,
  `run-error` and `run-failover`; the docs give the exact command sequence; a test covers a mixed P/F
  history.
- **G7 Back-off persistence (Task 5).** Persist `backoffTtlMs` (validated, ≤ `NEGATIVE_MAX_MS`); a new
  outage within `FLAP_WINDOW_MS` of `lastRecoveryAt` starts from it; outside the window it resets to
  `NEGATIVE_BASE_MS`. The flap test round-trips the state through serialization.
- **G8 `resolve` classes (Task 9).** P, F and plain profiles are classified alike: `security` → 4,
  `local` → 70, `remote` or nothing reachable → 3. Mutagen ownership is not part of `resolve` (it
  creates and inspects no session); remove it from the exit-4 row. Tests cover each class on F.
- **G9 Benchmark (Tasks 3, 8).** Define `isRemoteFallback(fallback)`. The `runProfile` wrapper maps a
  `failover` leg to 75 and writes no v2 state; benchmark uses that wrapper. Test benchmarking an
  unreachable remote-fallback profile → 75, no F leg, no v2 file.
- **G10 Event names (Tasks 5, 7).** v2 events use their own kinds: `primary-down`,
  `primary-recovered`, `primary-refused`; a recovery names what it cleared (outage, refusal or both).
  Keep explicit v1 and v2 rendering tests.
- **G11 First access (Task 6).** Create `fallback/<consumer>/<primary>` recursively (0700) before
  acquiring the lock; the test starts from a home without it.
- **G12 Corpus (Task 8).** Add corpus tests with legacy records and `run-failover` records; the
  guide states that `summary.records` counts `run-failover`.
- **G13 Version and forward order (Tasks 11–12).** Bump `package.json` `version` to `0.2.0`. The docs
  state the forward order: install the new revision on the workstation before any consumer manifest
  names a profile id as `fallback`; `0.1.0` rejects such a manifest whole.
- **G14 Ordering and commands.** Tasks 2 and 7 both edit `pilot-services.ts`, and 9 and 10 both edit
  `default-dependencies.ts`: run them in the order 2 → 7 and 9 → 10. Every "same command" means the
  full `pnpm exec vitest run <files>` line named in that task's RED step.
- **G15 Operator escape hatch (Task 11).** The guide states that a `security`, `local` or `remote`
  refusal of P blocks runs of P (fail-closed by design) and that the operator runs the fallback
  profile by name (`remote-runner run <fallback>`) until P is fixed.
