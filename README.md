# remote-runner

Automatic execution of repository-defined workloads on a trusted remote workstation. The package
owns synchronization, native remote setup, fallback, Telegram outage/recovery notifications,
diagnostics, prewarming, and benchmark collection. Consumer repositories provide only a
closed `.remote-runner.yaml` manifest and a thin call to the installed executable.

## Install once

```sh
pnpm install --filter remote-runner
pnpm build
node dist/src/main.js install
remote-runner --version
git config core.hooksPath .githooks
```

The first installation, and the first upgrade from a runner that predates checkout-selected
installs, must use the built `node dist/src/main.js install` entry point. Later upgrades may run
`remote-runner install` from a built checkout. The installer hashes that checkout, publishes an
immutable self-contained application plus a closed receipt, and updates the stable
`~/.local/bin/remote-runner` command and login LaunchAgent. `remote-runner --version` reports the
installed package version and immutable application identity. That one installation is shared by
every consumer project; projects do not copy or link runner source files into their repositories.

Install version 0.2.0 on the workstation before any consumer manifest first names a profile id in
`fallback`. Version 0.1.0 rejects that whole manifest, including otherwise unchanged profiles.

Merging upstream does not upgrade that installation. `remote-runner install --check` compares the
application identity of the command consumers actually resolve with the identity the current
checkout builds, writes nothing, and exits 1 when they differ. Invoke it through the installed
`remote-runner`: a build writes no receipt into `dist`, so `node dist/src/main.js install --check`
has no installed identity to read and exits 70. Either invocation rejects a `dist/src` older than
`src` rather than answering from an unbuilt tree, so run `pnpm build` first — a stale `dist` would
otherwise report `current` for the very drift being looked for. So does `install` itself, which can
therefore never publish a previous build under the current checkout's name.

The identity is exact because `pnpm build` clears `dist` first — `tsc` leaves the compiled output of
deleted sources behind, so an unclean `dist` both drifts the identity and ships dead files into the
published application.

The `core.hooksPath` line above runs that comparison after a merge or a branch checkout that leaves
the clone on `main` and changed `src`, `tsconfig.json`, `package.json` or the lockfile; it rebuilds
first and warns, never installs. Arrivals through other routes (`git fetch && git reset --hard`) run
no hook — check by hand there. Note that `core.hooksPath` replaces `.git/hooks` wholesale: any local
hook already in that clone stops firing once it is set.

## Development

```sh
pnpm install
pnpm format
pnpm format:check
pnpm verify
```

`format` rewrites maintained files to the repository style, while `format:check` is read-only.
`verify` is the required full local gate and runs formatting, typecheck, tests, and build. The
`tests/integration/` tier executes the workspace transaction scripts against real Git, a bare
mirror, linked worktrees, and submodules by routing SSH back through local PATH shims. The shims
provide only the remote-command and non-Linux GNU utility behavior those scripts require; they do
not simulate transport failures or mutual exclusion.

The repository-wide formatting baseline is isolated in `.git-blame-ignore-revs`. To omit it from
local blame output, configure this clone once:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Runner router Worker

The private `@remote-runner/runner-router` package controls laptop admission for
`lipchey/ariadne`. A full `pnpm install` is the development path and installs the Worker
toolchain; `pnpm install --filter remote-runner` installs only the CLI. Root `pnpm verify`
also checks the Worker package. Expect a one-time install-drift warning after the root
package and lockfile change; rebuild and reinstall the CLI with the "Install once" commands.

Deployment and PC installation are separate owner-approved operations. Run the secret
installer on the Mac from merged `main`:

```sh
node packages/runner-router/scripts/put-secrets.mjs
```

It reads only the allowlisted vault keys `GITHUB_APP_RUNNER_ROUTER_ID`,
`GITHUB_APP_RUNNER_ROUTER_INSTALLATION_ID`, `GITHUB_APP_RUNNER_ROUTER_PRIVATE_KEY_B64`,
`CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID`, `CLOUDFLARE_REMOTE_RUNNER_TOKEN`,
`TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. It extracts each key with
`sops -d --input-type dotenv --extract '["KEY"]'`. The sops child receives only `PATH`,
`HOME`, and `SOPS_AGE_KEY_FILE`, which defaults to `~/.config/sops/age/keys.txt`.
It generates `HEARTBEAT_SECRET` from 32 random bytes encoded as hex, pipes one JSON object
to `wrangler secret bulk` on stdin after writing a 0600 candidate file on the Mac,
renames it onto the heartbeat secret file after upload succeeds, and prints names only.
Failed uploads remove the candidate and preserve any existing secret. The GitHub App private key stays in Worker
secrets. The heartbeat secret is stored on the Worker and PC, outside the vault; rotation
regenerates both copies.

Map the two `CLOUDFLARE_REMOTE_RUNNER_*` vault keys to `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, as for secret upload. Deploy from `packages/runner-router`
with those two variables plus `HOME` and `PATH` in Wrangler's environment:

```sh
cd packages/runner-router
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  "$(command -v node)" node_modules/wrangler/bin/wrangler.js deploy
```

The package's `deploy` script also runs `wrangler deploy`. The first deploy may require
registration of the account's workers.dev subdomain.
Smoke-check that an unauthenticated `POST /heartbeat` returns 401 and that
`node packages/runner-router/scripts/logs.mjs --since 15m --event reconcile` (from the
repo root) shows a cron pass with a known roster.

For the PC installation, copy the `pc/` service and timer files to
`~/.config/systemd/user/` and install `pc/heartbeat.sh` as
`~/.local/bin/runner-router-heartbeat.sh` with mode 0755. Create
`~/.config/runner-router/` with mode 0700 and write
`~/.config/runner-router/heartbeat.env` with mode 0600, containing `ROUTER_URL`, the
generated `HEARTBEAT_SECRET`, and the static map
`RUNNERS="gh-runner-1:popos-1 gh-runner-2:popos-2 gh-runner-3:popos-3"`, then run
`systemctl --user daemon-reload` and
`systemctl --user enable --now runner-router-heartbeat.timer`.

The shadow deployment controlled only laptop `ci-active`. The label cutover sets
`LAPTOP_ADMISSION_LABELS=ci-active,popos`, because runs created before it (and their
re-runs) still ask for `popos`. When the compatibility window ends, first return the
variable to `ci-active` and redeploy, then remove `popos` from the laptop via REST and
read it back. The other order fails: the old Worker re-adds `popos` on any ON, and the
narrowed one refuses to touch a label outside its configured set, so it would stay forever.

### Workers Logs

The Worker enables persisted logs with `[observability] enabled = true` and
`head_sampling_rate = 1`, also the default sampling rate. Each successful reconcile
emits one structured record with the heartbeat, PC roster, laptop roster snapshot,
readback, decisions, mutations, and queued alerts. `applied` is the last confirmed
observation of the laptop admission labels; a failed or skipped readback can leave it
unchanged. `laptop` is the roster snapshot and `readback` is the separate post-mutation
observation. Telegram attempts log IDs and outcomes without repeating message text.

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
includes 200,000 log events/day with 3 days retention on Free. Paid includes 20 million
log events/month, then $0.60 per additional million, with 7 days retention. The maximum
log size is 256 KB; larger logs are truncated and marked `$cloudflare.truncated`.
Heartbeat, cron, alarm invocation logs and reconcile records together are estimated at
~40–50k events/day. From 2026-12-01, Workers Logs uses Cloudflare Observability pricing;
see [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

The reader needs the account permission **Workers Observability Write** on
`CLOUDFLARE_REMOTE_RUNNER_TOKEN`. It extracts only that token and
`CLOUDFLARE_REMOTE_RUNNER_ACCOUNT_ID` through the same confined sops helper as secret
upload. It posts to the account's
[telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
with a fixed timeframe and a `runner-router` service filter, following event ID cursors.
Event extraction accepts structured source objects and JSON metadata messages; confirm
which layout the account returns after deployment.

Run from the repo root:

```sh
node packages/runner-router/scripts/logs.mjs
node packages/runner-router/scripts/logs.mjs --since 15m --event reconcile
node packages/runner-router/scripts/logs.mjs --since 2h --json
```

`--since` defaults to `1h` and accepts positive whole durations ending in `m`, `h`, or
`d`. `--event` filters structured event names. Normal output uses Kyiv time; `--json`
prints the raw selected telemetry events. Invalid arguments fail before vault access.
If access is rejected, check the account permission before retrying. Deploy logging
changes with `wrangler deploy`; secret upload rotates the heartbeat secret and is
unnecessary for an observability change. Before deploying, record the current version
from `wrangler deployments list`. To restore that version while keeping secrets, cron,
and the Durable Object, run `wrangler rollback <version-id>`.

#### Incident: laptop took a job while the PC was alive

Find the job's start time in GitHub Actions, including its timezone, then query a window
covering that time with `--event reconcile` (use `--json` for the full records). Find the
last reconcile at or before the job started and check `applied`, the last confirmed
observation, against `laptop.labels` and `readback.labels`. Any configured admission
label still present can admit a laptop job. A missing or failed readback leaves the
last observation stale; compare runner registrations using `laptop.id`.

Read `decisions` in order to identify which evaluation requested `desired: on` or
prevented a removal, using `hbCounter`, `hbAcceptedAt`, and `at` to match each heartbeat.
If `pcHealthy` was false, check heartbeat age for lease expiry at 30 s,
`githubProbe` and `probeFailures` for three consecutive failures, and each PC runner's
`unit`, `listener`, GitHub `status`, and `ci-active` label. A running PC alone does not
establish a healthy runner.

If the final `kind` is `unknown`, inspect `unknownReason`, `unknownSince`,
`cooldownUntil`, `retryAt`, and failed `mutations`: uncertainty or cooldown freezes
admission changes. A healthy PC can still leave fallback on while `offAuthorized` is
false and `healthyForS` is below 120 s. Compare `healthySince` and each decision's
`lastKnownEvalAt` to understand continuity, then follow later records through the
removals and readback. Use `queued`, `alerts`, and `outbox` to correlate operator
notifications with the same pass.

### Rollback / stop

Disable the PC timer (`systemctl --user disable --now runner-router-heartbeat.timer`),
`wrangler delete` (removes cron, alarms stop with the class), then remove every configured
admission label (`ci-active` and, during the compatibility window, `popos`) from the laptop
via REST and read the laptop's labels back. Fallback is then manual (ariadne
`.claude/runbooks/ci-operations.md`). PC `ci-active` labels stay: since the cutover every
self-hosted job asks for them.

## Consumer commands

From a repository containing `.remote-runner.yaml`:

```sh
remote-runner run verify-full
remote-runner resolve verify-full --json
remote-runner prewarm verify-full
remote-runner status verify-full
remote-runner doctor verify-full
```

`run` uses the profile's declared workload by default. `REMOTE_RUNNER_MODE=auto|local|remote`
selects the mode without consumer-side parsing. A command after `--` remains available as an
explicit diagnostic override. `fallback` accepts `local`, `fail`, or another profile id in the same
manifest and consumer. A profile-id fallback is one remote hop only: its target profile must end in
`local` or `fail`. `auto` may traverse that remote hop and then the target's local fallback;
`remote` permits the remote hop but forbids the local end; `local` runs only the requested profile
locally. Every profile that names or is named as a remote fallback must keep its `id`, `consumer`,
and `remote.label` within `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; violations reject the manifest as a
usage error.

`remote-runner resolve <profile> [--manifest <path>] --json` applies the same mode, reachability
cache, and one-hop selection without starting a workload, taking the profile lock, or creating a
Mutagen session. Its JSON reports `requested`, `selected`, `remoteLabel`, `fallbackActive`, `reason`,
and `checkedAt`; the answer is advisory because reachability can change before `run`.
`fallbackActive` is true for a named fallback or any local leg, and false only when the requested
profile is selected remotely. Under `auto`, a plain profile or the chain's fallback profile selects
its `fallback: local` leg whenever the same `run` would rerun locally, regardless of failure class.
The primary of a named pair still fails closed on `security`, `local`, and `remote` refusals.

| Exit | `resolve` result                                                                          |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | A remote or local selection exists.                                                       |
| `2`  | Usage, manifest, or profile error.                                                        |
| `3`  | No runnable selection; the same `run` request would exit 75 before starting the workload. |
| `4`  | A `security` refusal prevents selection; local execution was not selected.                |
| `70` | A runtime or `local`-class fault prevents selection; local execution was not selected.    |

See [Rollback from remote fallback](docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md#rollback-from-remote-fallback)
before reverting the runner or consumer manifest.

`prewarm` validates the profile, coalesces an equivalent request in
the controller-owned durable queue, and returns after that handoff; synchronization, setup, and the
remote workload continue in the background. A handoff failure remains fail-soft so a worktree
creation hook never fails, and the first ordinary `run` retries everything. `status` reports
`prewarm=queued|running` while a request is in flight, `prewarm=ok@<instant>` or
`prewarm=failed(<status>)@<instant>` for the last request that finished, `prewarm=idle` when none
ever ran for this worktree, and `prewarm=unknown` when the state cannot be read; `logs` records the
lifecycle verdict of every run. `logs --all [--json] [--since <date>] [--cold-threshold-ms <n>]`
reads every identity under the state root instead of this worktree's own log, so a lane's history
survives the removal of the worktrees that produced it, and works from any directory because it
never consults a manifest. It exits 0 whenever the read succeeded, however many failed runs the
corpus holds. `doctor`
exits 0 when no check failed, 1 when at least one check is `fail`, 70 on a runtime error, and 2 on
a usage error; a `warn` check keeps the exit code 0.

For allowlisted development secrets, a profile may declare `dotenv: .env`. The runner reads only
the named keys locally, never synchronizes the file, and sends values through framed SSH input. An
argv `provider` remains available for consumers that cannot use a dotenv file.

## `run` exit codes

`run` returns the workload's own exit status verbatim, with one exception: a remote workload
exiting 255 cannot be told apart from ssh reporting a dropped connection, and is reported as 75.
The runner's own codes are 2 for a usage, manifest or profile error, 70 when the execution runtime
is unavailable or the run itself threw, 64 when the workload command is not a usable argument
array, 127 when the remote could not execute it, and 75 for an infrastructure failure.

**No exit code is reserved per failure reason, and 75 is deliberately not split.** The workload
shares this code space, so a reserved code would collide with a workload that chose it — and in the
worst direction, telling a retry shim that a workload which did run never started. A run exiting 75
is therefore ambiguous between an infrastructure failure, a connection lost after the workload had
already started, and a workload that exited 75 or 255 on its own. **75 alone never licenses a
retry**; the reason is in the log, not in the status.

`remote-runner logs <profile>` writes an optional `unavailableReason` on the `run-finish` and
`run-error` records: the last reason reported during that run. Treat it as optional — it is absent
when nothing was reported, when the remote child started and the run recovered, and on records
written before the field existed — and keep the `runId` join to the paired `run-unavailable` record
as the fallback path and as the only source of the operator `detail`. The value is raw as reported
and is not restricted to the documented reason index, so accept values outside it. Presence does
not mean failure: a run that fell back to local and succeeded still names what pushed it there.
`run-finish` also carries `remoteChildStarted`: true once the remote child's start marker was seen.
False is weaker than it looks — the marker rides the child's spawn event, so a failure in the
window before it arrives can leave a remote workload alive — but it is the closest thing to a
retry-safety signal the runner has, and the one channel a workload cannot influence.

Every record also names `requested` and `selected`. A remote failover writes `run-failover` as the
primary leg's terminal record and continues under the same `runId` in the fallback profile's log.
Corpus `summary.records` includes `run-failover`; workload outcome totals still come from terminal
workload records and do not double-count the failover marker.

The 74-79 codes returned by the remote retention and probe snippets are internal to their callers
and never become the CLI's exit status.

## Remote workspace placement and retention

The legacy generated root remains valid. A profile may instead select a canonical absolute POSIX
path and opt into bounded cleanup:

```yaml
workspace:
  generatedRoot: /mnt/DataAI/home/admin/.cache/remote-runner/workspaces
  retention:
    keep: 3
    graceMinutes: 60
```

Capacity is probed on the filesystem containing `generatedRoot`, not on the remote home filesystem.
Each client has a stable private `~/.local/state/remote-runner/client-id`; workspace identities include
that UUID and the canonical checkout path. Workspaces and retention are isolated below
`<generatedRoot>/<consumer>/<profile>/clients/<client-hash>`. Do not clone this identity across computers;
read the [machine-switching migration](docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md#switching-client-machines)
before upgrading a path-only installation.

Retention reserves the current identity, keeps the newest identities up to `keep`, and protects any
additional identity active within `graceMinutes`. Active workloads hold a profile identity lock;
cleanup takes the same lock non-blockingly, quarantines one exact stale directory, terminates only
its owned Mutagen session, and then removes the quarantine and runner metadata. Fresh activity is
rechecked before both a new quarantine and resumed cleanup of an existing quarantine. Cleanup never
follows symlinks and never changes the workload exit code. A cleanup failure emits a bounded warning
and is retried after a later workload.

## Bootstrap convergence

Dependency fingerprints are a performance optimization, not the final correctness gate. Exact
files cover setup entry points and root lock/workspace configuration; safe patterns automatically
include tracked and non-ignored untracked manifests as packages are added or removed. Gitlink OIDs
are always included without listing submodule paths manually.

```yaml
bootstrap:
  node: local-exact
  packageManager: package.json
  setup: [./scripts/ds-bootstrap.sh]
  ensure:
    - [node, scripts/pnpm-state.mjs]
  artifacts:
    - vendor/dev-standards/runner/dist/verify-runner.mjs
    - vendor/dev-standards/runner/dist/.built-from
  fingerprint:
    files: [package.json, pnpm-lock.yaml, pnpm-workspace.yaml, scripts/ds-bootstrap.sh]
    patterns: ["**/package.json", "**/pyproject.toml", "**/uv.lock"]
```

Every remote or local preparation checks each declared repository-relative artifact and then runs each
fixed-argv `ensure` command. A missing artifact or failed ensure triggers the full setup once. All
artifacts are checked again before every ensure command is retried; a persistently missing artifact,
artifact inspection error, or second ensure failure is fail-closed and no new healthy state is
recorded. A matching fingerprint plus present artifacts and successful ensure reuses the installed
environment. Existing manifests that omit `artifacts` retain the empty-list behavior. Legacy
fingerprint arrays remain accepted as exact-file lists.

- Design: `docs/specs/2026-07-31-remote-runner-design.md`

## Documentation map

- [Remote runner operations and troubleshooting](docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md)
- Implementation plan: `docs/superpowers/plans/2026-07-31-remote-runner-implementation.md`

`status`, `doctor` and bounded `logs` accept the same `--manifest <path>` as `run` and `prewarm`.
For the opt-in account workload cap, migration steps and Linux acceptance requirement, see the
[operations runbook](docs/REMOTE_RUNNER_OPERATIONS_AND_TROUBLESHOOTING.md#account-workload-limit).
