# Remote Runner Design

> **Status:** implemented and live-accepted on 2026-07-31; lifecycle is recorded in
> `docs/superpowers/plans/2026-07-31-remote-runner-implementation.md`.
>
> **Initial consumer:** Ariadne full verification.

## 1. Mission

`remote-runner` runs repository-defined workloads on a trusted, more powerful workstation while
editing and source control remain on the developer laptop. It synchronizes required inputs,
prepares the remote environment, streams results, and applies an explicit fallback policy.

The initial workload is Ariadne’s `./scripts/verify --full`. Future opt-in profiles may cover
builds, benchmarks, static analysis, corpus processing, and other CPU-intensive developer tasks.
The first release is not a distributed scheduler, multi-host orchestrator, or remote editor.

Normal operation requires no manual daemon, session, dependency, workspace, or machine-selection
management. Diagnostic and repair commands exist only for exceptional investigation.

## 2. Ownership boundary

This repository owns lifecycle and login startup, SSH trust and connectivity, Mutagen sessions,
Git-backed remote workspaces, native remote bootstrap, dependency fingerprints, command streaming,
fallback state, ephemeral secret transport, Telegram notification, diagnostics, logs, repairs,
runbook, generic tests, live acceptance, and benchmark collection.

A consuming repository owns only:

- a versioned `.remote-runner.yaml` manifest without secret values;
- a minimal invocation seam from its existing command and, optionally, its worktree hook;
- workload-specific fingerprint inputs, allowed ephemeral environment names, and exclusions;
- consumer-level evidence proving that existing command semantics are preserved.

Generic implementation is never copied into a consumer. Consumer documentation describes only its
adapter contract and points here for system behavior.

## 3. User experience

After one installation by the implementation workflow, a macOS LaunchAgent starts the per-user
controller at login. The controller keeps background synchronization state healthy. Every
`remote-runner run <profile>` invocation also validates and repairs all required state, so
correctness never depends solely on that background process. The command defaults to the workload
declared in the manifest; `-- <command...>` is an explicit override. `REMOTE_RUNNER_MODE` is parsed
inside this package, never by a consumer adapter.

Output stays attached to the invoking terminal and the selected process exit status is returned
unchanged. Healthy operation never asks the owner to start, stop, resume, flush, install, clean, or
choose a machine.

Profiles support three modes:

- `auto` uses the remote when preparation reaches the child-start boundary and otherwise applies
  its declared fallback;
- `local` bypasses remote state and never changes outage state;
- `remote` fails closed if preparation cannot complete.

Fallback is allowed only before the remote child starts. A remote child’s non-zero exit, signal,
timeout, or workload error is authoritative and never triggers a local retry.

## 4. Diagnostic interface

The product path is `run`. Exceptional investigation uses:

- `status [profile]` for concise lifecycle/session/workspace state;
- `doctor [profile]` for read-only checks with stable reason codes;
- `logs [profile]` for bounded recent logs;
- `repair <profile> --dry-run` before `repair <profile> --apply`;
- `benchmark <profile>` for the declared performance matrix.

These commands support the runbook and are not part of daily management.

## 5. Profile manifest

Each consumer commits a closed-schema `.remote-runner.yaml`. A profile declares its ID and schema
version, mode and fallback policy, remote target, workspace namespace, source root, synchronization
exclusions, required remote capabilities, bootstrap versions, setup and fingerprint inputs,
workload arguments, remote-child marker, allowed ephemeral environment names, probe timeouts,
notification policy, and benchmark matrix.

Unknown fields, unsafe paths, duplicate IDs, interpolated shell fragments, unallowlisted
environment names, and destructive targets outside generated roots fail validation. The manifest
contains no token, credential-bearing URL, database value, private key, or environment dump.

## 6. Architecture

### 6.1 Controller and locking

The controller performs login-time reconciliation and bounded observation. Each invocation can
reconstruct state from manifests and durable records after a controller crash.

Transitions are serialized per profile/worktree with owner-scoped locks and stale-owner recovery.
Independent identities may prepare concurrently. A contending invocation reports its owner and
waits only for a bounded period; it never starts a second mutation for the same identity.

The invocation process owns terminal streaming and final exit status. The controller never detaches
a user-requested workload.

### 6.2 Remote trust and availability

Endpoints use OpenSSH configuration or an explicit profile target. Probes use batch mode, bounded
timeouts, and strict host-key verification. Setup may enroll a MagicDNS alias only after its
fingerprint matches a separately trusted key for the same workstation.
`StrictHostKeyChecking=no` is forbidden.

Two short probes prevent one transient failure from immediately becoming an outage. Stable reason
codes distinguish DNS, host-key, authentication, transport, remote-shell, capacity, and bootstrap
failures without putting raw output into notifications.

### 6.3 Git-backed remote workspaces

Each local Git worktree maps to an opaque identity derived from its canonical root. Branch names
are labels, never path input. The workstation stores a private bare mirror per consumer and
generated worktrees below:

`~/.cache/remote-runner/workspaces/<consumer>/<identity>/`

Before synchronization, the system pauses the session, pushes local `HEAD` to a private workstation
ref over SSH, resets only the confined generated worktree, and initializes required submodules.
This preserves Git semantics without publishing work-in-progress to GitHub.

Remote destructive operations are rejected unless their canonical target is strictly below the
declared generated root.

### 6.4 Synchronization

The first provider is Mutagen over SSH in `one-way-replica` mode. Alpha is the laptop worktree;
beta is the generated remote Git worktree. The laptop is authoritative and remote output never
flows back.

VCS metadata, dependencies, package stores, build output, caches, coverage, artifacts, logs,
temporary files, Python environments/caches, plaintext environment files, secret keys,
platform-specific binaries, and remote-runner state are ignored. Manifests, lockfiles, source,
configuration, migrations, tests, fixtures, and version metadata remain synchronized.

An explicit successful flush is mandatory after Git reconciliation and before fingerprinting or
execution. A disconnected, conflicted, paused, or unflushable session is unavailable until
self-repair succeeds.

### 6.5 Native remote bootstrap

Workloads run natively. Profiles declare required versions; bootstrap installs them without sudo
below `~/.local/share/remote-runner/toolchains/`.

The Node provider downloads the laptop’s exact Node version for the remote architecture from the
official distribution, verifies its published SHA-256 manifest, extracts into a temporary
directory, and promotes atomically. It installs the package-manager version declared by the
consumer. Other providers cover pinned uv and gitleaks versions.

Failures leave the last healthy environment active. Dependency fingerprints include the effective
environment identity and every declared manifest, lockfile, workspace definition, submodule pin,
setup script, and version input. Setup runs only after a change and persists the new fingerprint
only after success. Dependencies and generated output stay on their creating machine.

### 6.6 Ephemeral environment

Profiles allowlist required environment names. A local provider returns only those values. The
invocation frames them over SSH stdin; values never enter argv, command strings, synchronization
configuration, fingerprints, logs, notifications, or persistent remote files.

A fixed remote launcher validates the frame, constructs the child environment, clears its buffer,
closes input, and starts the workload. Missing, malformed, oversized, duplicate, or unallowlisted
fields fail before the child-start boundary. The initial Ariadne profile allows only its
development database credential.

For the common development case, the manifest may name a confined ignored dotenv file. The runner
parses it locally and retains only allowlisted keys. A bounded argv provider remains an alternative;
exactly one source is required.

### 6.7 Notifications and durable state

The first notifier uses Telegram `sendMessage` with `~/.claude/.telegram-ask.conf`. The config
must belong to the current user, have no group/other permissions, and contain a token plus numeric
chat ID. Values remain local.

The first automatic fallback in an outage sends one alert. Repeated fallbacks remain loud in the
terminal without spamming. Failed delivery is retried later. The first remote child after an outage
sends one recovery message regardless of its eventual workload verdict.

Messages contain only consumer/profile labels, remote label, stable reason, timestamp, and
fallback/recovery state. Notification failure never blocks fallback but is visible in stderr.

Versioned state lives under `~/.local/state/remote-runner/` with restrictive permissions and
atomic writes. Structured logs are redacted, bounded, and rotated. Corrupt records are retained for
diagnosis before safe reconstruction.

## 7. Automatic lifecycle

Installation writes a versioned macOS LaunchAgent and stable user-level executable. Login startup
is idempotent. Upgrade replaces owned files atomically, restarts only the owned controller, and
preserves compatible state.

Every `run`, even with a healthy controller, performs:

1. profile and local-prerequisite validation;
2. per-identity lock acquisition;
3. host identity and connectivity checks;
4. Mutagen daemon start/reconnect;
5. session create/resume;
6. Git workspace reconciliation;
7. synchronization flush;
8. bootstrap and dependency reconciliation by fingerprint;
9. allowed environment framing;
10. remote child start and preparation-lock release.

Linux needs no resident remote-runner daemon. Existing `sshd` and `tailscaled` services provide
reboot persistence, and Mutagen deploys its matching agent over SSH.

Preparation may retry bounded idempotent operations. A workload is never retried after its
child-start boundary.

`prewarm <profile>` uses this same lifecycle in forced-remote mode and converts any failure into a
visible successful hook result. This prepares synchronization and machine-local dependencies at
worktree creation without making worktree creation depend on workstation availability.

## 8. Diagnostic runbook

`docs/RUNBOOK.md` is a required implementation deliverable. It provides symptom-first,
copy-paste-safe procedures for:

- determining whether a command ran locally or remotely;
- checking LaunchAgent, controller, Mutagen, SSH/Tailscale, host key, workspace, disk, bootstrap,
  fingerprint, and notification state;
- reading bounded logs and interpreting every reason code;
- validating synchronization with a harmless canary;
- previewing and applying repair for one profile/worktree;
- recreating one session or generated workspace without touching other state;
- reinstalling one user-scoped remote environment;
- validating Telegram config without printing it;
- recovering after login, workstation reboot, address change, interrupted install, corrupt state,
  and upgrade;
- uninstalling only owned launch, executable, state, cache, and remote workspace paths;
- collecting a privacy-safe diagnostic bundle.

Every mutating instruction has a read-only or dry-run predecessor and names its exact confined
target. Routine use of the runbook is not acceptance; healthy operation must stay automatic.

## 9. Testing and acceptance

Deterministic tests inject processes, filesystem, clocks, hashes, locks, transports, notification,
and profile inputs. They cover schema validation, execution modes, child-start boundary, exit and
signal propagation, controller-down self-healing, concurrent serialization, path confinement, Git
refs, reconcile/flush/setup ordering, ignore rules, checksum and atomic promotion, fingerprint
invalidation, framed secrets, outage/recovery state, redaction, corrupt state, log rotation, login
installation, diagnostics, and repair dry runs.

Live acceptance proves:

1. clean laptop installation and login startup;
2. workstation bootstrap with no preinstalled Node/package manager;
3. live source synchronization and generated-state isolation;
4. dirty and untracked source visibility remotely;
5. one setup per changed fingerprint;
6. exact output and verdict propagation;
7. no local retry after remote workload failure;
8. unavailable workstation means one alert plus declared fallback;
9. repeated outage does not spam;
10. restored remote child sends one recovery alert;
11. workstation reboot restores access and self-healed execution;
12. controller termination is repaired by the next invocation;
13. secret canaries are absent from argv, repositories, persistent remote files, logs, and
    diagnostics;
14. every runbook diagnosis and confined repair works against a broken fixture.

Outage fixtures never disable the only connection needed for recovery.

## 10. Benchmark

The benchmark records synchronization, bootstrap/setup, and workload time separately. It compares
identical source and versions with an untimed warm-up, at least three cold-cache and three
warm-cache runs, wall time, status, cache hit ratio, CPU/load, peak memory when available, and
transfer volume.

Reports give median and range and state whether the remote materially reduces laptop CPU pressure.
The Ariadne adapter supplies its concrete test, fast-verification, and full-verification commands.

## 11. Security constraints

- Trusted single-owner workstations only in the first release.
- Strict SSH verification; no unverified trust-on-first-use.
- Remote destructive actions confined below generated cache roots.
- No environment dump or secret persistence on the workstation.
- No production credential in the initial profile.
- Argument arrays and fixed launchers instead of interpolated shell fragments.
- Fail closed on invalid profiles, unsafe paths, permissions, framed input, or checksum.
- Fallback never changes workload semantics or converts a remote verdict into a pass.

## 12. Non-goals

- Remote editing or bidirectional source synchronization.
- Cloud CI replacement, public SaaS, or multi-user scheduling.
- Commands from untrusted repositories.
- Synchronizing dependencies, caches, artifacts, or secrets.
- Managing Tailscale accounts, firewall policy, or Wake-on-LAN in the first release.
- Starting expensive work without an explicit consumer command.

## 13. Completion criteria

The first release is complete only when core tests and live acceptance pass; login and invocation
self-healing survive controller termination and workstation reboot; the Ariadne adapter preserves
full-verification semantics; Telegram outage/recovery is proven without leakage; the
laptop-versus-workstation benchmark is recorded; the runbook covers every reason code and repair;
install, upgrade, diagnostics, repair, and uninstall are verified on exact owned paths; and both
repositories record acceptance evidence before ready-for-review pull requests.
