# Remote Profile Fallback Design

**Status:** proposed.

## 1. Problem

A profile can fall back only to a local run (`fallback: local`) or to nothing (`fail`)
(`src/config/load-manifest.ts:278`, `src/config/types.ts:12`). The owner wants a primary remote with
a second remote behind it: Ariadne adds `verify-full-pop-os` (host `pop-os`, `fallback: verify-full`)
while `verify-full` (host `ariadne-runner`, `fallback: local`) keeps its id, target and its live
Mutagen sessions `remote-runner-ariadne-verify-full-<identity>`. One Telegram message per transition
(down, recovery), a pre-dispatch query so Ariadne can pick its test tier, and all failover logic in
remote-runner.

Today's facts the design builds on:

- `runProfile` decides local fallback purely from `mode === "auto" && fallback === "local"`
  (`src/run/run-profile.ts:90-92`) and from an untyped `reason` string
  (`src/run/run-profile.ts:113-116`, `:153-156`).
- Preparation maps a failing step to a closed reason (`src/run/prepare.ts:90-99`); a
  `PreparationError` carries its own reason and retryability (`src/run/prepare.ts:38-47`). The step
  releases the per-worktree lock before returning a failure (`src/run/prepare.ts:136-141`).
- Enrollment is a keyscan inside `validate` (`src/app/pilot-services.ts:590-599`,
  `src/node/managed-ssh.ts:166-198`); a scan that fails throws the untyped
  `"host key scan failed"` (`src/ssh/client.ts:213`), which `reasonFor("validate")` turns into
  `validation` — an un-enrolled unreachable host is indistinguishable from a manifest error.
- The probe classifies ssh failures by stderr (`src/ssh/probe.ts:8-31`) and throws a retryable
  `PreparationError` (`src/app/pilot-services.ts:665-668`); a spawn failure is `transport`
  (`src/ssh/probe.ts:12`) although nothing left the workstation.
- A Mutagen session under the owned name with foreign endpoints/mode/ignores throws a plain
  `DiagnosableError` (`src/sync/mutagen.ts:285-296`, `:392-402`), mapped to `sync`.
- Outage state is per worktree identity at `profiles/<consumer>/<profile>/<identity>/outage.json`
  (`src/app/default-dependencies.ts:541-547`, `:125-127`), read-modify-written with no lock
  (`src/node/notifications.ts:115-141`).
- The profile lock is keyed by worktree identity only (`src/app/pilot-services.ts:629-645`), so two
  profiles of one worktree already exclude each other.
- The prewarm controller replays `run <profile> --mode remote` (`src/main.ts:110-117`).

## 2. Manifest (contract 1, 6)

`fallback` becomes `"local" | "fail" | <profile id>`. `parseProfile` accepts any `PROFILE_ID`
(`src/config/load-manifest.ts:9`) there; a new cross-profile pass after the id loop
(`src/config/load-manifest.ts:342-350`) rejects:

| Rule                                                                         | Error                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------- |
| profile id `local` or `fail`                                                 | `reserved profile id: <id>`               |
| `fallback` names its own profile                                             | `profile <id> falls back to itself`       |
| `fallback` names no profile in the manifest                                  | `unknown fallback profile: <id>`          |
| target's own `fallback` is a profile id                                      | `fallback <id> must not name a remote fallback` |
| target has a different `consumer`                                            | `fallback <id> belongs to another consumer` |

`types.ts` gets `fallback: "local" | "fail" | string` plus a helper
`remoteFallbackOf(manifest, profile): Profile | undefined` exported from `load-manifest.ts`.

**Reserved env (contract 6).** `RESERVED_CHILD_ENVIRONMENT = ["REMOTE_RUNNER_SELECTED_PROFILE",
"REMOTE_RUNNER_REMOTE_LABEL"]` is exported from `load-manifest.ts`. `environment()`
(`src/config/load-manifest.ts:150-166`) and `secretNames()` (`:168-176`) reject both names. Existing
markers (`REMOTE_RUNNER_CHILD`, `REMOTE_RUNNER_PROVIDER`) stay legal as `childEnvironment` keys —
Ariadne's manifest sets `REMOTE_RUNNER_CHILD: "1"`.

## 3. Failure classification (contract 3)

A new closed type in `src/run/prepare.ts`:

```ts
export type FailureClass = "reachability" | "local" | "security" | "remote";
```

`PreparationError` takes `failureClass` in its options (default `"remote"`); `PrepareResult`'s
failure branch carries `failureClass`. Untyped throws default to `"local"` at the `validate` step
(directory creation, known_hosts read) and `"remote"` elsewhere. The `reason` stays exactly what it
is today, so the local-fallback path and its notifier see no change except §3.1's first-use case.

| Site                                             | Condition                                               | reason              | class          |
| ------------------------------------------------ | ------------------------------------------------------- | ------------------- | -------------- |
| enrollment (`validate`)                          | `ssh-keyscan` not spawned (ENOENT, EMFILE, ENOMEM)      | `validation`        | `local`        |
| enrollment                                       | scan returned no key; stderr names DNS failure          | `dns`               | `reachability` |
| enrollment                                       | scan returned no key; stderr connect failure or empty   | `transport`         | `reachability` |
| enrollment                                       | keys returned, none / >1 matches the pin                | `host-key`          | `security`     |
| probe (`classifySshFailure`)                     | ssh not spawned                                         | `transport`         | `local`        |
| probe                                            | `dns`                                                   | `dns`               | `reachability` |
| probe                                            | connect timeout / refused / no route / unreachable      | `transport`         | `reachability` |
| probe                                            | `host-key` (stale or mismatched pin)                    | `host-key`          | `security`     |
| probe                                            | `authentication`                                        | `authentication`    | `security`     |
| probe                                            | `remote-shell`, capacity, workspace root                | unchanged           | `remote`       |
| Mutagen (`pauseSync`, `resumeAndFlush`)          | owned name with foreign endpoint, mode or ignores; duplicate owned name | `sync` | `security` |
| every other step                                 | as today                                                | unchanged           | `remote`       |

Mechanics:

- `src/ssh/probe.ts` gains `failureClassOf(reason, result)` next to `classifySshFailure`;
  `probe()` passes it into the `PreparationError` (`src/app/pilot-services.ts:665-667`, `:690-693`).
- `enrollKnownHost` (`src/ssh/client.ts:195-223`) throws a new exported `HostKeyScanError { reason,
  failureClass }` instead of plain errors; `validate()` rewraps it as a retryable
  `PreparationError(reason, true, { failureClass })`. A keyscan that could not be spawned is
  `local`, matching the ENOENT/EMFILE rule already stated for `spawned`
  (`src/ssh/client.ts:29-39`).
- `src/sync/mutagen.ts` exports `MutagenOwnershipError extends DiagnosableError`, thrown by
  `assertOwnedRecord` and both duplicate-name checks; `pauseSync`/`resumeAndFlush` rewrap it as
  `PreparationError("sync", false, { cause, failureClass: "security" })`. The detail line stays
  diagnosable (`src/run/prepare.ts:79-88`).

### 3.1 Behaviour change on existing profiles

An un-enrolled unreachable host used to report `validation` (a local reason, no outage,
`src/notifications/outage.ts:77`). It now reports `dns`/`transport`, so a `fallback: local`
profile's first-use outage raises the same alert a known host would. Nothing else in the
local-fallback path reads `failureClass`.

## 4. Selection and the one-hop chain (contract 2, 5)

`runProfile` is split into `runProfileLeg(...): Promise<LegResult>` and the existing
`runProfile` wrapper (returns `status`, keeps every current caller and test):

```ts
export type LegResult =
  | { readonly kind: "exit"; readonly status: number }
  | { readonly kind: "failover"; readonly reason: string };
```

A leg returns `failover` only when all hold:

1. the profile's `fallback` is a profile id and the effective mode is not `local`;
2. preparation failed after its retries with `failureClass === "reachability"`
   (`src/run/run-profile.ts:104-116` — the retry already re-probes once);
3. `startRemote` was never called.

Everything else takes today's path. For a remote-fallback profile `mayFallback` is false
(`src/run/run-profile.ts:90-92`), so a non-reachability failure fails closed with exit 75 and
alerts. There is no failover from any `startRemote` outcome (§12 D3): transport loss before the
start acknowledgement is `connection-lost` (`src/app/pilot-services.ts:1020-1025`), already treated
as possibly started (`src/run/run-profile.ts:153`); after it the run completes with 75
(`src/app/pilot-services.ts:1047-1057`).

The orchestrator `executeRequested(P, F, command, mode)` lives in
`src/app/default-dependencies.ts` beside `executeProfile` (`:574-689`):

```
mode local                → leg(P, local)
select = v2.selectPrimary → skip P (fresh negative cache or another holder's probe lease)
                               → leg(F, mode, requested P)
                            else leg(P, mode, failover on)
                               failover(reason) → v2.observeUnreachable(reason); leg(F, mode, requested P)
                               exit(status)     → status
```

`leg(F, …)` is today's `runProfile` for F. F cannot name a remote fallback (§2), so the chain is one
remote hop by construction: F unreachable → F's own `fallback: local` under `auto`
(`src/run/run-profile.ts:90-92`), fail-closed 75 under `--mode remote`. `--mode remote` therefore
permits the remote hop and forbids the local one.

**Command.** An explicit `-- <command>` carries over to F. Without one, each leg runs its own
profile's `workload.command` ("fully as that profile", §12 D1).

**Controller repair** (`src/cli.ts:424-436`) keeps continuing on failure when the chain can end
locally: `auto` and (`fallback: local`, or a remote fallback whose own fallback is `local`).

## 5. Runtime per selected leg (contract 4)

Each leg builds its own `NodeProfileServices`, telemetry, notifier and log root from the leg's
profile — which is what `executeWorkload` already does per call (`src/app/default-dependencies.ts:512-572`).
Two changes:

- **P's leg** (the requested primary with a remote fallback) wires its notifier to the v2
  transition context (§6) instead of the per-identity v1 file: `recordFallback`/`recordOutage` →
  `v2.observeRefused(class, reason)`, `recordRemoteChildStarted` → `v2.observePrimaryChildStarted`.
  `recordOutage` (`src/app/pilot-services.ts:1155-1160`) and `ProfileExecutionServices.recordOutage`
  gain an optional `failureClass`; `createProfileRuntime` keeps the class next to
  `pendingFallbackReason` (`src/app/profile-runtime.ts:48`, `:60-61`, `:132-136`).
- **F's leg** is a plain profile: v1 notifier at F's own identity path, unchanged. F's child start
  sends F's v1 recovery if F had one; it never touches v2. **A fallback child start is not a
  primary recovery.**

**Run log.** Every record gains `requested` and `selected`. A leg writes into its own profile root
(`src/app/default-dependencies.ts:580-588`), so a failover run leaves `run-start … run-unavailable …
run-failover {to: F, reason}` in P's log and `run-start … run-finish` in F's log under the same
`runId`. `run-failover` is a new event; corpus summaries only count `run-finish`
(`src/diagnostics/corpus.ts:179`, `:190`), so it adds no double count.

## 6. Outage state v2 (contract 7)

**Location.** `~/.local/state/remote-runner/fallback/<consumer>/<primary>/state.json`, lock at
`…/<primary>/lock` (plus the lock protocol's sibling artefacts). Not under `profiles/`: the corpus
walk treats every directory under `profiles/<consumer>/<profile>/` as an identity
(`src/diagnostics/corpus.ts:127-137`).

**Schema.**

```json
{
  "schemaVersion": 2,
  "consumer": "ariadne",
  "primary": "verify-full-pop-os",
  "outage": { "reason": "transport", "since": "2026-09-29T10:00:00.000Z" },
  "refusal": null,
  "negative": { "checkedAt": "2026-09-29T10:00:00.000Z", "ttlMs": 60000 },
  "lease": null,
  "lastRecoveryAt": null,
  "queue": []
}
```

- `outage`: `{reason, since}` | `null` — the primary is down and runs go to the fallback.
- `refusal`: `{class, reason, since}` | `null` — the primary fails closed for a `security`, `local`
  or `remote` reason.
- `negative`: `{checkedAt, ttlMs}` | `null` — negative reachability cache.
- `lease`: `{takenAt, ttlMs}` | `null` — one run's right to re-probe an expired negative entry.
- `queue`: ≤64 `FallbackEvent`s, the same bound as v1 (`src/notifications/outage.ts:36`).

`FallbackEvent = { kind: "failover" | "recovery" | "refused", consumer, requested, fallback,
remoteLabel, class, reason, timestamp }`; `fallback` is F's id, `remoteLabel` is P's.
`validateEvent`/`FIELD` rules (`src/notifications/outage.ts:37`, `:88-97`) apply field-wise;
`telegram.ts` `eventMessage` (`src/notifications/telegram.ts:85-105`) gains one branch per kind:
`Primary remote unreachable — running on <fallback>`, `Primary remote recovered — child started`,
`Remote run refused — <class>`.

**Transitions** (pure functions in `src/notifications/outage.ts`, beside v1, reusing `deliver`,
`stableReason`, `isOutageReason`):

| Function                       | Effect                                                                                         | Message                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `selectPrimary(now)`           | fresh `negative` → skip; expired and no live lease → take lease, use P; live lease → skip       | none                                           |
| `observeUnreachable(reason)`   | set `negative` (TTL rule below), clear `lease`; if `outage` null → set it                       | `failover`, once per outage                    |
| `observeReachable()`           | clear `negative` and `lease` (probe of P succeeded); `outage` stays                             | none                                           |
| `observeRefused(class, reason)`| `class !== "remote"` or `isOutageReason(reason)`; if `refusal` differs in (class, reason) → set it | `refused`, once per (class, reason) episode, **regardless of `outage`** |
| `observePrimaryChildStarted()` | if `outage` or `refusal` → clear both, clear `negative`, set `lastRecoveryAt`                    | `recovery`, once                               |

A `security` refusal is never suppressed by an active transport outage: the two fields are
independent.

**Serialization.** Each transition runs inside `withLock`: acquire → read → validate → transition →
write (atomic rename, as today, `src/node/notifications.ts:130-135`) → deliver → release. The lock is
`acquireProfileLock` (`src/runtime/lock.ts:303-396`) with `lockDirectory = () => <dir>/lock`, the
node `LockFileSystem` adapter moved out of `NodeProfileServices.acquireLock`
(`src/app/pilot-services.ts:601-624`) into `src/node/lock-files.ts`, wait budget 30 s, lease 120 s.
Delivery under the lock sends at most 4 queued events (each capped by the 5 s Telegram timeout,
`src/notifications/telegram.ts:5`); the remainder stays queued for the next holder. On
`LockTimeoutError`, `selectPrimary` falls back to a lock-free read of the atomically written file
without taking a lease, and a transition is skipped with the stderr line `remote-runner: fallback
state busy` — skipping can lose nothing that the next observer will not observe again, and it can
never duplicate a message.

**Negative-cache TTL and flap limit.** `ttlMs` starts at 60 s, doubles on each consecutive
`observeUnreachable` while `outage` is set, and is capped at 10 min. A new outage within 15 min of
`lastRecoveryAt` starts from the previous doubled TTL instead of 60 s, so a flapping primary backs
off exponentially instead of emitting a pair per minute. Every transition still sends exactly one
message; the rate limit bounds transitions, not messages. The lease TTL is 60 s.

**Clock rule.** Timestamps are wall-clock ISO strings, because separate processes share no
monotonic clock. An entry is fresh only when `checkedAt <= now < checkedAt + min(ttlMs, 10 min)`
(same for `lease`). A backward clock step makes `now < checkedAt` and therefore expires the entry; a
forward step expires it early. Either way the cache errs towards probing P, never towards skipping
it indefinitely.

**Probe cost.** Across ~20 worktrees at most one run probes P per TTL window (the lease holder);
all others go straight to F. A holder that crashes loses its lease after 60 s.

**v1 reset.** On the first v2 access for (consumer, P), under the v2 lock, every
`profiles/<consumer>/<P>/<identity>/outage.json` is renamed to `outage.v1-retired.json` and the
count is written to stderr. Their queued events are not delivered: they belong to a profile that no
longer owns its outage channel (§12 D7). v1 files of every other profile — F included — are
untouched and keep working.

**Status.** `status <P>` reads `outage=` from v2 for a remote-fallback profile
(`src/app/default-dependencies.ts:734`, `:306-317`) and appends `fallback=active(<F>)|inactive`.

## 7. Reserved child markers (contract 6)

Every workload child gets two runner-owned markers, set last:

| Leg           | `REMOTE_RUNNER_SELECTED_PROFILE` | `REMOTE_RUNNER_REMOTE_LABEL` |
| ------------- | -------------------------------- | ---------------------------- |
| remote        | leg profile id                   | leg profile `remote.label`   |
| local         | leg profile id                   | `""` (shadows an inherited value, since the local env merges `process.env`, `src/node/process.ts:8`) |

- Remote: appended after `REMOTE_RUNNER_PROVIDER=remote` in `remoteChildArguments`
  (`src/app/pilot-services.ts:184-186`); the launcher re-applies both names from its own env after
  the secret merge (`assets/remote-launcher.mjs:154`), so they sit after secrets there too.
- Local: spread after `...secrets` (`src/app/pilot-services.ts:1116-1121`).
- Secrets cannot carry the names in the first place (§2), so the ordering is defence in depth.
- Setup and ensure commands do not receive them (§12 D11).

## 8. `resolve` (contract 8)

`remote-runner resolve <profile> [--manifest <path>] --json`. `--json` is required, since the JSON
is the only output. Mode comes from `REMOTE_RUNNER_MODE` or the profile, as for `run`
(`src/cli.ts:384-393`).

Algorithm, using the same services and cache as `run` but only `validate()` + `probe()` — no lock,
no `pauseSync`, so no Mutagen session is created:

1. mode `local` → `{selected: P, remoteLabel: null, fallbackActive: false, reason: "mode-local"}`, exit 0.
2. P has a remote fallback: `selectPrimary`; if P is not skipped, check P. Reachable →
   `observeReachable`, answer P. `reachability` → `observeUnreachable` (sends the failover message
   if this is the transition), continue with F. `security`/`local`/`remote` → `observeRefused`,
   answer the refusal.
3. Check F (or P, for a profile without a remote fallback). Reachable → answer it. Unreachable →
   its own `fallback: local` under `auto` → `{selected: <it>, remoteLabel: null, fallbackActive:
   true}`, exit 0; otherwise nothing is reachable.

Output: `{"requested","selected","remoteLabel","fallbackActive","reason","checkedAt"}` on stdout for
exit 0, 3 and 4; `selected`/`remoteLabel` are `null` when nothing is selected, `reason` is `null`
when the requested profile was selected remotely, and `checkedAt` is when the deciding reachability
fact was established (probe time or the cache entry's `checkedAt`).

| Exit | Meaning (resolve)                                                                   | Existing meaning elsewhere          |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| 0    | a selection exists (remote or local end of the chain)                               | success                             |
| 2    | usage, manifest or unknown profile                                                  | same                                |
| 3    | nothing runnable: every hop unreachable, or a `remote`-class refusal; `run` would exit 75 before starting | unused                   |
| 4    | security refusal (`host-key`, `authentication`, Mutagen ownership); alert raised     | unused                              |
| 70   | runtime error, including a `local`-class fault (ssh/ssh-keyscan missing, EMFILE)    | runtime unavailable / threw         |

`1`, `64`, `75` and `127` are never returned by `resolve`. `resolve` is not a workload, so its codes
cannot collide with a workload's. `run`'s table is unchanged. The internal 74–79 remote snippet codes
(`README.md:126-127`) stay internal.

The answer is advisory: P can fall over between `resolve` and `run`. The child learns the truth
from `REMOTE_RUNNER_SELECTED_PROFILE`.

## 9. `prewarm` (contract 9)

The queue key stays the requested profile (`src/prewarm/queue.ts:78-87`); the controller replays
`run <P> --mode remote` (`src/main.ts:113`), which goes through `executeRequested`, so the profile
selected at execution time is the one prewarmed — F while P is down, and never the local leg.
`status <P>` keeps reporting that request's `prewarm=` state.

## 10. Rollback (contract 10)

0.1.0 cannot read the new manifest: `fallback` is a closed `oneOf(["local", "fail"])`
(`src/config/load-manifest.ts:278`), so a manifest that names `fallback: verify-full` fails to load
for **every** profile in it — `run verify-full` would exit 2 as well.

1. **Drain.** Stop dispatching remote-fallback profiles; wait for `status` to show no
   `prewarm=queued|running` for any profile of the consumer, and no workload in flight
   (`remote-runner logs <profile>` shows a `run-finish` for every `run-start`).
2. **Consumer reverts first.** Ariadne removes `verify-full-pop-os` (or sets its `fallback` to
   `local`/`fail`) and commits, so no manifest names a profile id as `fallback`.
3. **Reinstall** the accepted old revision: `git checkout <accepted-sha> && pnpm install && pnpm verify
   && node dist/src/main.js install`; confirm with `remote-runner install --check`. The launcher
   asset reinstalls itself on the next run by digest (`src/app/pilot-services.ts:801-815`).
4. **Reconcile v2 state.** Old code never reads `fallback/`. Read
   `~/.local/state/remote-runner/fallback/<consumer>/<primary>/state.json`; if its `queue` is
   non-empty, relay the undelivered events by hand, then delete that directory. Retired
   `outage.v1-retired.json` files may be deleted; old code starts a fresh v1 file where needed.
5. `verify-full`'s Mutagen sessions were never renamed and need no action. Sessions named
   `remote-runner-<consumer>-<P>-<identity>` for the removed primary are terminated with
   `mutagen sync terminate <name>` after checking their endpoints.

## 11. Documentation (contract 11)

README gains `resolve` under "Consumer commands", the `fallback` grammar, the resolve exit table and
a rollback pointer. The operator guide gains "Remote fallback" (semantics, v2 state, classes, the two
markers) and "Rollback from remote fallback" (§10). No reason is added to `NOTIFICATION_REASONS`,
so the reason-index test (`tests/unit/operations-guide.test.ts:21-34`) needs no new row.

## 12. Decisions and open questions

- **D1 — command on the fallback leg.** Without `--`, F runs F's own `workload.command`; an explicit
  override carries over. The alternative, P's command on F's host, contradicts "fully as that
  profile". **Open:** confirm Ariadne either passes `--` or keeps the two commands identical.
- **D2 — manifest narrowing.** The fallback target must share `consumer` (the v2 key and the mirror
  namespace), and the profile ids `local`/`fail` are reserved to keep the keyword unambiguous.
  Neither is in the contract; both reject nothing Ariadne has.
- **D3 — no failover once `startRemote` is called.** The contract allows a failover when non-start is
  *positively proven*. The only such proof available is a connect-phase ssh stderr before the
  marker; it is not built. Consequence: a primary that dies in the seconds between probe and child
  start costs one 75 instead of a failover.
- **D4 — mid-preparation loss.** After a successful probe, a transport drop during workspace or
  sync is untyped (`remote`), so the run fails closed (75, alert) rather than falling over. Typing
  every remote step would be a much larger change; the negative cache sends the next run to F anyway.
- **D5 — first-use reason change** on `fallback: local` profiles (§3.1).
- **D6 — security repeats.** "Always delivered" is implemented as: never suppressed by a transport
  outage, one message per (class, reason) episode, the episode ending at the next primary child
  start. Delivering every occurrence would page ~20 times per stale pin. **Open:** confirm.
- **D7 — v1 reset.** Pending v1 events of a profile switched to a remote fallback are retired, not
  delivered; an outage announced under v1 then gets no recovery message. Ariadne's primary is new,
  so none exist today.
- **D8 — benchmark never fails over** and does not write v2 state: it measures the profile named,
  so a remote sample on another host would be mislabelled. A benchmark of P with P down exits 75
  and writes its reason to stderr/log only.
- **D9 — prewarm selects at execution time** (§9), not at enqueue.
- **D10 — `resolve` also answers plain profiles and mode `local`**; it needs no v2 state for them.
- **D11 — markers only on the workload child**, not on setup/ensure commands.
- **D12 — lock timeout degrades to a lock-free read** (§6); the transition is skipped, never guessed.
- **D13 — Mutagen mode/ignore/duplicate mismatches are `security` too**, not only the endpoint
  mismatch: each is a session under the owned name this run did not create.
- **D14 — `local`-class faults exit 70 from `resolve`**, sharing "runtime unavailable" instead of
  taking a third new code.

**Judged unsound as literally worded:** contract 7's "flap rate-limit" read as message suppression
would contradict "exactly one down and one recovery message per transition". This design rate-limits
transitions (TTL back-off), not messages.
