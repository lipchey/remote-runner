# Remote Workspace Retention and DataAI Placement

## Context

`remote-runner` creates one generated workspace for every local worktree identity under
`<generatedRoot>/<consumer>/<profile>/<identity>`. The current schema accepts only
`~/.cache/remote-runner/workspaces`, the runtime checks capacity on the remote home filesystem,
and completed identities are never retired. Ariadne accumulated 18 identity directories and
approximately 7 GiB of physical workspace data in one day, eventually falling below its 10 GiB
capacity floor and selecting local fallback.

The Pop!_OS workstation has a separate 1 TB NVMe mounted at `/mnt/DataAI`. Ariadne workspaces must
move to `/mnt/DataAI/home/admin/.cache/remote-runner/workspaces`, and the runner must bound future
growth without deleting active or recently prepared workspaces.

## Goals

- Preserve existing manifests that use `~/.cache/remote-runner/workspaces`.
- Allow a committed profile to select a canonical absolute generated root.
- Measure capacity on the selected generated-root filesystem.
- Keep at most three retained identity workspaces in steady state.
- Protect active workloads and preparations from garbage collection.
- Retire the matching Mutagen session and remote setup state with each stale identity.
- Preserve the authoritative workload exit code when post-run cleanup reports a failure.
- Complete the Ariadne migration without leaving its ordinary `./scripts/verify --full` entry
  point broken between runner installation and consumer cutover.

## Non-goals

- Moving toolchains, notification state, or controller state out of the remote home directory.
- Enforcing a byte budget. Per-directory sizes are misleading because workspaces share hardlinks.
- Deleting Timeshift snapshots, Docker volumes, user projects, or arbitrary remote cache trees.
- Cleaning identities owned by another consumer or profile.

## Manifest contract

`workspace.generatedRoot` accepts either:

1. the existing literal `~/.cache/remote-runner/workspaces`; or
2. a canonical, non-root absolute POSIX path without control characters.

Other tilde forms, relative paths, `/`, non-normalized paths, and path values with control
characters remain invalid. The manifest is trusted committed configuration, but every resolved
path is still passed as a fixed SSH argument and revalidated before destructive work.

Retention is opt-in for schema version 1 so existing consumers do not gain destructive behavior
on upgrade:

```yaml
workspace:
  generatedRoot: /mnt/DataAI/home/admin/.cache/remote-runner/workspaces
  baseRef: origin/main
  retention:
    keep: 3
    graceMinutes: 60
```

`keep` counts the current identity and the newest other retained identities. It is a positive
integer bounded at 64. `graceMinutes` is a positive integer bounded at 10,080. Ariadne uses the
approved values `3` and `60`.

## Path and capacity resolution

The initial SSH probe still discovers the canonical remote home. The runtime then resolves the
legacy tilde literal relative to that home or accepts the validated absolute root unchanged. It
creates the generated root with owner-only write semantics and verifies that the resulting real
path is the requested path rather than a symlink traversal.

The capacity probe calls `df` on the resolved generated root. Therefore moving workspaces to
DataAI makes the profile's `minimumFreeBytes` protect DataAI rather than the unrelated `/home`
partition. Toolchain and setup-state paths remain rooted under the remote home.

## Activity protection

Every identity owns a lock file below
`<generatedRoot>/<consumer>/<profile>/.locks/<identity>.lock`. The remote child shell acquires an
exclusive `flock` before changing into the workspace and holds the file descriptor until the
launcher and workload exit. A collector may quarantine an identity only after acquiring the same
lock non-blockingly.

The runner touches a confined `<profileRoot>/.activity/<identity>` marker when preparation starts
and again after a remotely started workload finishes. The marker stays outside the Mutagen beta
root, so one-way synchronization cannot delete it as remote-only workspace content. The collector
treats its mtime as the identity's activity time. A missing legacy marker falls back to the identity
directory mtime. Identities inside the 60-minute grace window are never collected, which protects a
concurrently preparing identity before its workload lock exists.

The collector also excludes the current identity unconditionally. Directory names must match the
existing 24-character lowercase hexadecimal identity format, and candidates must be real
directories directly below the exact consumer/profile root. Symlinks and special files are
ignored and reported rather than followed.

## Retention algorithm

Cleanup runs after every remotely started workload finishes, whether its exit code is zero or
non-zero. It does not run when the remote child never started.

1. Enumerate confined identity directories and read their activity timestamps.
2. Sort newest first, retain the current identity and enough newest identities to satisfy `keep`.
3. Skip every remaining candidate inside `graceMinutes`.
4. For each eligible candidate, acquire its remote lock non-blockingly and atomically rename the
   directory to a confined `.gc-<identity>-<nonce>` quarantine name while holding the lock.
5. Terminate the exact owned Mutagen session
   `remote-runner-<consumer>-<profile>-<identity>`.
6. Remove the quarantined directory, its activity marker, its lock file, and its remote setup-state
   directory.

Quarantine closes the race between the lock check and Mutagen termination. If the process stops
after quarantine, a later cleanup recognizes the confined `.gc-*` entry and retries the remaining
termination/removal steps. It never interprets arbitrary names as cleanup targets.

Cleanup records a bounded summary containing candidate, retained, skipped-active, removed, and
failed counts. A cleanup failure is written to diagnostics and leaves quarantined evidence when
appropriate, but it does not replace a valid workload exit code. Capacity probing remains
fail-closed on the next run if cleanup has not kept sufficient space available.

## Components

- Manifest types and loader: parse the absolute root and optional closed retention object.
- Remote path resolver: resolve legacy/absolute roots and derive profile, lock, workspace, and
  setup-state paths.
- Remote workspace retention module: plan candidates from bounded metadata and perform confined
  quarantine/removal operations.
- Mutagen lifecycle: terminate an exact owned session idempotently.
- Profile services: touch activity after reconciliation, hold the workload lock, and invoke
  post-child cleanup.
- Diagnostics/logging: emit the bounded cleanup summary without secrets or raw remote listings.

## Failure semantics

- Invalid paths or retention values fail manifest validation before SSH.
- A generated root that resolves through an unexpected symlink fails workspace preparation.
- Capacity is checked on the selected filesystem before synchronization or bootstrap.
- A held lock or recent activity causes a skip, never a forced delete.
- Mutagen termination or remote removal failure is isolated to that candidate and reported.
- Workload success/failure remains authoritative after the child-start marker.
- Local fallback remains possible only for preparation failures under the existing profile policy;
  post-child cleanup never triggers a local retry.

## Testing

- Manifest tests cover legacy compatibility, absolute-root acceptance, closed retention fields,
  numeric bounds, and hostile paths.
- Path tests prove DataAI resolution, target-filesystem capacity probing, and symlink rejection.
- Pure retention-planner tests cover ordering, keep=3, grace=60, current identity protection,
  legacy mtimes, hostile entries, and deterministic bounds.
- Runtime tests prove locked candidates are skipped, stale candidates are quarantined before
  Mutagen termination, cleanup resumes after partial failure, and setup state is confined.
- Remote-child tests prove the `flock` is held for the complete workload lifetime.
- Profile tests prove cleanup runs after both exit 0 and non-zero, does not run before child start,
  and never changes the workload exit code.
- The existing full `pnpm verify` suite remains green.

## Migration and acceptance

1. Publish and install the new standalone runner.
2. Synchronize the already prepared DataAI workspace copy with the current home workspace.
3. Update Ariadne's manifest to the absolute DataAI root and approved retention values.
4. Run a forced-remote `hostname` canary from the updated consumer and require `pop-os`/exit 0.
5. Run a light remote verify, then the mandatory Ariadne `./scripts/verify --full` acceptance.
6. Confirm stale identities and their Mutagen sessions were pruned while the current identity was
   retained.
7. Remove the old home workspace only after all checks pass and confirm `df` reports DataAI for
   the resolved generated root.

The remote-runner change and Ariadne consumer change are published as separate ready-for-review
PRs. Ariadne's PR records the live migration evidence and leaves no post-merge lifecycle cleanup.
