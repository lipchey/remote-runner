# remote-runner

Automatic execution of repository-defined workloads on a trusted remote workstation. The package
owns synchronization, native remote setup, fallback, Telegram outage/recovery notifications,
diagnostics, prewarming, and benchmark collection. Consumer repositories provide only a
closed `.remote-runner.yaml` manifest and a thin call to the installed executable.

## Install once

```sh
pnpm install
pnpm verify
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
`prewarm=idle|queued|running|unknown`; `logs` records the eventual lifecycle verdict. `doctor`
exits 0 when no check failed, 1 when at least one check is `fail`, 70 on a runtime error, and 2 on
a usage error; a `warn` check keeps the exit code 0.

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

Every remote preparation checks each declared repository-relative artifact and then runs each
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
