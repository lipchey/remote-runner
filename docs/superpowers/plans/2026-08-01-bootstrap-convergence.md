# Bootstrap Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dependency fingerprints automatically include newly added project manifests while an always-run, cheap ensure command prevents a missed input from leaving the remote environment silently stale.

**Architecture:** The manifest accepts exact fingerprint files plus safe Git-style glob patterns and optional fixed-argv ensure commands. The local controller expands patterns over tracked and non-ignored untracked files, hashes the sorted path/content set, and treats the fingerprint as a setup optimization. On every preparation, ensure commands run; a failed ensure triggers the full setup once and then a mandatory ensure retry before healthy state is recorded.

**Tech Stack:** TypeScript, Node.js process/filesystem APIs, Git pathspecs, YAML, Vitest, pnpm.

**Status:** Completed on 2026-08-01. The implementation is in commit `fd93782`; publication is this PR.

**Acceptance evidence:** `pnpm verify` passed typecheck, 405/405 tests, and build. A live Ariadne Linux canary changed the dependency fingerprint from `sha256:87daf75c6f54a1cc78a8836d7664961b34611aeaa73131509d4749950f1025eb` to `sha256:bb5931ff83972e04636d6637e98cc54df4e0bddbea5da71cbd5b6f52d189d1cb`; removing the canary restored the exact baseline. The installed runner accepted the new manifest, remote `./scripts/verify --full` exited 0, and Ariadne PR #193 is open, ready, and mergeable.

---

### Task 1: Extend the validated manifest contract

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/load-manifest.ts`
- Modify: `tests/unit/config/manifest-fixture.ts`
- Test: `tests/unit/config/load-manifest.test.ts`

- [x] **Step 1: Write failing parser tests**

Add tests proving that this shape is accepted and normalized:

```yaml
bootstrap:
  node: local-exact
  packageManager: package.json
  setup: [./scripts/ds-bootstrap.sh]
  ensure:
    - [node, scripts/pnpm-state.mjs]
  fingerprint:
    files: [package.json, pnpm-lock.yaml]
    patterns: ["**/package.json", "**/uv.lock"]
```

Also prove that the legacy `fingerprint: [package.json]` form normalizes to `{ files: [...], patterns: [] }`, and reject unsafe patterns, empty ensure commands, NUL arguments, and unknown fingerprint fields.

- [x] **Step 2: Run the parser tests and observe RED**

Run: `pnpm vitest run tests/unit/config/load-manifest.test.ts`

Expected: failures because `ensure` and object-form `fingerprint` are not recognized.

- [x] **Step 3: Implement the normalized types and parser**

Define:

```ts
bootstrap: {
  node: "local-exact";
  packageManager: string;
  setup: string[];
  ensure: string[][];
  fingerprint: { files: string[]; patterns: string[] };
}
```

Accept the legacy array as `files` with no patterns. Validate patterns as non-empty repository-relative glob strings with no absolute root, backslash, control byte, drive prefix, `:` magic prefix, or `.`/`..` path component. Reuse fixed-argv `commandArray` validation for every ensure command.

- [x] **Step 4: Run parser tests and observe GREEN**

Run: `pnpm vitest run tests/unit/config/load-manifest.test.ts`

Expected: all parser tests pass.

### Task 2: Discover fingerprint files without manual package enumeration

**Files:**

- Modify: `src/app/pilot-services.ts`
- Test: `tests/unit/app/pilot-services.test.ts`

- [x] **Step 1: Write failing discovery tests**

Add tests for `listLocalFingerprintFiles` using a fake process runtime. Assert that it:

```ts
expect(request.args).toContain(":(glob)**/package.json");
expect(result).toEqual(["apps/api/package.json", "packages/new/package.json"]);
```

Cover tracked files, non-ignored untracked files, duplicate output, a tracked deletion returned by the deleted-file query, malformed/non-UTF-8 output, and bounded Git capture.

- [x] **Step 2: Run the pilot-service tests and observe RED**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts`

Expected: failure because pattern discovery does not exist.

- [x] **Step 3: Implement bounded Git discovery**

Run fixed-argv Git commands equivalent to:

```sh
git -C <source> ls-files -z --cached --others --exclude-standard -- <glob-pathspecs>
git -C <source> ls-files -z --deleted -- <glob-pathspecs>
```

Decode UTF-8 strictly, subtract deleted paths, validate every returned path as a safe repository path, deduplicate, and sort. Merge the discovered set with exact files before calling `dependencyFingerprint`; path identity and contents remain part of the digest, and gitlink OIDs remain automatic.

- [x] **Step 4: Run pilot-service tests and observe GREEN**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts`

Expected: all pilot-service tests pass.

### Task 3: Make ensure the correctness gate and fingerprint an optimization

**Files:**

- Modify: `src/bootstrap/dependencies.ts`
- Test: `tests/unit/bootstrap/dependencies.test.ts`

- [x] **Step 1: Write failing convergence tests**

Add four behavioral tests:

```ts
// matching fingerprint + successful ensure => setup is skipped
// matching fingerprint + failed ensure => setup runs, then every ensure retries
// changed fingerprint => setup runs before ensure
// ensure still failing after setup => healthy state is not written
```

Use fixed command arrays such as `["node", "scripts/pnpm-state.mjs"]` and assert the exact call order.

- [x] **Step 2: Run dependency setup tests and observe RED**

Run: `pnpm vitest run tests/unit/bootstrap/dependencies.test.ts`

Expected: failures because matching fingerprints currently skip all validation.

- [x] **Step 3: Implement convergence semantics**

Extend `DependencySetupRuntime` with:

```ts
runEnsure(command: readonly string[], workspaceRoot: string, environment: EnvironmentIdentity): Promise<{ exitCode: number }>;
```

When previous state matches, run all ensure commands. If any fails, run setup once, rerun all ensures from the beginning, and write healthy state only after success. When the fingerprint changes, run setup first and then all ensures. Preserve legacy behavior when `ensure` is empty.

- [x] **Step 4: Run dependency setup tests and observe GREEN**

Run: `pnpm vitest run tests/unit/bootstrap/dependencies.test.ts`

Expected: all dependency convergence tests pass.

### Task 4: Execute ensure commands safely on Linux

**Files:**

- Modify: `src/app/pilot-services.ts`
- Test: `tests/unit/app/pilot-services.test.ts`

- [x] **Step 1: Write a failing fixed-argv integration test**

Assert that preparation passes each ensure command to the remote runtime as separate argv values, changes into the generated workspace, uses the managed toolchain `PATH`, exports `REMOTE_RUNNER_CHILD=1`, and never invokes a shell-interpolated command string.

- [x] **Step 2: Run the test and observe RED**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts`

Expected: failure because `runEnsure` is not wired.

- [x] **Step 3: Wire remote ensure execution**

Use a fixed shell wrapper only for `cd` and environment setup:

```sh
cd -- "$1"; export PATH=$2; export REMOTE_RUNNER_CHILD=1; shift 2; exec "$@"
```

Pass the validated ensure command after the positional workspace and PATH arguments. Do not stream successful ensure output or expose secrets.

- [x] **Step 4: Run pilot-service and profile-runtime tests**

Run: `pnpm vitest run tests/unit/app/pilot-services.test.ts tests/unit/app/profile-runtime.test.ts`

Expected: all tests pass.

### Task 5: Document the reusable contract and update Ariadne

**Files:**

- Modify: `README.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/specs/2026-07-31-remote-runner-design.md`
- Modify: `/Users/admin/Projects/worktrees/ariadne-remote-verify-plan/.remote-runner.yaml`
- Modify: `/Users/admin/Projects/worktrees/ariadne-remote-verify-plan/docs/specs/2026-07-31-remote-runner-ariadne-adapter-design.md`
- Modify: `/Users/admin/Projects/worktrees/ariadne-remote-verify-plan/docs/acceptance/2026-07-31-remote-runner-pilot.md`

- [x] **Step 1: Replace Ariadne's package allowlist**

Use exact setup inputs plus automatic manifest discovery:

```yaml
ensure:
  - [node, scripts/pnpm-state.mjs]
fingerprint:
  files:
    - .remote-runner.yaml
    - package.json
    - pnpm-lock.yaml
    - pnpm-workspace.yaml
    - .gitmodules
    - scripts/ds-bootstrap.sh
    - scripts/install-gitleaks.sh
  patterns:
    - "**/package.json"
    - "**/pyproject.toml"
    - "**/uv.lock"
```

Do not list `vendor/dev-standards`: all gitlinks are already fingerprinted automatically.

- [x] **Step 2: Document behavior and failure semantics**

State that patterns include tracked and non-ignored untracked files; ensure runs on every remote preparation; a failed ensure triggers one full setup and a mandatory retry; persistent failure is fail-closed. Add runbook diagnosis for `bootstrap ensure failed` without suggesting manual package-list maintenance.

- [x] **Step 3: Update acceptance evidence**

Record deterministic tests and the live Linux canary: add a temporary zero-dependency package manifest under an existing workspace glob, confirm the remote fingerprint changes and setup executes, then remove it and confirm convergence leaves no dirty files.

### Task 6: Verify, publish, install, and run live acceptance

**Files:**

- Verify all changed files in both worktrees.

- [x] **Step 1: Run remote-runner verification**

Run: `pnpm verify`

Expected: typecheck, all Vitest tests, and build pass.

- [x] **Step 2: Commit and publish remote-runner**

Commit the plan, implementation, tests, and docs on `codex/fingerprint-convergence`; push it and open a ready-for-review PR. Verify the returned URL.

- [x] **Step 3: Install the verified branch build user-locally**

Run the built `remote-runner install` from the feature worktree, then confirm `remote-runner validate verify-full` accepts Ariadne's new manifest.

- [x] **Step 4: Run Ariadne acceptance on Linux**

Run targeted manifest validation, `remote-runner prewarm verify-full` with a temporary new package manifest, and `./scripts/verify --full` from the Ariadne feature worktree. Confirm remote status reports `workspace=ready fingerprint=current` and no local fallback notification was produced.

- [x] **Step 5: Commit and republish Ariadne PR #193**

Commit the manifest and documentation updates on `codex/remote-verify-plan`, push the branch, verify PR #193 remains open and ready, and confirm both worktrees are clean.
