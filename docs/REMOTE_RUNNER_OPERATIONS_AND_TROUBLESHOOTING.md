# remote-runner operations and troubleshooting

Use this runbook from the Mac controller. Diagnostic commands are read-only and never print
captured secret values. Replace angle-bracket placeholders with values from the validated profile;
never paste Telegram tokens, environment values, or raw SSH stderr into a ticket.

Start with:

```sh
remote-runner status <profile>
remote-runner doctor <profile>
remote-runner logs <profile>
```

`doctor` exits 0 when no check failed, 1 when at least one check is `fail`, 70 on a runtime error,
and 2 on a usage error; a `warn` check keeps the exit code 0, so a non-zero `doctor` is a scriptable
signal that a listed check needs the read-only diagnosis below.

Build the checkout whose source should become the installed application, then install and inspect
its immutable receipt:

```sh
cd <built-checkout>
pnpm build
remote-runner install
remote-runner --version
```

For the first upgrade from a runner that predates checkout-selected installs, replace
`remote-runner install` above with `node dist/src/main.js install`; the old installed executable
cannot contain the installer correction. Subsequent installs resolve the current built checkout,
not the previously installed application.

The installer writes an immutable self-contained application below
`~/.local/share/remote-runner/app`, the stable `~/.local/bin/remote-runner` executable, and
`~/Library/LaunchAgents/com.lipchey.remote-runner.plist`. Its closed receipt records the package
version and application identity reported by `remote-runner --version`. It uses the current
absolute Node runtime, requires no sudo, and starts or repairs the LaunchAgent.

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

Every log record of one run carries the same `runId` and the writing `pid`, so a prewarm and a
manual run interleaved in one file stay separable; `run-finish` and `run-error` add `durationMs`.
A `run-unavailable` record names the stable reason the remote could not be prepared, with the
operator detail when the failure carried one — read it before treating an exit code 75 as a single
condition.

## Stable reason-code index

| Reason                   | Read-only diagnosis                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `dns`                    | `dscacheutil -q host -a name <remote>`                                                                           |
| `host-key`               | `ssh-keygen -F <remote>`                                                                                         |
| `authentication`         | `ssh -o BatchMode=yes <remote> true`                                                                             |
| `transport`              | `ssh -o ConnectTimeout=5 <remote> true`                                                                          |
| `remote-shell`           | `ssh <remote> printf remote-shell-ok`                                                                            |
| `capacity`               | `ssh <remote> df -Pk <workspace>`                                                                                |
| `bootstrap`              | `ssh <remote> test -x <toolchain>/bin/node && test -x <toolchain>/bin/pnpm`                                      |
| `consumer-setup`         | `ssh <remote> sh -c 'cd <workspace> && ./scripts/ds-bootstrap.sh'`                                               |
| `validation`             | `remote-runner validate <profile>`                                                                               |
| `lock`                   | `ls -ld <lock-root>`                                                                                             |
| `sync`                   | `mutagen sync list <session>`                                                                                    |
| `workspace`              | `ssh <remote> git -C <workspace> status --short --branch`                                                        |
| `workspace-registration` | `ssh <remote> inspect exact Git worktree registration for <workspace>`                                           |
| `secrets`                | `ssh <remote> if found=$(find <workspace> -maxdepth 1 -name .env -print); then [ -z "$found" ]; else exit 1; fi` |
| `controller`             | `launchctl print gui/<uid>/com.lipchey.remote-runner`                                                            |
| `child-start`            | `tail -n 50 <runner-log>`                                                                                        |
| `connection-lost`        | `tail -n 50 <runner-log>`                                                                                        |
| `timeout`                | `ssh -o ConnectTimeout=2 <remote> true`                                                                          |
| `unknown`                | `remote-runner status <profile>`                                                                                 |

`lock`, `validation` and `consumer-setup` never raise an outage notification: none says the remote is
unreachable. `consumer-setup` is one of the profile's own `bootstrap.setup` / `bootstrap.ensure`
commands: the remote ran it and it exited non-zero, which a local fallback would reproduce exactly,
so the run exits `75` without one. The `detail=` on that line names the failing script or command and
its exit code (`dependency setup ./scripts/ds-bootstrap.sh failed with exit code 3`); rerun that one
command in the consumer repository and fix it there — the remote is fine. The command's own output is
not forwarded, only the exit code.

Two things have to hold before a failure enters this class. First, the ssh client must actually have
run: a client that never started (`ENOENT`, `EMFILE`, `ENOMEM` under load) reports a code the local
process layer invented for it, so it stays `bootstrap` whatever that code is. Second, the exit code
must be `1`–`124` — the consumer command's own failure status. Everything else stays `bootstrap`.
`125` is reserved for the remote workspace wrapper's own `cd` failure, `255` is ssh's own failure
code, and `128+N` is the client signal-killed. `126`/`127` are excluded too, even though a remote
shell does emit them for "not found" and "not executable": the setup scripts live inside the synced
workspace and the ensure commands resolve through toolchain roots under it, so those codes describe
a sync Mutagen never delivered, a lost exec bit, or a toolchain a retention prune erased — while the
local checkout still holds the file. Blaming the consumer there would withhold the fallback run that
would have succeeded. A declared `bootstrap.artifact` that is still missing after setup is
`bootstrap` for the same reason.

All of those keep the outage notification and keep the fallback on a `fallback: local` profile run
in `auto` mode. On a profile declaring `fallback: fail`, or a run pinned to `mode: remote`, there is
no local run — and the outage notification is currently raised on the fallback path, so those runs
exit `75` with the `run-unavailable` record in the runner log but no Telegram outage. Read the log
record as the authoritative signal there. The one exception is `connection-lost` below, which is
raised without any fallback behind it and therefore alerts on every profile.

For the same reason, `255` from the ssh client AFTER the workload started is reported as exit `75`
with `remote-runner: ssh connection dropped mid-run; the workload result is unknown`, never as the
workload's own exit code, and it raises a `connection-lost` outage — the machine went away, exactly
as a drop one minute earlier would have. Rerun it, but read the workload as unknown rather than
failed: it may have completed, failed, or been killed mid-flight, and the run cannot tell which.
There is deliberately no local fallback here, unlike `child-start`: the workload already started on
the remote, so its side effects may have landed and a local rerun would repeat them. The ceiling is
that a workload genuinely exiting `255` is read the same way, because the stream protocol carries no
exit marker of its own.

A `lock` means another run of the same workspace — usually a queued prewarm — is already holding it.
The runner waits for it, printing `another run holds this workspace; waiting for it to finish`, and
offers the attempt again. `lock` and `consumer-setup` are the preparation failures that never fall
back to a local run: running the workload locally while another run of the same workspace is doing it is the
duplicate the wait exists to prevent, so exhausted contention exits `75` instead. Diagnose the
holder with the index command before rerunning.

`workspace` and `secrets` also appear as `warn` carrying the detail `remote workspace is not
provisioned`, and `doctor` exits `0` on them. A workspace is a cache, so a checkout that only ever
dispatches runs from its worktrees never has one — and then neither its Git state nor a secret inside
it is knowable. Read that pair as "nothing to inspect here", not as a plaintext `.env` sitting on the
remote, which is what the `fail` they used to report looked like.

A workload command that cannot be executed at all is not one of these reasons: the run exits `127`
with `remote-runner launcher: child spawn failed`, without a local fallback or an outage
notification. The usual cause is passing a shell line as the workload — `run <profile> -- 'a && b'`
is one argv entry, so wrap it: `run <profile> -- sh -c 'a && b'`.

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

For `sync`, inspect `mutagen sync list <session>` and `remote-runner status <profile>`. The
`sync.session` check validates the owned session against the manifest — endpoints, synchronization
mode, conflicts, connectivity — and names the mismatch in the check's `detail`; a run that stops at
`sync` names the same failure after `reason=sync` on stderr, in its own wording. Both fields carry
authored diagnostics only, never remote or provider text, and both are optional: treat their absence
as normal. A `warn` on `sync.session` means the next run repairs the session itself — manifest ignore drift or
a disconnected session — or that a home-relative `workspace.generatedRoot` left the beta endpoint
unverified.

A missing or paused owned session needs no repair — the next run creates or resumes it, and manifest
ignore drift is repaired by recreating the session. The confined repair flow below acts only on
paths under the profile identity root and never on a Mutagen session, so an endpoint or mode
mismatch, or a conflicted session, is an operator decision: confirm which session is legitimate,
then terminate the owned one with the installed
`~/.local/share/remote-runner/bin/<mutagen>/mutagen sync terminate <session>`. Do not create an
ad-hoc bidirectional session. Mutagen SSH is isolated from `~/.ssh/known_hosts`: managed `ssh`/`scp`
wrappers live under `~/.local/share/remote-runner/ssh`, enforce strict checking, and use only
`~/.local/state/remote-runner/known_hosts/managed`. The controller exports `MUTAGEN_SSH_PATH` before
starting the daemon. Do not bypass these wrappers to accept a prompt interactively.

## Workspace

For `workspace`, use the read-only remote `git status` command in the index. The generated workstation
checkout is disposable runner state, but the laptop worktree is authoritative and must never be reset
by a repair. `workspace.generatedRoot` accepts the exact legacy
`~/.cache/remote-runner/workspaces` literal or a canonical absolute non-root POSIX path. Do not use a
symlink as the generated root: the capacity probe requires `realpath` to equal the configured path.

When `workspace.retention` is configured, normal remote workloads update an external activity marker
under `<profile-root>/.activity/<identity>` before synchronization and after a marker-seen child exit.
The workload holds `<profile-root>/.locks/<identity>` through launcher exit. Post-workload cleanup
keeps the configured number of newest identities, honors `graceMinutes`, and skips an identity whose
lock is busy. Temporary `.gc-<identity>-<nonce>` quarantines are resumable after interruption.
Symlinks and special entries are reported but never followed or removed.

Activity refresh takes the same identity lock as quarantine. Retention rechecks the marker under
that lock immediately before moving a workspace or resuming an existing `.gc-*` cleanup, so a
candidate selected from an older listing but refreshed by concurrent preparation is kept as
grace-protected.

`remote-runner doctor <profile>` reports `workspace-registration` when the exact generated
workspace directory is missing but the consumer's bare mirror still lists it as a registered Git
worktree. A normal `remote-runner run <profile>` self-heals that state under the consumer lock: it
prunes Git-admin records that are already prunable, relists live worktrees, and recreates the
confined candidate. For an older installed runner that predates this recovery, inspect
`git --git-dir=<consumer-mirror> worktree list --porcelain` before manually pruning; never delete or
reset the authoritative laptop worktree.

Steady-state identity count is `keep`; short bursts may exceed it while grace-protected or active
identities remain. Read that steady state per source worktree, not per run: an identity is derived
from the source worktree path, so a laptop running verify from many worktrees keeps one full
workspace for each whose last run falls inside `graceMinutes`, and the resident count tracks that
number rather than `keep`. Shrink it by retiring local worktrees — lowering `graceMinutes` only
makes the next run of a still-active worktree rebuild the checkout and dependencies it deleted. A warning reading `workspace retention cleanup failed; workload exit preserved`
means the workload verdict is authoritative and cleanup will retry on a later marker-seen run. Inspect
the profile root, `.activity`, `.locks`, owned Mutagen session names, and `.gc-*` entries before any
manual intervention.

Local Mutagen sessions are reaped on a different rule than remote workspaces, and independently of
whether the profile configures retention at all: after a marker-seen run the runner lists sessions and
terminates every one of its own `remote-runner-<consumer>-<profile>-<identity>` sessions whose alpha
root is no longer on the laptop. That is the state deleting a worktree leaves behind, and no
remote-side retention plan can ever nominate it. The sweep and the remote prune are independent — the
prune runs first, and either one failing still lets the other run — so a stopped Mutagen daemon does
not park remote disk, and an unreachable remote does not park sessions. `mutagen sync list` after a
run is the check.

A session is only reaped once it has proved it is this runner's: its identity must be the SHA-256 of
its own alpha root, its beta endpoint the workspace this profile derives for that identity, and its
mode `one-way-replica`. A duplicated session name is skipped rather than resolved. Termination targets
Mutagen's session identifier, never the name, so that a session created under the same name after the
listing cannot be terminated on the previous one's evidence; one refused termination is reported but
does not stop the rest of the sweep.

Two consequences worth knowing before reading a sweep as a bug. Absence has to be established, not
merely unrefuted: the root is gone only when the directory that would contain it is itself readable, so
an unreadable ancestor, an I/O error, or a volume whose whole mount path has disappeared all keep the
session alive — while a mount point that survives unmounting as an empty directory does read as a
deletion, and the next run from that worktree resynchronizes it. A regular file where the worktree used
to be also counts as gone, since no worktree can live there. And the remote workspace of a deleted
worktree is not touched by this sweep: it ages out through `keep` and `graceMinutes` like any other
idle identity.

## Disk capacity

For `capacity`, run `ssh <remote> df -Pk <generated-root>`. The runner creates and canonicalizes the
configured generated root first, so an absolute root on a dedicated mount is measured on that mount
rather than on `$HOME`. Free space below the validated profile floor is an outage; clean unrelated
workstation data separately or move the canonical root to the intended filesystem, but do not weaken
the capacity floor silently.

## Bootstrap

For `bootstrap`, `remote-runner doctor <profile>` checks executable Node and pnpm under the
runner-owned remote toolchain root rather than the login shell `PATH`. A normal remote run installs
the pinned native Node, exact pnpm, uv, gitleaks, and project dependencies under owned runner paths.
Never sync `node_modules`, `.pnpm-store`, `.nx`, build output, or coverage from the laptop.

The toolchain is downloaded once, not once per run: a promoted directory names the exact pinned
version it holds, and the Node tree also names the package manager installed into it, so a run
reuses it after a single `test -x` probe. A Node, uv, or package-manager version bump therefore
names a new directory and downloads again; the superseded tree stays on disk until it is cleaned
up. A run no longer depends on nodejs.org or github.com answering once its toolchain is in place.

The dependency fingerprint is only the fast invalidation path. On every preparation the runner
checks every declared repository-relative bootstrap artifact, then the profile's fixed-argv ensure
commands validate the synchronized workspace against its installed environment. A changed
fingerprint, missing artifact, or failed ensure command runs the full declared setup once. The
runner then checks every artifact again before rerunning all ensure commands.

Gitlinks are fingerprinted from `git submodule status --recursive`, the checked-out commit of each
submodule's working copy, because that is what Mutagen actually replicates to the remote — not the
superproject's committed gitlink oid. This still cannot see uncommitted edits made _inside_ a
submodule's own working tree: `git ls-files` does not descend into submodules, and
`git submodule status` reports only the submodule's checked-out commit, not whether that checkout is
dirty. A dirty submodule can therefore still produce a stale fingerprint cache-hit; if bootstrap
looks stale after editing inside a submodule without committing there first, commit inside the
submodule (or otherwise change a tracked, fingerprinted file) to force re-invalidation.

A normal missing artifact is self-healed by that single setup attempt. A persistently missing
artifact is reported as `dependency artifact <path> missing after setup`; an artifact inspection
error, such as an SSH protocol failure, is reported separately and does not masquerade as absence.
A second ensure failure is reported as `dependency ensure <command> failed`. All remain fail-closed
and no healthy state is written. Diagnose the declared setup or ensure command in the generated
workspace with the same managed toolchain `PATH`; do not create bundles manually or add individual
package paths to a fingerprint list. Pattern discovery already includes tracked and non-ignored
untracked matching manifests and excludes Git-ignored generated dependencies.

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
after the remote child-start marker. A `connection-lost` outage is the one that arrives without a
local fallback behind it: the marker had already been seen, so the recovery for the previous outage
was sent and this is a new one.

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
coalesces instead of starting another workload. A claim whose run merely _failed_ is dropped
instead — otherwise the controller would replay the same failing request on every pass.

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
