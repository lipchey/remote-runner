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
explicit diagnostic override. `prewarm` forces remote preparation/execution but is fail-soft so a
worktree creation hook never fails; the first ordinary `run` retries everything.

For allowlisted development secrets, a profile may declare `dotenv: .env`. The runner reads only
the named keys locally, never synchronizes the file, and sends values through framed SSH input. An
argv `provider` remains available for consumers that cannot use a dotenv file.

- Design: `docs/specs/2026-07-31-remote-runner-design.md`
- Diagnostic runbook: `docs/RUNBOOK.md`
- Implementation plan: `docs/superpowers/plans/2026-07-31-remote-runner-implementation.md`
