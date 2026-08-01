# remote-runner diagnostic runbook

Use this runbook from the Mac controller. Diagnostic commands are read-only and never print
captured secret values. Replace angle-bracket placeholders with values from the validated profile;
never paste Telegram tokens, environment values, or raw SSH stderr into a ticket.

Start with:

```sh
remote-runner status <profile>
remote-runner doctor <profile>
remote-runner logs <profile>
```

One-time installation or an idempotent upgrade is:

```sh
remote-runner install
```

The installer writes an immutable self-contained application below
`~/.local/share/remote-runner/app`, the stable `~/.local/bin/remote-runner` executable, and
`~/Library/LaunchAgents/com.lipchey.remote-runner.plist`. It uses the current absolute Node runtime,
requires no sudo, and starts or repairs the LaunchAgent.

Normal project integration needs only `remote-runner run <profile>` from the repository root. The
runner loads the profile workload and `REMOTE_RUNNER_MODE=auto|local|remote` itself. A worktree hook
may call `remote-runner prewarm <profile>`; failure is printed but intentionally returns success,
and the first normal run retries preparation. A successful call means the controller accepted a
durable, coalesced request; it does not mean synchronization, setup, or the workload finished.
`remote-runner status <profile>` reports `prewarm=queued` before claim, `prewarm=running` while the
controller owns the request, and `prewarm=idle` after completion. The final status is recorded in
`remote-runner logs <profile>`. Do not poll this state from a worktree-creation hook or add
project-local adapters for mode selection, dotenv parsing, fallback, notification, or prewarm
policy.

## Stable reason-code index

| Reason | Read-only diagnosis |
| --- | --- |
| `dns` | `dscacheutil -q host -a name <remote>` |
| `host-key` | `ssh-keygen -F <remote>` |
| `authentication` | `ssh -o BatchMode=yes <remote> true` |
| `transport` | `ssh -o ConnectTimeout=5 <remote> true` |
| `remote-shell` | `ssh <remote> printf remote-shell-ok` |
| `capacity` | `ssh <remote> df -Pk <workspace>` |
| `bootstrap` | `ssh <remote> test -x <toolchain>/bin/node && test -x <toolchain>/bin/pnpm` |
| `validation` | `remote-runner validate <profile>` |
| `lock` | `ls -ld <lock-root>` |
| `sync` | `mutagen sync list <session>` |
| `workspace` | `ssh <remote> git -C <workspace> status --short --branch` |
| `secrets` | `ssh <remote> find <workspace> -maxdepth 1 -name .env -print` |
| `controller` | `launchctl print gui/<uid>/com.lipchey.remote-runner` |
| `child-start` | `tail -n 50 <runner-log>` |
| `timeout` | `ssh -o ConnectTimeout=2 <remote> true` |
| `unknown` | `remote-runner status <profile>` |

## SSH and Tailscale

For `dns`, `transport`, `authentication`, `remote-shell`, or `timeout`, run the exact index command
first. Then inspect `tailscale status` locally and `ssh <remote> systemctl is-enabled ssh tailscaled`
read-only. Do not disable host-key checking. If the host remains unavailable, `auto` mode falls back
locally and the durable Telegram outage notification must remain active until a remote child starts.

## Host key

For `host-key`, compare the profile fingerprint with a fingerprint obtained over a separately trusted
channel. Never accept a changed key from the failed SSH connection itself. Update the manifest only
after that independent comparison.

## Mutagen

For `sync`, inspect `mutagen sync list <session>` and `remote-runner status <profile>`. A missing or
paused owned session is repaired by the confined repair flow below; do not create an ad-hoc
bidirectional session. Mutagen SSH is isolated from `~/.ssh/known_hosts`: managed `ssh`/`scp`
wrappers live under `~/.local/share/remote-runner/ssh`, enforce strict checking, and use only
`~/.local/state/remote-runner/known_hosts/managed`. The controller exports `MUTAGEN_SSH_PATH` before
starting the daemon. Do not bypass these wrappers to accept a prompt interactively.

## Workspace

For `workspace`, use the read-only remote `git status` command in the index. The generated workstation
checkout is disposable runner state, but the laptop worktree is authoritative and must never be reset
by a repair.

## Disk capacity

For `capacity`, run `ssh <remote> df -Pk <workspace>`. Free space below the validated profile floor is
an outage, so clean unrelated workstation data separately; do not weaken the capacity floor silently.

## Bootstrap

For `bootstrap`, `remote-runner doctor <profile>` checks executable Node and pnpm under the
runner-owned remote toolchain root rather than the login shell `PATH`. A normal remote run installs
the pinned native Node, exact pnpm, uv, gitleaks, and project dependencies under owned runner paths.
Never sync `node_modules`, `.pnpm-store`, `.nx`, build output, or coverage from the laptop.

The dependency fingerprint is only the fast invalidation path. On every preparation the profile's
fixed-argv ensure commands validate the synchronized workspace against its installed environment.
When an ensure command fails, the runner performs the full declared setup once and reruns all ensure
commands; a second failure is reported as `dependency ensure <command> failed` and remains
fail-closed. Diagnose that command in the generated workspace with the same managed toolchain
`PATH`; do not repair it by adding individual package paths to a manual fingerprint list. Pattern
discovery already includes tracked and non-ignored untracked matching manifests and excludes
Git-ignored generated dependencies.

## Benchmark

`remote-runner benchmark <profile>` executes the manifest-declared workload matrix locally and
remotely and writes confined JSON and Markdown receipts below the source root. The generic runner
does not delete undeclared user caches: a workload that needs reproducible cold-cache eviction must
declare and own that preparation itself. Review the full matrix before starting because full-tier
profiles can intentionally take a long time.

## Telegram

Confirm `/Users/admin/.claude/.telegram-ask.conf` is a regular file owned by the current user with mode
`0600`; do not print it. `remote-runner doctor <profile>` and the notification queue status are safe to
share. An outage is sent once, repeated local fallbacks are deduplicated, and recovery is sent only
after the remote child-start marker.

## Workstation reboot

Before reboot, record `remote-runner status <profile>` and obtain the workstation owner's explicit
approval. After reboot, use the SSH/Tailscale read-only checks above. The next invocation must rebuild
runner state without requiring a Linux resident daemon.

## Controller crash

Inspect `launchctl print gui/<uid>/com.lipchey.remote-runner`. Every `run` also performs bounded
self-healing, so a stopped controller cannot silently disable session reconciliation or alerts. A
healthy login service reports `state = running`; repair it idempotently with `remote-runner install`
if it is missing or stopped. A prewarm request claimed before a controller restart remains in the
owned `.running` state and is retried by the next controller pass; an equivalent new request
coalesces instead of starting another workload.

## Corrupt state

Keep `.corrupt-*` evidence inside the owned state directory. Do not hand-edit JSON state. Use the
confined preview/apply sequence below for the affected profile.

## Confined repair procedure

Preview first and check that every target contains only the selected worktree identity:

```sh
remote-runner repair <profile> --dry-run
```

Only if that exact preview is correct, apply it; a changed plan is rejected and requires a new preview:

```sh
remote-runner repair <profile> --apply
```

## Upgrade

Run `remote-runner doctor <profile>` before and after installing a signed, checksum-verified release.
The installer may replace only its owned executable, plist, and bundled Mutagen paths; compatible
state is preserved. A running controller is restarted when the executable or plist changes.

## Uninstall

First inventory the exact owned paths and ensure no sibling path is selected. Uninstall must refuse
foreign files and remove only the executable, launch agent, runner state, and runner cache declared by
the installer. Project worktrees and the Telegram configuration are never uninstall targets.

## Privacy-safe support bundle

Collect only `remote-runner status <profile>`, `remote-runner doctor <profile>`, and the bounded output
of `remote-runner logs <profile>`. Remove usernames and absolute paths if unnecessary. Never include
the Telegram config, environment values, secret-provider stdout, SSH private keys, or raw SSH stderr.

## Sync canary

Create a harmless tracked-name text file containing no secret, wait for `remote-runner status` to show
the session watching, and confirm its content under the generated remote workspace with
`ssh <remote> cat <workspace>/<canary-file>`. Remove it on the laptop afterward. Never use `.env` or credentials as a
canary, and never edit the generated remote workspace directly.
