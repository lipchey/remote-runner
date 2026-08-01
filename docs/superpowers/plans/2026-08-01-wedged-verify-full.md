# Wedged Verify-Full Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote bootstrap artifacts self-healing, make local runner installs falsifiable, and update Ariadne so `verify-full` cannot wedge on a missing ignored bundle or inconsistent pnpm policy.

**Architecture:** `remote-runner` adds an optional artifact list to its bootstrap convergence contract and validates those files before accepting a matching fingerprint. Its installer selects the built current checkout and embeds an immutable version receipt. Ariadne declares its generated dev-standards prerequisites and lets pnpm-state inherit the same virtual-store policy as the workload while forcing only the non-interactive purge decision.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, YAML, Vitest, Bash, pnpm 11, SSH, Mutagen, GitHub CLI.

**Status:** Planned on 2026-08-01 from design commit `de0323a`.

---

### Task 1: Extend the runner manifest with bootstrap artifacts

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/load-manifest.ts`
- Modify: `tests/unit/config/manifest-fixture.ts`
- Test: `tests/unit/config/load-manifest.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Add a valid fixture shape and assertions equivalent to:

```ts
bootstrap: {
  node: "local-exact";
  packageManager: string;
  setup: string[];
  artifacts: string[];
  ensure: string[][];
  fingerprint: { files: string[]; patterns: string[] };
}

expect(manifest.profiles[0]?.bootstrap.artifacts).toEqual([
  "vendor/dev-standards/runner/dist/verify-runner.mjs",
  "vendor/dev-standards/runner/dist/.built-from",
]);
```

Also prove omission normalizes to `[]`, and reject `/tmp/bundle`, `../bundle`,
`runner/./bundle`, `runner//bundle`, a backslash path, and a NUL-containing path.

- [ ] **Step 2: Run the parser tests and observe RED**

Run: `rtk pnpm exec vitest run tests/unit/config/load-manifest.test.ts`

Expected: FAIL because `bootstrap.artifacts` is an unknown field and the normalized type has no
artifact list.

- [ ] **Step 3: Implement the normalized contract**

Extend the bootstrap type with `artifacts: string[]`. Add `artifacts` to the closed bootstrap keys
and parse it with the existing safe repository-path validator:

```ts
const bootstrap = closed(
  source.bootstrap,
  ["node", "packageManager", "setup", "artifacts", "ensure", "fingerprint"],
  "bootstrap",
);

artifacts: bootstrap.artifacts === undefined ? [] : safePaths(bootstrap.artifacts, "bootstrap artifact"),
```

Keep schema version 1 and preserve every existing manifest through the empty-list default.

- [ ] **Step 4: Run the parser tests and observe GREEN**

Run: `rtk pnpm exec vitest run tests/unit/config/load-manifest.test.ts`

Expected: all manifest tests pass.

- [ ] **Step 5: Commit the contract slice**

```bash
rtk git add -- src/config/types.ts src/config/load-manifest.ts tests/unit/config/manifest-fixture.ts tests/unit/config/load-manifest.test.ts
rtk git commit -m "feat: declare bootstrap artifacts"
```

### Task 2: Make artifact presence part of dependency convergence

**Files:**

- Modify: `src/bootstrap/dependencies.ts`
- Test: `tests/unit/bootstrap/dependencies.test.ts`

- [ ] **Step 1: Write failing convergence tests**

Extend `FakeRuntime` with a deterministic artifact result queue and record calls as
`artifact:<path>:<workspace>`. Add tests proving:

```ts
it("reruns setup when a current fingerprint loses a declared artifact", async () => {
  const runtime = new FakeRuntime(
    { fingerprint: input.fingerprint, environment },
    {
      artifactExitCodes: [1, 0, 0],
    },
  );
  await expect(ensureDependencySetup(runtime, input)).resolves.toMatchObject({ setupRan: true });
  expect(runtime.calls).toContain("run:./scripts/ds-bootstrap.sh:/workspaces/ariadne:26.5.0-linux-x64");
  expect(runtime.writes).toHaveLength(1);
});

it("fails closed when setup does not recreate an artifact", async () => {
  const runtime = new FakeRuntime(
    { fingerprint: input.fingerprint, environment },
    {
      artifactExitCodes: [1, 1],
    },
  );
  await expect(ensureDependencySetup(runtime, input)).rejects.toThrow(/bootstrap artifact.*missing/u);
  expect(runtime.writes).toEqual([]);
});
```

Add one test for an artifact check exit code other than `0` or `1`; it must fail immediately as an
inspection error and must not guess that setup is safe. Preserve the existing empty-artifact and
empty-ensure behavior.

- [ ] **Step 2: Run the dependency tests and observe RED**

Run: `rtk pnpm exec vitest run tests/unit/bootstrap/dependencies.test.ts`

Expected: FAIL because the runtime and input have no artifact-check seam.

- [ ] **Step 3: Implement one-shot artifact convergence**

Add these interfaces:

```ts
checkArtifact(
  artifact: string,
  workspaceRoot: string,
): Promise<{ readonly exitCode: number }>;

readonly artifacts: readonly string[];
```

Implement `checkArtifacts(runtime, input, failClosed)` so exit `0` means present, exit `1` means
missing, and any other or non-integer exit throws an inspection error. The matching-state fast path
must be:

```ts
if (
  previous?.fingerprint === input.fingerprint &&
  sameEnvironment(previous.environment, input.environment) &&
  (await checkArtifacts(runtime, input, false)) &&
  (await runEnsure(runtime, input, false))
) {
  return { fingerprint: input.fingerprint, environment: input.environment, setupRan: false };
}
```

After `runSetup`, call `checkArtifacts(..., true)` before `runEnsure(..., true)`. Write healthy
state only after both succeed. Validate every artifact with the same `safeRelative` predicate used
for setup scripts.

- [ ] **Step 4: Run the dependency tests and observe GREEN**

Run: `rtk pnpm exec vitest run tests/unit/bootstrap/dependencies.test.ts`

Expected: all convergence tests pass, including old fingerprint-only compatibility.

- [ ] **Step 5: Commit the convergence slice**

```bash
rtk git add -- src/bootstrap/dependencies.ts tests/unit/bootstrap/dependencies.test.ts
rtk git commit -m "feat: self-heal missing bootstrap artifacts"
```

### Task 3: Execute artifact checks safely on Linux

**Files:**

- Modify: `src/app/pilot-services.ts`
- Test: `tests/unit/app/pilot-services.test.ts`

- [ ] **Step 1: Write a failing fixed-argv test**

Extend the existing preparation test to declare one artifact and assert that the remote process
request executes `test -f` as separate arguments from the canonical workspace:

```ts
expect(request.args).toEqual(
  expect.arrayContaining(["test", "-f", "vendor/dev-standards/runner/dist/verify-runner.mjs"]),
);
```

Assert the artifact check occurs before setup is skipped and that no joined/interpolated command
contains the artifact path.

- [ ] **Step 2: Run the pilot-service test and observe RED**

Run: `rtk pnpm exec vitest run tests/unit/app/pilot-services.test.ts`

Expected: FAIL because profile preparation never checks declared artifacts.

- [ ] **Step 3: Wire the remote runtime**

Pass `this.profile.bootstrap.artifacts` into `ensureDependencySetup`. Implement the runtime method
with the existing fixed workspace command wrapper:

```ts
checkArtifact: async (artifact, workspaceRoot) => {
  const result = await remote.run(
    remoteWorkspaceCommandArguments(workspaceRoot, pathEnvironment, ["test", "-f", artifact]),
  );
  return { exitCode: result.exitCode };
},
```

Do not add a shell-interpolated path or an Ariadne-specific bundle check.

- [ ] **Step 4: Run focused runner tests and observe GREEN**

Run: `rtk pnpm exec vitest run tests/unit/app/pilot-services.test.ts tests/unit/bootstrap/dependencies.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit the Linux wiring**

```bash
rtk git add -- src/app/pilot-services.ts tests/unit/app/pilot-services.test.ts
rtk git commit -m "feat: check remote bootstrap artifacts"
```

### Task 4: Make local install provenance and version observable

**Files:**

- Create: `src/node/install-receipt.ts`
- Create: `tests/unit/node/install-receipt.test.ts`
- Modify: `src/node/local-install.ts`
- Modify: `src/main.ts`
- Modify: `tests/unit/node/local-install.test.ts`
- Modify: `tests/unit/main.test.ts`

- [ ] **Step 1: Write failing receipt and install-source tests**

Define the wished-for receipt contract in tests:

```ts
const receipt = {
  schemaVersion: 1 as const,
  version: "0.1.0",
  appIdentity: "a".repeat(24),
};

expect(parseInstallReceipt(formatInstallReceipt(receipt))).toEqual(receipt);
expect(formatInstallVersion(receipt)).toBe(`remote-runner 0.1.0 (app ${"a".repeat(24)})`);
```

Reject extra keys, non-semver versions, non-24-hex identities, invalid JSON, and wrong schema
versions. In local-install tests, change the source fixture package version and compiled source
independently; each change must produce a different app identity. Reinstalling unchanged inputs
must remain idempotent.

In main tests, assert:

```ts
expect(await runMain(["--version"], io, undefined, dependencies)).toBe(0);
expect(stdout).toEqual(["remote-runner 0.1.0 (app aaaaaaaaaaaaaaaaaaaaaaaa)"]);
expect(installSourceRoots).toEqual([process.cwd()]);
```

Also assert `install extra` is rejected and an install failure includes its bounded error message.

- [ ] **Step 2: Run the receipt/install tests and observe RED**

Run: `rtk pnpm exec vitest run tests/unit/node/install-receipt.test.ts tests/unit/node/local-install.test.ts tests/unit/main.test.ts`

Expected: FAIL because receipts, checkout provenance, and `--version` do not exist.

- [ ] **Step 3: Implement the immutable receipt**

Create `install-receipt.ts` with a closed parser/formatter for:

```ts
export interface InstallReceipt {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly appIdentity: string;
}
```

Read and validate `<sourceRoot>/package.json`, include its bytes in the tree digest, and write
`.remote-runner-receipt.json` plus an installed `package.json` containing the validated version and
`type: "module"`. Return `{ appRoot, appIdentity, version, executablePath, plistPath }`.

Change `installCurrentApplication` to accept `sourceRoot = process.cwd()` and require
`<sourceRoot>/dist/src/main.js`, launcher assets, yaml runtime dependency, and package metadata.
Do not fall back to the currently installed module URL when the requested checkout is invalid.

- [ ] **Step 4: Add main command semantics**

Extend `MainDependencies` with an install function receiving `sourceRoot` and a receipt reader.
Handle exact `--version` before delegating to `runCli`. Handle exact `install` by passing
`process.cwd()`, and print:

```text
installed remote-runner 0.1.0 (app <identity>): <executable path>
```

On failure print `remote-runner install failed: <bounded cause>` and return 70. Reject arguments
after `install` with exit 2.

- [ ] **Step 5: Run the receipt/install tests and observe GREEN**

Run: `rtk pnpm exec vitest run tests/unit/node/install-receipt.test.ts tests/unit/node/local-install.test.ts tests/unit/main.test.ts`

Expected: all receipt and install tests pass.

- [ ] **Step 6: Commit the installer slice**

```bash
rtk git add -- src/node/install-receipt.ts src/node/local-install.ts src/main.ts tests/unit/node/install-receipt.test.ts tests/unit/node/local-install.test.ts tests/unit/main.test.ts
rtk git commit -m "fix: install the current runner checkout"
```

### Task 5: Document the reusable runner behavior

**Files:**

- Modify: `README.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/specs/2026-07-31-remote-runner-design.md`
- Modify: `docs/superpowers/plans/2026-08-01-wedged-verify-full.md`

- [ ] **Step 1: Document artifacts and install receipts**

Add the optional `bootstrap.artifacts` example and state that artifacts are checked on every
preparation, missing files trigger setup once, and persistent absence fails closed. Update install
instructions to require a built checkout and show `remote-runner --version` as the receipt check.

- [ ] **Step 2: Add runbook diagnosis**

Document the difference among fingerprint drift, ensure failure, missing bootstrap artifact, and
artifact inspection failure. Do not recommend manual remote bundle creation as a durable fix.

- [ ] **Step 3: Run documentation checks**

Run: `rtk pnpm exec prettier --check README.md docs/RUNBOOK.md docs/specs/2026-07-31-remote-runner-design.md docs/superpowers/specs/2026-08-01-wedged-verify-full-design.md docs/superpowers/plans/2026-08-01-wedged-verify-full.md`

Expected: all matched files use Prettier code style.

- [ ] **Step 4: Commit runner documentation**

```bash
rtk git add -- README.md docs/RUNBOOK.md docs/specs/2026-07-31-remote-runner-design.md docs/superpowers/plans/2026-08-01-wedged-verify-full.md
rtk git commit -m "docs: explain bootstrap artifact recovery"
```

### Task 6: Verify, publish, and install the runner provider

**Files:**

- Verify all files in `/Users/admin/Projects/worktrees/remote-runner-wedged-verify-full`.
- Update: `docs/superpowers/plans/2026-08-01-wedged-verify-full.md`

- [ ] **Step 1: Run the complete runner gate**

Run: `rtk pnpm verify`

Expected: format check, typecheck, all Vitest tests, and build pass.

- [ ] **Step 2: Exercise the upgrade bootstrap path**

The old installed binary cannot contain the new source-selection fix, so perform this first upgrade
through the verified build:

```bash
node dist/src/main.js install
/Users/admin/.local/bin/remote-runner --version
```

Expected: install output and `--version` report the same new app identity; the stable shim names
that immutable app directory. Then run `/Users/admin/.local/bin/remote-runner install` again from
the worktree and require the same identity to prove the fixed installed CLI now selects the current
checkout idempotently.

- [ ] **Step 3: Record provider acceptance before publication**

Update this plan to `Status: Completed`, record the verified test count, installed app identity,
and state that publication is this PR. Run `rtk git diff --check`, commit the evidence, and require a
clean worktree.

- [ ] **Step 4: Push and open a ready runner PR**

```bash
rtk git push -u origin codex/wedged-verify-full
rtk gh pr create --base main --head codex/wedged-verify-full --title "Fix wedged remote bootstrap recovery" --body-file /private/tmp/remote-runner-wedged-verify-full-pr.md
```

Expected: a non-draft PR URL. Verify `rtk gh pr view --json url,isDraft,mergeable,headRefOid` reports
the pushed SHA, `isDraft=false`, and no merge conflict. Poll CI with bounded `rtk gh` status calls.

### Task 7: Create the Ariadne consumer worktree and fix pnpm-state

**Files:**

- Create worktree: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full`
- Modify: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/scripts/pnpm-state.mjs`
- Test: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/scripts/pnpm-state.tests.mjs`

- [ ] **Step 1: Create the repository-owned linked worktree**

From `/Users/admin/Projects/ariadne`, run:

```bash
mkdir -p ../worktrees
node scripts/worktree-local.mjs create ../worktrees/ariadne-wedged-verify-full codex/wedged-verify-full origin/main
```

Expected: worktree creation succeeds. Its automatic background prewarm is non-gating; do not wait
for it, poll it, or start a duplicate baseline verify.

- [ ] **Step 2: Write failing pnpm-policy tests**

Replace the remote-only argv expectation with two cases, one with and one without
`REMOTE_RUNNER_CHILD`. Both probes must be `PROBE_ARGUMENTS`, and both repair calls must be:

```ts
["--config.confirm-modules-purge=false", "install", "--frozen-lockfile"];
```

Set `PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` in the remote environment and assert it is
preserved in the spawned environment rather than duplicated as a CLI option.

- [ ] **Step 3: Run the pnpm-state tests and observe RED**

Run: `rtk pnpm exec vitest run scripts/pnpm-state.tests.mjs`

Expected: FAIL because current code injects both config flags only for `REMOTE_RUNNER_CHILD=1`.

- [ ] **Step 4: Implement one inherited store policy**

Set:

```js
const REPAIR_ARGUMENTS = ["--config.confirm-modules-purge=false", "install", "--frozen-lockfile"];
```

Remove `remoteConfigArguments`; use `PROBE_ARGUMENTS` for probes and `REPAIR_ARGUMENTS` for repair
in every environment. Preserve inherited `PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE` unchanged.

- [ ] **Step 5: Run the pnpm-state tests and observe GREEN**

Run: `rtk pnpm exec vitest run scripts/pnpm-state.tests.mjs`

Expected: all pnpm-state tests pass.

- [ ] **Step 6: Commit the pnpm fix**

```bash
rtk git add -- scripts/pnpm-state.mjs scripts/pnpm-state.tests.mjs
rtk git commit -m "fix: align pnpm repair with workload policy"
```

### Task 8: Declare Ariadne's generated bootstrap artifacts

**Files:**

- Modify: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/.remote-runner.yaml`
- Test: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/scripts/worktree-local.test.mjs`
- Modify: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/.claude/memory/project-architecture.md`

- [ ] **Step 1: Write a failing consumer-contract test**

In the existing remote-runner ownership test, assert the manifest includes:

```js
assert.match(manifest, /artifacts:\s*\n\s*- vendor\/dev-standards\/runner\/dist\/verify-runner\.mjs/u);
assert.match(manifest, /vendor\/dev-standards\/runner\/dist\/\.built-from/u);
```

Retain the existing assertions for `mode: remote`, `fallback: fail`, DataAI root, and retention
`3/60`.

- [ ] **Step 2: Run the contract test and observe RED**

Run: `rtk pnpm exec vitest run scripts/worktree-local.test.mjs`

Expected: FAIL because the manifest has no artifact declarations.

- [ ] **Step 3: Add the two exact artifacts**

Under `bootstrap`, between `setup` and `ensure`, add:

```yaml
artifacts:
  - vendor/dev-standards/runner/dist/verify-runner.mjs
  - vendor/dev-standards/runner/dist/.built-from
```

Update the architecture memory to state that declared generated artifacts are checked on every
preparation and missing artifacts trigger one setup/recheck cycle. Do not move setup logic into
Ariadne.

- [ ] **Step 4: Validate and run targeted tests**

Run:

```bash
/Users/admin/.local/bin/remote-runner validate verify-full
rtk pnpm exec vitest run scripts/worktree-local.test.mjs scripts/pnpm-state.tests.mjs
```

Expected: manifest validation succeeds and all targeted tests pass.

- [ ] **Step 5: Commit the consumer contract**

```bash
rtk git add -- .remote-runner.yaml scripts/worktree-local.test.mjs .claude/memory/project-architecture.md
rtk git commit -m "fix: declare remote bootstrap artifacts"
```

### Task 9: Prove live self-healing and remote-only execution

**Files:**

- Use existing source: `/Users/admin/Projects/worktrees/ariadne-16b`
- Use consumer branch: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full`
- Temporary manifest: `/private/tmp/ariadne-16b-artifact-regression.yaml`

- [ ] **Step 1: Confirm the regression precondition**

Require the existing `cfd4838410ab64dd753c6679` workspace bundle to be absent and its Mutagen
session to remain the exact connected `ariadne-16b` session. Do not terminate or recreate that
session.

- [ ] **Step 2: Create a fail-closed temporary manifest for the old workspace**

Using `apply_patch`, create `/private/tmp/ariadne-16b-artifact-regression.yaml` from the
`ariadne-16b` manifest with only these deliberate differences:

```yaml
mode: remote
fallback: fail
workspace:
  generatedRoot: ~/.cache/remote-runner/workspaces
bootstrap:
  artifacts:
    - vendor/dev-standards/runner/dist/verify-runner.mjs
    - vendor/dev-standards/runner/dist/.built-from
```

Keep the existing target, host key, fingerprint, workload child environment, secrets, and
benchmark contract byte-for-byte equivalent.

- [ ] **Step 3: Run an attached repair canary from the wedged identity**

From `/Users/admin/Projects/worktrees/ariadne-16b`, run:

```bash
/Users/admin/.local/bin/remote-runner run verify-full --manifest /private/tmp/ariadne-16b-artifact-regression.yaml -- hostname
```

Expected: setup recreates both declared files, command prints `pop-os`, exit is 0, and latest runner
logs show `mode=remote,status=0`. Confirm the remote bundle and stamp now exist. Remove the temporary
manifest with `apply_patch`; do not change the `ariadne-16b` branch.

- [ ] **Step 4: Run feature-branch canary and mandatory full verification**

From `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full`, run:

```bash
/Users/admin/.local/bin/remote-runner run verify-full -- hostname
./scripts/verify --full
```

Expected: canary prints `pop-os`; full verify exits 0; latest logs show `mode=remote,status=0`; the
report path is under `/mnt/DataAI`; no local fallback event appears.

### Task 10: Record Ariadne acceptance and publish the consumer PR

**Files:**

- Modify: `/Users/admin/Projects/worktrees/ariadne-wedged-verify-full/.claude/memory/status.md`
- Update external handoff after both PRs exist: `/Users/admin/.claude/handoff/remote-runner-2026-08-01-wedged-verify-full.md`

- [ ] **Step 1: Record durable project evidence**

Update Ariadne status memory with the provider commit/PR, installed app identity, targeted test
counts, old-workspace self-heal result, feature-branch full verify result, DataAI report path, and
the next action `merge runner PR before Ariadne PR`. Do not leave a pending post-merge documentation
step.

- [ ] **Step 2: Re-run the final branch gate after documentation changes**

Run: `./scripts/verify --full`

Expected: exit 0 on Pop!_OS with latest runner logs `mode=remote,status=0`.

- [ ] **Step 3: Commit, push, and open the ready Ariadne PR**

```bash
rtk git add -- .claude/memory/status.md
rtk git commit -m "docs: record remote bootstrap recovery"
rtk git push -u origin codex/wedged-verify-full
rtk gh pr create --base main --head codex/wedged-verify-full --title "Prevent wedged remote full verification" --body-file /private/tmp/ariadne-wedged-verify-full-pr.md
```

Expected: a non-draft PR URL. Open it in the browser, verify the returned URL, and poll CI with
bounded `rtk gh` status calls until all required checks pass or a concrete failure is diagnosed.

- [ ] **Step 4: Close the external handoff with evidence**

Append a `Resolution` section to the external handoff using `apply_patch`. Record both ready PR
URLs, immutable runner receipt, live self-heal result, remote full-verification result, merge order,
and any still-active legacy workspace. Do not rewrite the original incident evidence.

- [ ] **Step 5: Final reconciliation**

Require both worktrees clean, both PR heads equal local heads, runner and Ariadne CI green, the
installed receipt equal the runner provider build, Ariadne still `mode: remote` / `fallback: fail`,
DataAI retention still at three identities, and no new local verify event after the acceptance
timestamps.
