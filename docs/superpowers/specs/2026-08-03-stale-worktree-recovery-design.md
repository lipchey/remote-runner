# Stale Remote Worktree Recovery

## Context

Remote workspace retention deletes generated workspace directories after their grace and lock
protections expire. The shared bare Git mirror can still retain a `worktree` administration record
for a deleted directory. During the next reconciliation, `git worktree list --porcelain` reports
that stale record with a `prunable` annotation. The runner currently treats the matching
`worktree <candidate>` line as proof that the candidate exists, skips `worktree add`, and then fails
when it changes directory into the missing workspace. An `auto` profile falls back locally with the
coarse reason `workspace`.

Diagnostics also build workspace paths below the legacy remote-home cache even when a profile
selects an absolute `workspace.generatedRoot`. That produces misleading capacity and workspace
failures for DataAI-backed profiles and obscures the stale-registration condition.

## Goals

- Reconcile a missing generated workspace even when the mirror retains a prunable registration.
- Keep pruning and all subsequent destructive Git operations inside the existing consumer lock.
- Preserve confinement, ownership, mode, symlink, output-bound, and fail-closed guarantees.
- Leave valid registered worktrees untouched and reusable.
- Make diagnostics use the manifest-selected generated root.
- Give `doctor` a stable, secret-free reason for a missing workspace whose exact mirror
  registration is stale.
- Cover the production failure with a real Git regression test and preserve the existing full
  verification gate.

## Non-goals

- Periodic cleanup, cron jobs, or consumer-side repair scripts.
- Broad removal of remote workspace directories.
- Weakening retention locks, grace periods, or path validation.
- Parsing or exposing raw Git/SSH stderr through diagnostics.

## Reconciliation design

The existing remote reconciliation transaction already holds the consumer-wide `flock`, validates
the generated root and mirror, and changes into the bare mirror before listing worktrees. At that
point it will run:

```sh
git --git-dir=. worktree prune --expire=now
```

The command is intentionally inside `set -e` and before `worktree list --porcelain`. A prune failure
therefore remains a `workspace` preparation failure. Git removes only administrative records it
already considers prunable; it does not delete valid worktree directories. The following listing
then represents live registrations, so an absent candidate takes the existing confined
`worktree add --force --detach` path. Existing candidates continue through reset, clean, and
submodule convergence without being recreated.

Using `--expire=now` is deliberate: the runner owns this mirror and retention has already decided
when a generated directory may be removed. Leaving Git's default expiry window would preserve the
failure during that window. The consumer lock serializes prune with prepare, receive-pack,
reconciliation, and other profiles sharing the mirror.

## Diagnostics design

Diagnostic path construction will honor `workspace.generatedRoot`:

- the legacy literal resolves below the remote home as before;
- a canonical absolute root is passed as the exact fixed SSH argument;
- workspace, mirror, capacity, and secrets probes derive their targets from that resolved form.

`doctor` gains a read-only `remote.workspace-registration` probe with stable reason
`workspace-registration`. It succeeds when the candidate directory exists, when the mirror does
not yet exist, or when no exact candidate registration exists. It fails only when the candidate is
missing and `git worktree list --porcelain` contains the exact `worktree <candidate>` record. Raw
remote output is never included in the report.

Ordinary `run` remains the repair path. `doctor` observes and classifies the condition but does not
mutate the mirror.

## Testing

- Add a real bare-mirror regression fixture that registers a worktree, removes its directory while
  retaining the administration record, verifies the record is prunable, then runs the production
  reconciliation transaction and requires the candidate to be recreated at the requested OID.
- Preserve a countertest proving a valid registered candidate is reused.
- Assert transaction ordering: consumer lock, prune, worktree listing, optional add, then reset and
  cleanup.
- Add diagnostic tests for legacy and absolute generated roots and for the exact stale-registration
  reason without raw output.
- Run focused workspace/diagnostic tests, then `pnpm verify` (format, typecheck, all tests, build).

## Acceptance

The change is accepted when the regression test fails without the prune, passes with it, valid
worktree reuse remains green, DataAI diagnostics address the configured absolute root, the new
doctor reason is stable and secret-free, and the complete repository verification passes.
