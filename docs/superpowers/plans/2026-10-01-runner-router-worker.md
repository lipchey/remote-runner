# Runner router Worker — implementation plan

Status: Gate P (Codex) and Fable consult done 2026-10-01, findings folded in
(§8). Owner of the design: Ariadne
`docs/plans/2026-10-01-runner-label-fallback-controller-plan.md` §2, §3, §4
`runner-router-worker`, §5 — read it first; this file only decides HOW. Lands in
this repo as `docs/superpowers/plans/2026-10-01-runner-router-worker.md` with
the package PR.

## 0. Facts this plan rests on (verified 2026-10-01)

- Canaries (Ariadne `docs/plans/evidence/2026-10-01-runner-label-flip-canaries.md`):
  a queued job starts on a runner 80–124 s after its label is added, no re-run;
  removing the label never kills a running job and stops the next pickup;
  gracefully stopped PC runners stay `online` in REST 50–67 s.
- Runners: PC `popos-1..3` (systemd user units `gh-runner-1..3` on `admin@pop-os`),
  laptop `ariadne-runner-1` (Linux host `ariadne-runner`). Today PC runners carry
  `popos`; the laptop carries only `self-hosted, Linux, X64`. Nobody carries
  `ci-active` yet. The Mac watcher `~/Scripts/ci-runner-watch.sh` re-registers a
  deleted PC runner with `--labels popos` only and removes `.runner` while doing so.
- Ariadne SOPS vault holds (names only): `GITHUB_APP_RUNNER_ROUTER_ID`,
  `GITHUB_APP_RUNNER_ROUTER_INSTALLATION_ID`, `GITHUB_APP_RUNNER_ROUTER_PRIVATE_KEY_B64`,
  `CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID`, `CLOUDFLARE_REMOTE_RUNNER_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. `wrangler whoami` with the router
  token lists exactly one account — the new one.
- This repo: single root package (`pnpm-workspace.yaml` = `packages: ["."]`),
  `pnpm verify` is the local gate, no CI, no commit hooks; tests use hand-written
  `Fake*` ports, no `vi.mock`. Root tsconfig/vitest/eslint globs cover only
  `src/**`, `tests/**`. README "Install once" (`README.md:11`) and the stale-install
  hint (`src/main.ts:84`) run an unfiltered `pnpm install`. Installed-CLI identity
  hashes root `package.json` (`src/node/local-install.ts:286`).

## 1. Package shape

`packages/runner-router/` — own `package.json` (`@remote-runner/runner-router`,
private), `tsconfig.json` (`@cloudflare/workers-types`), `vitest.config.ts`
(node env), `wrangler.toml`. Workspace: `packages: [".", "packages/*"]`.
Root `verify` gains `pnpm --filter @remote-runner/runner-router verify`; root
eslint globs widen to the package's `src/**`/`tests/**`.

wrangler stays out of the CLI install: README "Install once" and the
`src/main.ts:84` hint become `pnpm install --filter remote-runner` (CLI only);
a full `pnpm install` is documented as the development path that also installs
the Worker toolchain. One-time install-drift warning from the root
`package.json`/lockfile change is expected.

```
packages/runner-router/
  src/index.ts          fetch (POST /heartbeat) + scheduled (cron) → DO stub
  src/router-object.ts  Durable Object shell, wires ports to RouterCore
  src/core.ts           RouterCore: reconcile, mutex, deadline, alarm planning, outbox
  src/decide.ts         pure decision
  src/heartbeat.ts      report schema + acceptance rules (pure)
  src/github.ts         App JWT (WebCrypto RS256), token cache, roster, label add/remove/re-read
  src/telegram.ts       sendMessage
  src/config.ts         parse vars once, fail closed
  pc/heartbeat.sh, pc/runner-router-heartbeat.{service,timer}, pc/heartbeat.env.example
  scripts/put-secrets.mjs   owner-run on Mac
  tests/…               mirror src/; tests/pc/ for the shell script
```

No code shared with the CLI (Telegram send is ~20 lines; the CLI loader is
file/uid based).

`wrangler.toml`: `main = "src/index.ts"`, DO binding `ROUTER` → class
`RouterObject`, `[[migrations]] tag = "v1", new_sqlite_classes = ["RouterObject"]`,
`[triggers] crons = ["* * * * *"]`, `workers_dev = true`, `vars` below. No
`account_id` in the file — it comes from the deploy env.

## 2. Configuration

`vars` (never secret): `REPO=lipchey/ariadne`,
`PC_RUNNERS=popos-1,popos-2,popos-3`, `LAPTOP_RUNNER=ariadne-runner-1`,
`LAPTOP_ADMISSION_LABELS=ci-active` (cutover sets `ci-active,popos`, later back
to `ci-active`). PC health always checks `ci-active` — the owner decided
2026-10-01 to add `ci-active` to the PC runners before the shadow run (§6 step 3),
so the shadow run exercises the production predicate and no phase-dependent PC
label exists. Config parsing rejects any laptop label outside `{ci-active, popos}`
and a laptop name equal to a PC name. Mutations are allowed only for those labels
on the registration named `LAPTOP_RUNNER`.

Secrets: `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`
(PEM; PKCS#1 wrapped to PKCS#8 in code), `HEARTBEAT_SECRET`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (default: the same bot and chat as the
watcher). `HEARTBEAT_SECRET` = 32 random bytes hex, generated at install, stored
on the Worker and in the PC's `~/.config/runner-router/heartbeat.env` (0600) —
not in the vault; rotation = regenerate both.

## 3. Heartbeat

**Sender** (`pc/heartbeat.sh`, bash + curl, no jq). Timer:
`OnCalendar=*-*-* *:*:00/10`, `AccuracySec=1s`, `Persistent=false` — a wall-clock
cadence; `OnUnitActiveSec` on a oneshot counts from activation end and would
stretch to 10 s + runtime. Service: `Type=oneshot`, `TimeoutStartSec=8s`.
`heartbeat.env` carries `ROUTER_URL`, `HEARTBEAT_SECRET` and a static map
`RUNNERS="gh-runner-1:popos-1 gh-runner-2:popos-2 gh-runner-3:popos-3"` (not
`.runner`: the watcher deletes it mid re-registration). Per unit:
- `ActiveState` via `systemctl --user show -p ActiveState --value`;
- listener: a `Runner.Listener` process in the unit's cgroup
  (`ControlGroup` → `$CGROUP_ROOT/<cg>/cgroup.procs` → `$PROC_ROOT/<pid>/comm`);
- any missing file/process/command for one unit → that runner reports
  `listener:false` / its real state; the script still sends the report.
`CGROUP_ROOT`/`PROC_ROOT` default to `/sys/fs/cgroup` and `/proc`; tests point
them at fixtures.
One GitHub probe: `curl -sS -o /dev/null -m 2 --retry 1 --retry-max-time 4
https://broker.actions.githubusercontent.com/` — success = any HTTP response.
POST `-m 3`. Probe + POST stay under the 8 s service timeout.
Counter: `next = max(last + 1, now_ms)` persisted in
`~/.local/state/runner-router/counter`.

**Wire** `POST /heartbeat`, `Authorization: Bearer <HEARTBEAT_SECRET>`, body ≤ 4 KiB:
```json
{"v":1,"counter":1759300000123,"sentAt":1759300000123,"githubProbe":true,
 "runners":[{"name":"popos-1","unit":"active","listener":true}, …]}
```
Bearer compare: constant-time xor loop over UTF-8 bytes (`timingSafeEqual` is
Workers-only and absent in node tests); length mismatch → reject.

**Acceptance** (`heartbeat.ts`, pure). Parse and validate the body before the
first storage read; then get → decide → single put with no foreign await in
between, so two reports cannot interleave on `hb` (DO input gates).
Reject with 4xx, logging and storing `lastRejected = {at, reason}`, when: schema
mismatch (unknown keys, wrong types, `v≠1`, empty/duplicate runners); a `name`
∉ `PC_RUNNERS`; `counter ≤ hb.counter`; `sentAt` outside `now ± 10 s`.
Accepted → `hb = {report, counter, acceptedAt: now, reportHealthySince}` where
`reportHealthySince` is null if the report has no runner with
`unit=="active" && listener && githubProbe`; otherwise the previous
`reportHealthySince` when the previous lease was still valid at `now` and it was
non-null, else `now`. This records an unhealthy report and a lease gap even if
the next report overwrites it before any reconcile. Then request a reconcile
(§4). Heartbeat acceptance never takes the reconcile mutex.

## 4. Durable Object state and reconcile

One DO (`idFromName("ariadne")`), SQLite-backed. Keys: `hb` (above), `ctl`,
`outbox` (Telegram, cap 64, oldest dropped and counted), `wake` (pending
reconcile request: timestamp).

`ctl`: `createdAt`, `applied: "on"|"off"|null`, `healthySince|null`,
`lastKnownEvalAt|null`, `unknownSince|null`, `retryAt|null`,
`cooldownUntil|null`, `alerts` episode flags (`laptopMissing`, `unknown`,
`noHeartbeat`), `token` (installation token + expiry). `createdAt` is set on the
first touch, so cold start has a no-heartbeat anchor.

**Request reconcile** (heartbeat, cron): `put("wake", now)`; if no alarm or the
alarm is later than now → `setAlarm(now)`. Skipped while `now < cooldownUntil`
(heartbeat only; cron and the alarm still run and honor the cooldown inside).

**Reconcile** — serialized by an in-DO promise-chain mutex (not
`blockConcurrencyWhile`, which would stall heartbeats). One shared deadline:
`AbortSignal.timeout(15 s)` passed to every fetch, each fetch also
`AbortSignal.any([deadline, timeout(5 s)])`, and checked before starting any new
GitHub call; the mutex is released only after the pass settles.
1. `passStart = now`, read `wake`, `ctl`. If `now < cooldownUntil` → unknown.
2. Roster: installation token from cache (refresh at expiry − 5 min; JWT
   `iat = now − 60 s`, `exp = now + 9 min`); on 401 clear the token and refresh
   once. Paginate `per_page=100` via `Link`; complete iff pages exhausted and
   `count == total_count`. 403/429 with `retry-after` or
   `x-ratelimit-remaining: 0` → `cooldownUntil` from the header (≥ 60 s), unknown.
   Any other failure/timeout/incomplete → unknown, `retryAt = now + 10 s`.
3. Re-read `hb` and `now` AFTER the roster (external awaits interleave and the
   Worker clock advances after I/O). `decide()`:
   - per PC runner N: healthy iff `hb.report` has N with `unit=="active"`,
     `listener`, `githubProbe`, **and** the snapshot has the registration named
     N `status=="online"` with label `ci-active`. Busy is healthy. Report N pairs
     only with registration N.
   - `leaseOk = hb && now < hb.acceptedAt + 30 s` (boundary is expired).
   - `pcHealthy = leaseOk && ≥1 healthy N`.
   - `healthySince`: null unless `pcHealthy`; else
     `max(ctl.healthySince ?? now, hb.reportHealthySince)`, reset to `now` when
     `lastKnownEvalAt` is older than 90 s (cron/alarm starvation).
     `lastKnownEvalAt = now` on every known verdict.
   - desired = `on` if `!pcHealthy`; `off` if `now − healthySince ≥ 120 s`;
     else `applied ?? on`.
   - unknown → no mutation, keep `applied`, `healthySince = null`,
     `unknownSince ??= now`.
4. Mutate when the laptop's actual admission labels ≠ desired (level-triggered,
   so a re-registered laptop is repaired next pass). Add missing labels in one
   `POST …/labels`; remove each extra with `DELETE …/labels/{name}`, 404 =
   already absent. Before any removal, re-read `hb` and `now` and re-check
   `desired == off`; otherwise abort removal. Then `GET …/runners/{id}`;
   `applied` is set from this re-read, not from mutation responses. Laptop
   absent → alert, no mutation. Mutation error → as unknown for this pass.
5. One atomic `put({ctl, outbox})`: new `ctl`, plus queued messages — one per
   change of `applied`, and alert episodes (once each, cleared on recovery):
   laptop `offline`/absent; unknown ≥ 3 min; no accepted heartbeat for 5 min
   since `hb?.acceptedAt ?? ctl.createdAt` (message includes `lastRejected` if
   any).
6. Release the mutex, then flush the outbox outside the 15 s budget: ≤ 5
   messages per pass, 5 s each, stop at first failure, delete each after `ok`.
7. Alarm, in `finally` on every path: if `wake > passStart` (a heartbeat landed
   during the pass) → now; else min of future deadlines — lease expiry (when
   `pcHealthy`), `healthySince + 120 s` (when `off` is pending), `retryAt`,
   `cooldownUntil`, `unknownSince + 3 min`, no-heartbeat anchor + 5 min, outbox
   retry (+30 s) — capped at `now + 60 s`.

Expected consequence: after a Worker outage the lease is expired, so the first
pass turns the laptop ON and returns OFF 120 s after health resumes (Ariadne
plan §3 bias). While the Worker runs, any hand-added laptop admission label is
reverted within ~10 s; manual override = stop the Worker (§6 rollback).

## 5. Tests (vitest, node env; `RouterCore` takes `now()`, storage, GitHub,
Telegram and alarm ports as `Fake*` classes)

Ariadne plan §4 acceptance, one named test each:
1. `expiresAt` boundary: `now == acceptedAt + 30 s` is expired → ON.
2. Late alarm (40 s after its deadline) decides on the current `now` → ON.
3. ON on lease expiry with an otherwise healthy roster.
4. OFF only after 120 s continuous health (119 s → stays ON; 120 s → OFF).
5. Countdown reset on unknown, on a lease gap, on an unhealthy report later
   overwritten by a healthy one, and on a > 90 s evaluation gap.
6. Unknown never mutates (roster error, timeout, incomplete pagination, token
   failure, 401 twice, 429 cooldown).
7. All PC runners busy and healthy → no ON.
8. No health borrowing: report healthy only for popos-1, snapshot online only
   for popos-2 → ON.
9. Concurrent reconciles serialize: overlapping calls never interleave GitHub
   mutations.
10. Exhausted retries keep the deadline: a pass that throws leaves the alarm at
    the earliest pending deadline.
11. Cold start: empty storage → ON (roster known); + unknown → no mutation; no
    heartbeat ever → alert at `createdAt + 5 min`, also across an object restart.
12. Laptop re-registered during fallback (new id, labels reset) → labels re-added.
13. Heartbeat rejection: schema, unknown name, counter ≤ last, stale and future
    `sentAt`; each leaves `hb` untouched and records `lastRejected`.
Plus the race and robustness tests from review:
- heartbeat accepted during the roster await → second pass runs immediately
  (`wake` beats the step-7 alarm);
- lease expires during the roster await → no OFF; unhealthy report lands before
  removal → removal aborted;
- partial removal (`ci-active` 204, `popos` 500) then retry with `ci-active` 404 →
  converges; lost POST response → re-read sets `applied` and one transition message;
- 15 s deadline cancels a hung pagination; outbox backlog never delays the mutation;
- `put({ctl, outbox})` atomic: injected failure leaves both unchanged;
- PKCS#1→PKCS#8 wrap imports via WebCrypto; out-of-allowlist label mutation throws;
  config rejects unsafe labels/names; constant-time compare.
`tests/pc/heartbeat.test.ts` runs `pc/heartbeat.sh` under bash with stub
`systemctl`/`curl` on PATH and `CGROUP_ROOT`/`PROC_ROOT` fixtures (works on the
Mac): all healthy; one unit failed; listener missing; cgroup file vanished;
probe failure; counter persistence and lost counter file.

## 6. Delivery and external writes

Worktree `/Users/admin/Projects/worktrees/remote-runner-runner-router-worker`,
branch `feat/runner-router-worker` from `origin/main`. Copy this plan to
`docs/superpowers/plans/2026-10-01-runner-router-worker.md` as the first commit.
One PR: package + plan doc + README section (install split, deploy, rollback).
`pnpm verify` green, Gate C (codex-chain) before commit, merge after review.

External writes, each a separate owner-approved step (auto mode may block —
then hand the owner the exact command):
1. `scripts/put-secrets.mjs` (from merged `main`): reads each allowlisted key with
   `sops -d --extract '["KEY"]'` (verify on the vault that `--extract` works for
   the dotenv store; if not, decrypt in-process and keep only the allowlist —
   no child ever receives a non-allowlisted value), adds a fresh
   `HEARTBEAT_SECRET`, pipes one JSON object to `wrangler secret bulk` on stdin.
   wrangler's env carries only `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
   from the `CLOUDFLARE_REMOTE_RUNNER_*` keys. Writes `HEARTBEAT_SECRET` to a
   0600 file on the Mac for step 4; prints names only.
2. `wrangler deploy` with the same minimal env (first deploy may ask the owner
   to register the account's workers.dev subdomain). Smoke: an unauthenticated
   `POST /heartbeat` → 401; `wrangler tail` shows a cron pass with a known roster.
3. REST: add `ci-active` to `popos-1..3` (owner decision 2026-10-01; no workflow
   requests it yet, routing unchanged). A watcher re-registration during shadow
   drops it → the Worker flips the laptop's harmless label and alerts.
4. PC: copy `pc/*` to `~/.config/systemd/user/` and `~/.local/bin/`, write
   `heartbeat.env` (0600), `systemctl --user enable --now
   runner-router-heartbeat.timer`.
5. Live shadow run (only `ci-active` on the laptop changes). Mac observer polls
   REST every 5 s as in the canaries; the Worker logs each transition with its
   clock. Scenarios and targets: Ariadne plan §3 and §4 acceptance (death → label
   ≤ 45 s; death → job start ≤ 180 s, hard limit < 5 min; OFF ≥ 120 s
   continuous). Job-start timing via a draft canary PR
   `runs-on: [self-hosted, ci-active]` — but PC runners now carry `ci-active`
   too, so the canary measures fallback only while the PC is down; repeat
   canaries 1 and 2 through the Worker. Power-off and network-cut only when the
   owner performs them.
6. Evidence file in Ariadne `docs/plans/evidence/` + plan §4 and readiness row
   update, own Ariadne PR.

**Rollback / stop** (README): disable the PC timer
(`systemctl --user disable --now runner-router-heartbeat.timer`), `wrangler
delete` (removes cron, alarms stop with the class), then remove `ci-active` from
the laptop via REST. PC `ci-active` labels may stay (unrequested until cutover).

## 7. Open questions

- PC layout (cgroup per unit with `Runner.Listener`, unit names `gh-runner-N`):
  verify read-only over SSH before writing fixtures.

## 8. Review record (2026-10-01)

Codex Gate P (13 findings) and Fable (facets a–e) folded in: post-I/O re-read
and pre-removal re-check; `reportHealthySince` at acceptance; durable `wake`
against alarm overwrite; DELETE 404 rule and re-read-derived `applied`; retry,
401 refresh and 403/429 cooldown; atomic `ctl`+`outbox`; shared 15 s deadline
with the outbox flushed outside it; `createdAt` no-heartbeat anchor; filtered
CLI install; static unit map and fixture-driven script tests; `wrangler.toml`
provisioning and rollback; per-key secret extraction with `secret bulk`;
wall-clock timer; `lastRejected` surfaced; probe retry; PC `ci-active` before
shadow (owner, option a). Rejected: dropping Gate C (global rule requires it).
