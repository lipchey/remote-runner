# remote-runner

Automatic execution of repository-defined workloads on a trusted remote workstation. The package
owns synchronization, native remote setup, fallback, Telegram outage/recovery notifications,
diagnostics, repair, prewarming, and benchmark collection. Consumer repositories provide only a
closed `.remote-runner.yaml` manifest and a thin call to the installed executable.

## Install once

```sh
pnpm install
pnpm verify
node dist/src/main.js install
```

The installer publishes the stable `~/.local/bin/remote-runner` command and the login LaunchAgent.
That one installation is shared by every consumer project; projects do not copy or link runner
source files into their repositories.

## Development

```sh
pnpm format
pnpm format:check
pnpm verify
```

`format` rewrites maintained files to the repository style, while `format:check` is read-only.
`verify` is the required full local gate and runs formatting, typecheck, unit tests, and build.

The repository-wide formatting baseline is isolated in `.git-blame-ignore-revs`. To omit it from
local blame output, configure this clone once:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Consumer commands

From a repository containing `.remote-runner.yaml`:

```sh
remote-runner run verify-full
remote-runner prewarm verify-full
remote-runner status verify-full
remote-runner doctor verify-full
```

`run` uses the profile's declared workload by default. `REMOTE_RUNNER_MODE=auto|local|remote`
selects the mode without consumer-side parsing. A command after `--` remains available as an
explicit diagnostic override. `prewarm` validates the profile, coalesces an equivalent request in
the controller-owned durable queue, and returns after that handoff; synchronization, setup, and the
remote workload continue in the background. A handoff failure remains fail-soft so a worktree
creation hook never fails, and the first ordinary `run` retries everything. `status` reports
`prewarm=idle|queued|running|unknown`; `logs` records the eventual lifecycle verdict.

For allowlisted development secrets, a profile may declare `dotenv: .env`. The runner reads only
the named keys locally, never synchronizes the file, and sends values through framed SSH input. An
argv `provider` remains available for consumers that cannot use a dotenv file.

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
Retention reserves the current identity, keeps the newest identities up to `keep`, and protects any
additional identity active within `graceMinutes`. Active workloads hold a profile identity lock;
cleanup takes the same lock non-blockingly, quarantines one exact stale directory, terminates only
its owned Mutagen session, and then removes the quarantine and runner metadata. Cleanup never
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
  fingerprint:
    files: [package.json, pnpm-lock.yaml, pnpm-workspace.yaml, scripts/ds-bootstrap.sh]
    patterns: ["**/package.json", "**/pyproject.toml", "**/uv.lock"]
```

Every remote preparation runs each fixed-argv `ensure` command. A matching fingerprint plus a
successful ensure reuses the installed environment. A failed ensure triggers the full setup once
and then retries every ensure command from the beginning; persistent failure is fail-closed and no
new healthy state is recorded. Legacy fingerprint arrays remain accepted as exact-file lists.

- Design: `docs/specs/2026-07-31-remote-runner-design.md`
- Diagnostic runbook: `docs/RUNBOOK.md`
- Implementation plan: `docs/superpowers/plans/2026-07-31-remote-runner-implementation.md`
