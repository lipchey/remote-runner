# Self-Healing Bootstrap Artifacts and Falsifiable Local Installs

## Context

Ariadne's `verify-full` workload depends on generated dev-standards bundles that are intentionally
excluded from Mutagen synchronization. The profile builds them in fingerprint-gated `setup`, but
its always-run `ensure` checks only pnpm state. A retained workspace can therefore keep a current
fingerprint after the bundle disappears and fail every workload with exit 127 without any runner
diagnostic or repair path detecting the missing prerequisite.

The incident also exposed two adjacent correctness gaps. Ariadne's pnpm-state repair selects a
different global virtual-store policy solely from `REMOTE_RUNNER_CHILD`, so the repair and the
commands it prepares can disagree. Separately, invoking `remote-runner install` from a source
checkout through an older installed CLI resolves the old immutable app as its source, reports
success, and leaves the stable shim unchanged. The installed CLI has no version or receipt command
that makes this visible.

## Goals

- Make generated bootstrap prerequisites part of the reusable runner contract.
- Re-run setup once when a declared prerequisite disappears despite a current fingerprint.
- Fail closed when setup does not recreate every declared prerequisite.
- Keep pnpm-state repair and the subsequent workload on one virtual-store policy.
- Make a source-checkout install select that checkout, publish a new immutable identity when its
  install inputs change, and expose the installed receipt through `--version`.
- Restore the wedged Ariadne workspace through the ordinary runner lifecycle and prove
  `verify-full` remains remote-only.

## Non-goals

- Synchronizing ignored build outputs through Mutagen.
- Running Ariadne's full `ds-bootstrap.sh` on every preparation.
- Adding consumer-specific dev-standards logic to `remote-runner`.
- Re-enabling local fallback for Ariadne.
- Garbage-collecting immutable local runner app receipts in this change.

## Runner artifact contract

Schema version 1 gains an optional closed field:

```yaml
bootstrap:
  setup:
    - ./scripts/ds-bootstrap.sh
  artifacts:
    - vendor/dev-standards/runner/dist/verify-runner.mjs
    - vendor/dev-standards/runner/dist/.built-from
  ensure:
    - [node, scripts/pnpm-state.mjs]
```

Every artifact is a validated, non-empty repository-relative file path. Absolute paths,
backslashes, control bytes, drive prefixes, empty components, and `.` or `..` components are
rejected during manifest loading. Existing manifests normalize to an empty artifact list and keep
their current behavior.

Artifact existence is a correctness check, not fingerprint input. During preparation the runner
checks every artifact with fixed argv inside the canonical remote workspace. With matching healthy
state, all artifacts must exist and every ensure command must pass before setup is skipped. A
missing artifact or a normal ensure failure invalidates the fast path and runs setup once. After
setup, the runner checks all artifacts again, reruns ensure from the beginning, and writes healthy
state only after both checks pass. A transport/protocol error during artifact inspection fails
closed; it is not treated as an ordinary missing file.

This preserves the existing model: fingerprint is fast invalidation, while artifact and ensure
checks own correctness. It also fixes the whole class of ignored or externally deleted generated
prerequisites without teaching the runner what a dev-standards bundle is.

## Ariadne pnpm convergence

`scripts/pnpm-state.mjs` stops deriving virtual-store policy from
`REMOTE_RUNNER_CHILD`. The probe and repair inherit the same pnpm configuration as the rest of the
current process tree. Remote execution continues to receive
`PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` from `.remote-runner.yaml`, so pnpm-state and every
nested gate use the remote workspace-local store. A manual local child invocation receives no
remote-only store override, so both pnpm-state and its nested gates use the local workspace policy.

The repair command always passes `--config.confirm-modules-purge=false` because the script is
non-interactive in every execution mode. This prevents a no-TTY abort without changing dependency
resolution or weakening `--frozen-lockfile`.

## Falsifiable install and version receipt

`remote-runner install` treats the current working directory as the requested source checkout. It
must contain a valid remote-runner package and a built `dist/src/main.js`; otherwise installation
fails with a clear operational error instead of silently copying the already installed app. This
makes the established workflow deterministic:

```text
cd <remote-runner-checkout>
pnpm build
remote-runner install
```

The immutable app identity hashes the compiled application, launcher assets, runtime dependency,
and source package metadata. Installation writes a bounded receipt containing schema version,
package version, and the 24-character app identity. The stable shim and LaunchAgent are updated
only through their existing ownership checks and atomic replacement path. Reinstalling identical
inputs remains idempotent; changed inputs necessarily select a different app directory.

Successful install output includes the package version and app identity. The installed
`remote-runner --version` reads the embedded receipt and prints the same values. A missing,
malformed, or mismatched receipt fails closed rather than reporting an unverifiable version.

## Components and repository boundaries

`remote-runner` owns:

- manifest types, parsing, and path validation for `bootstrap.artifacts`;
- artifact inspection and setup convergence semantics;
- fixed-argv Linux execution of artifact checks;
- install source selection, immutable receipt creation, and `--version` output;
- reusable unit tests and contract documentation.

Ariadne owns:

- the two exact dev-standards artifact declarations;
- pnpm-state repair arguments and their regression tests;
- consumer contract tests and live remote acceptance evidence.

The changes ship as two ready-for-review PRs. The runner PR is the contract provider and the
Ariadne PR is its consumer. Local acceptance installs the verified runner branch before validating
the Ariadne manifest; production merge order is runner first, Ariadne second.

## Failure semantics and safety

- Invalid artifact paths fail before SSH or filesystem access.
- Artifact checks never interpolate shell strings or follow consumer-provided absolute paths.
- A missing artifact can trigger setup only once per preparation.
- Persistent artifact absence, setup failure, ensure failure, or inspection protocol failure
  leaves prior healthy state untouched and blocks the workload.
- Install refuses foreign shims, plists, app directories, invalid source roots, and invalid
  receipts using the existing owned-artifact boundary.
- Neither fix enables local fallback or changes Ariadne's `mode: remote`, `fallback: fail` policy.

## Testing and live acceptance

Runner red-green tests cover manifest normalization and hostile paths, matching-fingerprint
artifact loss, setup retry, persistent absence, protocol errors, fixed-argv remote checks, install
from current checkout, changed-source identity, idempotent reinstall, receipt validation, and
`--version` output. The complete runner `pnpm verify` gate must pass.

Ariadne red-green tests prove artifact declarations and identical pnpm virtual-store selection with
and without `REMOTE_RUNNER_CHILD`; repair remains frozen and non-interactive. The existing policy
test suite and mandatory `./scripts/verify --full` gate must pass.

For the live regression, use the existing wedged `ariadne-16b` workspace whose verify-runner bundle
is absent. After installing the verified runner build, an ordinary remote preparation must detect
the missing declared artifact, run setup, recreate the bundle and stamp, and complete a lightweight
remote canary. Final acceptance runs `./scripts/verify --full` from current Ariadne `main`, requires
runner logs with `mode=remote` and `status=0`, confirms the checked-out SHA matches local main, and
confirms the report remains under `/mnt/DataAI` with no local fallback event.
