# Remote Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** implemented and live-accepted on 2026-07-31.
>
> **Final ownership amendment:** the package also owns manifest-workload dispatch,
> `REMOTE_RUNNER_MODE`, fail-soft `prewarm`, and allowlisted dotenv parsing. The Ariadne pilot's
> interim provider/adapter modules were removed; consumers retain only a manifest and minimal calls
> from existing entry points.
>
> **Design owner:** `docs/specs/2026-07-31-remote-runner-design.md`.

**Goal:** Build a self-healing macOS-to-Linux remote workload runner with Mutagen synchronization, native remote runtimes, pre-child local fallback, Telegram outage/recovery alerts, diagnostics, a runbook, and benchmark collection.

**Architecture:** A TypeScript CLI runs on the laptop and invokes fixed OpenSSH, Git, and Mutagen command boundaries; the Linux workstation needs no resident project daemon. Repository profiles are closed-schema YAML, each worktree gets a confined generated remote workspace, and every invocation reconstructs or repairs state before crossing an explicit child-start boundary.

**Tech Stack:** Node.js >=22.13, TypeScript 5.7, pnpm 11.9, Vitest 3.2, `yaml` 2.8, OpenSSH, Git, Mutagen, macOS LaunchAgents, POSIX shell on Linux.

---

## File structure

- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`: reproducible package, build, and test entrypoints.
- `src/cli.ts`: argument parsing and command dispatch only.
- `src/config/types.ts`, `src/config/load-manifest.ts`: profile model and closed-schema validation.
- `src/runtime/contracts.ts`: injected filesystem, process, clock, HTTP, and hashing ports.
- `src/runtime/paths.ts`, `src/runtime/lock.ts`, `src/runtime/state.ts`, `src/runtime/log.ts`: confined paths, serialization, atomic state, and redacted rotation.
- `src/ssh/client.ts`, `src/ssh/probe.ts`: argument-array SSH transport, strict trust, bounded availability probes.
- `src/workspace/git-workspace.ts`: private bare mirror, opaque worktree identity, private ref, and confined reset.
- `src/sync/mutagen.ts`: daemon/session create-resume-pause-flush lifecycle and ignore compilation.
- `src/bootstrap/fingerprint.ts`, `src/bootstrap/node.ts`, `src/bootstrap/dependencies.ts`: exact remote runtime and setup reconciliation.
- `src/secrets/provider.ts`, `src/secrets/frame.ts`, `assets/remote-launcher.mjs`: captured provider protocol, bounded secret frame, and fixed remote launcher.
- `src/run/prepare.ts`, `src/run/run-profile.ts`: ordered preparation and child-start fallback boundary.
- `src/notifications/telegram.ts`, `src/notifications/outage.ts`: safe Telegram transport and durable deduplication/recovery.
- `src/controller/controller.ts`, `src/install/macos.ts`, `assets/com.lipchey.remote-runner.plist`: background reconciliation and idempotent installation.
- `src/diagnostics/doctor.ts`, `src/diagnostics/repair.ts`, `src/benchmark/run-benchmark.ts`: diagnostics, confined repair, and measurements.
- `tests/unit/**`: deterministic tests mirroring `src/**`.
- `tests/live/**`: opt-in trusted-workstation acceptance and secret-canary checks.
- `docs/RUNBOOK.md`: symptom-first diagnosis, dry-run-first repairs, install/upgrade/uninstall.

### Task 1: Bootstrap the typed CLI and injected runtime

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli.ts`
- Create: `src/runtime/contracts.ts`
- Test: `tests/unit/cli.test.ts`

- [ ] **Step 1: Write the failing help test**

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

describe("runCli", () => {
  it("prints stable top-level commands without touching the system", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("run <profile> -- <command...>");
    expect(stdout.join("\n")).toContain("doctor [profile]");
    expect(stdout.join("\n")).toContain("repair <profile> --dry-run");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `pnpm vitest run tests/unit/cli.test.ts`
Expected: FAIL because `src/cli.ts` does not exist.

- [ ] **Step 3: Add the reproducible package and minimal CLI**

```json
{
  "name": "remote-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "remote-runner": "./dist/cli.js" },
  "engines": { "node": ">=22.13.0" },
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "verify": "pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": { "yaml": "2.8.1" },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^5.7.2",
    "vitest": "^3.2.7"
  }
}
```

```ts
export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}
const HELP = [
  "remote-runner run <profile> -- <command...>",
  "remote-runner validate [profile] [--manifest <path>]",
  "remote-runner status [profile]",
  "remote-runner doctor [profile]",
  "remote-runner logs [profile]",
  "remote-runner repair <profile> --dry-run|--apply",
  "remote-runner benchmark <profile>",
].join("\n");
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help") {
    io.stdout(HELP);
    return 0;
  }
  io.stderr(`unknown command: ${argv[0]}`);
  return 2;
}
```

- [ ] **Step 4: Install, lock, and verify the slice**

Run: `pnpm install --frozen-lockfile=false && pnpm vitest run tests/unit/cli.test.ts && pnpm typecheck`
Expected: one passing test and zero type errors; `pnpm-lock.yaml` is created.

- [ ] **Step 5: Commit**

```bash
rtk git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/cli.ts src/runtime/contracts.ts tests/unit/cli.test.ts
rtk git commit -m "feat: bootstrap remote-runner CLI"
```

### Task 2: Parse a closed-schema profile and confine paths

**Files:**
- Create: `src/config/types.ts`
- Create: `src/config/load-manifest.ts`
- Create: `src/runtime/paths.ts`
- Test: `tests/unit/config/load-manifest.test.ts`
- Test: `tests/unit/runtime/paths.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
import { describe, expect, it } from "vitest";
import { loadManifestText } from "../../../src/config/load-manifest.js";

const valid = `
schemaVersion: 1
profiles:
  - id: verify-full
    consumer: ariadne
    mode: auto
    fallback: local
    remote: { label: pop-os, target: admin@pop-os, hostKeySha256: "SHA256:trusted" }
    workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" }
    probes: { attempts: 2, connectTimeoutSeconds: 4, minimumFreeBytes: 10737418240 }
    sync: { provider: mutagen, mode: one-way-replica, ignores: [node_modules, .git] }
    bootstrap: { node: local-exact, packageManager: package.json, setup: ["./scripts/ds-bootstrap.sh"], fingerprint: [package.json, pnpm-lock.yaml] }
    workload: { command: ["./scripts/verify", "--full"], childEnvironment: { REMOTE_RUNNER_CHILD: "1" } }
    secrets: { allow: [NEON_DEV_DATABASE_URL], provider: ["node", "scripts/remote-runner-env.mjs"] }
    notifications: { policy: outage-recovery }
    benchmark: { samples: 3, workloads: [{ id: full, command: ["./scripts/verify", "--full"] }] }
`;

describe("loadManifestText", () => {
  it("accepts v1", () => expect(loadManifestText(valid).profiles[0]?.id).toBe("verify-full"));
  it("rejects unknown keys", () =>
    expect(() => loadManifestText(valid.replace("mode: auto", "mode: auto\n    typo: true"))).toThrow("unknown profile field: typo"));
  it("rejects shell strings", () =>
    expect(() => loadManifestText(valid.replace('["./scripts/verify", "--full"]', '"./scripts/verify --full"'))).toThrow("argument array"));
  it("rejects destructive roots", () =>
    expect(() => loadManifestText(valid.replace("~/.cache/remote-runner/workspaces", "/tmp"))).toThrow("generated root"));
});
```

- [ ] **Step 2: Run the tests and confirm the missing loader failure**

Run: `pnpm vitest run tests/unit/config/load-manifest.test.ts tests/unit/runtime/paths.test.ts`
Expected: FAIL because the loader and path validator do not exist.

- [ ] **Step 3: Implement explicit types and validators**

```ts
export type RunMode = "auto" | "local" | "remote";
export interface Profile {
  id: string;
  consumer: string;
  mode: RunMode;
  fallback: "local" | "fail";
  remote: { label: string; target: string; hostKeySha256: string };
  workspace: { generatedRoot: "~/.cache/remote-runner/workspaces" };
  probes: { attempts: 2; connectTimeoutSeconds: number; minimumFreeBytes: number };
  sync: { provider: "mutagen"; mode: "one-way-replica"; ignores: string[] };
  bootstrap: { node: "local-exact"; packageManager: string; setup: string[]; fingerprint: string[] };
  workload: { command: string[]; childEnvironment: Record<string, string> };
  secrets: { allow: string[]; provider: string[] };
  notifications: { policy: "outage-recovery" };
  benchmark: { samples: number; workloads: Array<{ id: string; command: string[] }> };
}
export interface ManifestV1 { schemaVersion: 1; profiles: Profile[] }
```

```ts
import { isAbsolute, normalize } from "node:path";
export function assertSafeRepositoryPath(value: string): string {
  const normalized = normalize(value);
  if (isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || value.includes("\0")) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  return normalized;
}
```

In `loadManifestText`, call `parseDocument(text, { uniqueKeys: true })`; enforce exact key sets at each object level, unique IDs matching `^[a-z][a-z0-9-]*$`, argument arrays, uppercase environment names, the literal generated root, two probe attempts, positive bounded timeouts/capacity/samples, and safe relative repository paths. Wire `remote-runner validate` to this loader only: it must not probe, synchronize, bootstrap, notify, or mutate state.

- [ ] **Step 4: Run schema and path tests**

Run: `pnpm vitest run tests/unit/config tests/unit/runtime/paths.test.ts`
Expected: all valid, unknown-key, duplicate, unsafe-path, and unsafe-command cases pass.

- [ ] **Step 5: Commit**

```bash
rtk git add src/config src/runtime/paths.ts tests/unit/config tests/unit/runtime/paths.test.ts
rtk git commit -m "feat: validate remote-runner profiles"
```

### Task 3: Add opaque identity, locks, state, and redacted logs

**Files:**
- Create: `src/runtime/identity.ts`
- Create: `src/runtime/lock.ts`
- Create: `src/runtime/state.ts`
- Create: `src/runtime/log.ts`
- Test: `tests/unit/runtime/identity.test.ts`
- Test: `tests/unit/runtime/lock.test.ts`
- Test: `tests/unit/runtime/state.test.ts`
- Test: `tests/unit/runtime/log.test.ts`

- [ ] **Step 1: Write failing identity and stale-lock tests**

```ts
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { worktreeIdentity } from "../../../src/runtime/identity.js";

it("never embeds a branch or path in an identity", () => {
  const root = "/Users/admin/Projects/worktrees/ariadne-feature";
  expect(worktreeIdentity(root)).toBe(createHash("sha256").update(root).digest("hex").slice(0, 24));
  expect(worktreeIdentity(root)).not.toContain("feature");
});
```

```ts
it("recovers only an expired lock whose owner is absent", async () => {
  const runtime = fakeLockRuntime({ ownerAlive: false, nowMs: 20_000, leaseUntilMs: 10_000 });
  const release = await acquireProfileLock(runtime, "ariadne/identity", 500);
  expect(runtime.renameDiagnostic).toHaveBeenCalledOnce();
  await release();
});
```

- [ ] **Step 2: Run and verify missing-module failures**

Run: `pnpm vitest run tests/unit/runtime/{identity,lock,state,log}.test.ts`
Expected: FAIL because the runtime modules do not exist.

- [ ] **Step 3: Implement confined runtime primitives**

```ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
export const worktreeIdentity = (root: string): string =>
  createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
```

Use atomic `mkdir` for acquisition and an `owner.json` payload with `pid`, `acquiredAt`, and `leaseUntil`. Wait only for the caller’s budget; rename stale or corrupt locks before reacquiring. Write versioned state via a `0600` same-directory temporary file, `fsync`, and rename. Redact registered secret values and URL credentials before JSONL output; rotate at 5 MiB and retain three files.

- [ ] **Step 4: Prove contention, corruption, permissions, and redaction**

Run: `pnpm vitest run tests/unit/runtime`
Expected: tests cover live-owner timeout, stale recovery, atomic replacement, corrupt-state retention, `0600`, rotation, and absence of the exact secret canary.

- [ ] **Step 5: Commit**

```bash
rtk git add src/runtime tests/unit/runtime
rtk git commit -m "feat: persist confined runner state"
```

### Task 4: Implement strict SSH transport and stable availability reasons

**Files:**
- Create: `src/ssh/client.ts`
- Create: `src/ssh/probe.ts`
- Test: `tests/unit/ssh/client.test.ts`
- Test: `tests/unit/ssh/probe.test.ts`

- [ ] **Step 1: Write failing argument and two-probe tests**

```ts
it("forces batch mode, strict host keys, and a bounded timeout", () => {
  expect(sshArguments("admin@pop-os", ["true"], 4)).toEqual([
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=4",
    "--", "admin@pop-os", "true",
  ]);
});

it("does not declare an outage after one transient failure", async () => {
  const once = vi.fn().mockResolvedValueOnce({ ok: false, reason: "transport" }).mockResolvedValueOnce({ ok: true });
  expect(await probeTwice(once)).toEqual({ ok: true });
  expect(once).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/ssh`
Expected: FAIL because the SSH modules do not exist.

- [ ] **Step 3: Implement argument-array transport and reason classification**

```ts
export type UnavailableReason =
  | "dns"
  | "host-key"
  | "authentication"
  | "transport"
  | "remote-shell"
  | "capacity"
  | "bootstrap";
export type ProbeResult = { ok: true } | { ok: false; reason: UnavailableReason };
```

Spawn `ssh` with an argument array, bounded capture, and no shell interpolation. Classify stderr only inside this boundary and expose only the stable reason. Before adding `pop-os` to the runner-owned known-hosts file, compare `ssh-keyscan` output with the separately trusted SHA-256 fingerprint.

- [ ] **Step 4: Verify hostile targets and failure classes**

Run: `pnpm vitest run tests/unit/ssh`
Expected: all cases pass, including targets beginning with `-`, fingerprint mismatch, auth failure, DNS, timeout, shell failure, and a recovered transient probe.

- [ ] **Step 5: Commit**

```bash
rtk git add src/ssh tests/unit/ssh
rtk git commit -m "feat: probe trusted remote hosts"
```

### Task 5: Reconcile confined Git workspaces

**Files:**
- Create: `src/workspace/git-workspace.ts`
- Test: `tests/unit/workspace/git-workspace.test.ts`

- [ ] **Step 1: Write failing order and confinement tests**

```ts
it("pushes HEAD to a private ref before reset and submodules", async () => {
  const process = fakeProcess();
  await reconcileWorkspace(profile, "abc123", process);
  expect(process.labels()).toEqual(["ensure-mirror", "push-head", "ensure-worktree", "reset-worktree", "submodules"]);
  expect(process.arguments()).toContain("refs/remote-runner/ariadne/abc123");
});

it("rejects a target equal to or outside the generated root", async () => {
  await expect(assertConfinedWorkspace("/cache/workspaces", "/cache/workspaces")).rejects.toThrow("strict descendant");
  await expect(assertConfinedWorkspace("/cache/workspaces", "/cache/sibling")).rejects.toThrow("strict descendant");
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/workspace/git-workspace.test.ts`
Expected: FAIL because workspace reconciliation is absent.

- [ ] **Step 3: Implement mirror, private ref, worktree, and submodule ordering**

```ts
export interface WorkspaceResult {
  identity: string;
  remoteRoot: string;
  privateRef: `refs/remote-runner/${string}/${string}`;
}
```

Create one bare mirror per consumer, push local `HEAD` to the identity ref over SSH without GitHub, canonicalize the candidate remotely, require a strict descendant of the configured generated root, create or reuse the generated worktree, reset only it to the private ref, and initialize recursive submodules.

- [ ] **Step 4: Verify Git semantics**

Run: `pnpm vitest run tests/unit/workspace/git-workspace.test.ts`
Expected: branch names never become paths, GitHub refs remain untouched, only the confined worktree is reset, and submodules follow reset.

- [ ] **Step 5: Commit**

```bash
rtk git add src/workspace tests/unit/workspace
rtk git commit -m "feat: reconcile remote git workspaces"
```

### Task 6: Reconcile and flush one-way Mutagen sessions

**Files:**
- Create: `src/sync/mutagen.ts`
- Test: `tests/unit/sync/mutagen.test.ts`

- [ ] **Step 1: Write failing lifecycle and ignore tests**

```ts
it("pauses before Git reset, resumes after reset, and flushes before setup", async () => {
  const process = fakeMutagenProcess({ existing: "watching" });
  const session = await pauseForGitReconcile(profile, workspace, process);
  await resumeAndFlush(session, process);
  expect(process.labels()).toEqual([
    "daemon-start", "session-list", "session-pause", "session-resume", "session-flush",
  ]);
});

it("always ignores generated and secret material", () => {
  expect(compileIgnores(profile.sync.ignores)).toEqual(expect.arrayContaining([
    ".git", "node_modules", ".pnpm-store", ".nx", "dist", "coverage",
    ".artifacts", ".env", ".age-key.age", ".tools/gitleaks",
  ]));
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/sync/mutagen.test.ts`
Expected: FAIL because the Mutagen provider is missing.

- [ ] **Step 3: Implement stable session naming and fail-closed flush**

```ts
export interface SyncResult {
  session: string;
  flushDurationMs: number;
  transferredBytes?: number;
}
export const sessionName = (consumer: string, identity: string): string =>
  `remote-runner-${consumer}-${identity}`;
```

`pauseForGitReconcile` starts the daemon idempotently, creates a missing session with alpha as the laptop and beta as the generated SSH worktree in `one-way-replica`, and pauses it before Git reset. `resumeAndFlush` resumes only after Git/submodule reconciliation, rejects conflict/disconnected states after one repair attempt, and requires a successful explicit flush before returning.

- [ ] **Step 4: Prove repair and fail-closed behavior**

Run: `pnpm vitest run tests/unit/sync/mutagen.test.ts`
Expected: tests pass for create, resume, flush, conflict, disconnect, unflushable session, duplicate identity, and mandatory built-in ignores.

- [ ] **Step 5: Commit**

```bash
rtk git add src/sync tests/unit/sync
rtk git commit -m "feat: synchronize remote workspaces"
```

### Task 7: Install exact remote Node/pnpm, uv, and gitleaks, then fingerprint setup

**Files:**
- Create: `src/bootstrap/fingerprint.ts`
- Create: `src/bootstrap/node.ts`
- Create: `src/bootstrap/uv.ts`
- Create: `src/bootstrap/gitleaks.ts`
- Create: `src/bootstrap/dependencies.ts`
- Test: `tests/unit/bootstrap/fingerprint.test.ts`
- Test: `tests/unit/bootstrap/node.test.ts`
- Test: `tests/unit/bootstrap/uv.test.ts`
- Test: `tests/unit/bootstrap/gitleaks.test.ts`
- Test: `tests/unit/bootstrap/dependencies.test.ts`

- [ ] **Step 1: Write failing checksum, fingerprint, and promotion tests**

```ts
it("binds environment identity and declared files in sorted order", async () => {
  expect(await dependencyFingerprint(runtime, profile, {
    node: "26.5.0-linux-x64",
    packageManager: "pnpm@11.9.0",
  })).toBe("sha256:fixture-environment-and-inputs");
});

it("never promotes an archive whose published checksum mismatches", async () => {
  await expect(installNode(runtime, { version: "26.5.0", arch: "x64" })).rejects.toThrow("checksum mismatch");
  expect(runtime.promote).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/bootstrap`
Expected: FAIL because bootstrap modules do not exist.

- [ ] **Step 3: Implement verified, user-scoped, atomic installation**

```ts
export interface EnvironmentIdentity {
  node: string;
  packageManager: string;
  uv?: string;
  gitleaks?: string;
}
export interface SetupResult {
  fingerprint: string;
  setupRan: boolean;
  environment: EnvironmentIdentity;
}
```

Read the laptop’s exact `process.versions.node` and remote `uname -m`; download the matching official Node archive and `SHASUMS256.txt`; require the manifest entry and digest match; extract below `~/.local/share/remote-runner/toolchains/.tmp`; atomically promote to a versioned directory; activate the exact `packageManager` declared by the consumer. Apply the same temporary-download, pinned-checksum, and atomic-promotion contract to declared uv and gitleaks versions. Hash the full effective environment plus every declared fingerprint file, including submodule gitlinks. Run setup only on a changed fingerprint and persist the new digest only after exit 0.

- [ ] **Step 4: Prove idempotency and failure preservation**

Run: `pnpm vitest run tests/unit/bootstrap`
Expected: tests pass for Node/uv/gitleaks architecture mapping, checksum mismatch, interrupted download, atomic promotion, unchanged fingerprint skip, changed lockfile rerun, changed submodule rerun, and failed setup retaining the last healthy environment and fingerprint.

- [ ] **Step 5: Commit**

```bash
rtk git add src/bootstrap tests/unit/bootstrap
rtk git commit -m "feat: bootstrap native remote dependencies"
```

### Task 8: Frame ephemeral secrets and launch the remote child

**Files:**
- Create: `src/secrets/provider.ts`
- Create: `src/secrets/frame.ts`
- Create: `assets/remote-launcher.mjs`
- Test: `tests/unit/secrets/provider.test.ts`
- Test: `tests/unit/secrets/frame.test.ts`
- Test: `tests/unit/secrets/remote-launcher.test.ts`

- [ ] **Step 1: Write failing protocol and leakage tests**

```ts
it("frames only allowlisted names and never exposes values in metadata", () => {
  const result = encodeSecretFrame(
    { NEON_DEV_DATABASE_URL: "postgres://secret-canary" },
    ["NEON_DEV_DATABASE_URL"],
  );
  expect(result.metadata).toEqual({ names: ["NEON_DEV_DATABASE_URL"], bytes: result.stdin.length });
  expect(JSON.stringify(result.metadata)).not.toContain("secret-canary");
});

it.each(["duplicate", "oversized", "unknown", "malformed"])("rejects %s input before child start", async (fixture) => {
  const result = await runLauncherFixture(fixture);
  expect(result.childStarted).toBe(false);
  expect(result.code).toBe(64);
});

it("captures provider JSON and rejects every non-allowlisted key", async () => {
  const values = await runSecretProvider(fakeProvider('{"NEON_DEV_DATABASE_URL":"canary"}'), ["NEON_DEV_DATABASE_URL"]);
  expect(values).toEqual({ NEON_DEV_DATABASE_URL: "canary" });
  await expect(runSecretProvider(fakeProvider('{"NEON_DATABASE_URL":"production"}'), ["NEON_DEV_DATABASE_URL"]))
    .rejects.toThrow("unallowlisted");
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/secrets`
Expected: FAIL because framing and the launcher are absent.

- [ ] **Step 3: Implement a bounded binary frame and fixed launcher**

```ts
const MAGIC = Buffer.from("RRSE1\0", "ascii");
export function encodeSecretFrame(values: Record<string, string>, allow: readonly string[]) {
  const entries = Object.entries(values);
  if (entries.length !== new Set(entries.map(([name]) => name)).size) throw new Error("duplicate secret");
  for (const [name, value] of entries) {
    if (!allow.includes(name)) throw new Error(`unallowlisted secret: ${name}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || Buffer.byteLength(value) > 64 * 1024) throw new Error("invalid secret frame");
  }
  const stdin = Buffer.concat([MAGIC, Buffer.from(JSON.stringify(entries), "utf8")]);
  return { stdin, metadata: { names: entries.map(([name]) => name), bytes: stdin.length } };
}
```

`runSecretProvider` captures at most 128 KiB from the declared provider command, parses one JSON object, requires its key set to be a subset of the manifest allowlist, and never forwards captured stdout to terminal/logs. The fixed Node launcher runs only after verified Node bootstrap; it reads bounded stdin, validates magic/version and allowlist, overwrites the frame buffer, closes input, writes `RR_CHILD_STARTED\n` to descriptor 3, then spawns the fixed command argument array with values added only to the child environment and mirrors its exit/signal.

- [ ] **Step 4: Run protocol and canary tests**

Run: `pnpm vitest run tests/unit/secrets`
Expected: valid frames reach the child; malformed frames do not; the canary is absent from argv, stderr, logs, diagnostics, and fixture filesystem.

- [ ] **Step 5: Commit**

```bash
rtk git add src/secrets assets/remote-launcher.mjs tests/unit/secrets
rtk git commit -m "feat: stream ephemeral remote secrets"
```

### Task 9: Orchestrate preparation, fallback, and authoritative child results

**Files:**
- Create: `src/run/prepare.ts`
- Create: `src/run/run-profile.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/run/prepare.test.ts`
- Test: `tests/unit/run/run-profile.test.ts`

- [ ] **Step 1: Write failing boundary and mode tests**

```ts
it("falls back locally only when auto preparation fails before child start", async () => {
  const runtime = fakeRunRuntime({ prepare: { ok: false, reason: "transport" }, remoteChildStarted: false, localExit: 17 });
  expect(await runProfile(runtime, profile, ["./verify", "--full"], "auto")).toBe(17);
  expect(runtime.localRuns).toBe(1);
});

it("propagates a remote child failure without local retry", async () => {
  const runtime = fakeRunRuntime({ prepare: { ok: true }, remoteChildStarted: true, remoteExit: 23 });
  expect(await runProfile(runtime, profile, ["./verify", "--full"], "auto")).toBe(23);
  expect(runtime.localRuns).toBe(0);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/run`
Expected: FAIL because the run state machine is missing.

- [ ] **Step 3: Implement the exact preparation order and boundary**

```ts
export const PREPARATION_STEPS = [
  "validate", "lock", "probe", "sync-pause", "git-workspace",
  "sync-resume-flush", "bootstrap", "secrets", "child-start",
] as const;
export type RunSelection =
  | { kind: "local"; reason: string }
  | { kind: "remote"; childStarted: boolean };
```

`local` bypasses remote state. `remote` fails closed on any preparation error. `auto` retries only bounded idempotent preparation and selects local before the child marker when fallback is `local`. Release the preparation lock immediately after the marker. Attach remote or local stdout/stderr to the terminal and return the selected child’s exit code or signal mapping unchanged.

- [ ] **Step 4: Verify the complete mode matrix**

Run: `pnpm vitest run tests/unit/run`
Expected: tests pass for auto/local/remote, lock contention, each preparation reason, local fallback result, remote success/failure/signal/timeout, and no post-marker retry.

- [ ] **Step 5: Commit**

```bash
rtk git add src/run src/cli.ts tests/unit/run
rtk git commit -m "feat: select remote or local execution"
```

### Task 10: Send deduplicated Telegram outage and recovery notifications

**Files:**
- Create: `src/notifications/telegram.ts`
- Create: `src/notifications/outage.ts`
- Test: `tests/unit/notifications/telegram.test.ts`
- Test: `tests/unit/notifications/outage.test.ts`

- [ ] **Step 1: Write failing permission, deduplication, and recovery tests**

```ts
it("rejects a Telegram config readable by group or others", async () => {
  await expect(loadTelegramConfig(runtime, "/config", 0o640)).rejects.toThrow("0600");
});

it("alerts once per outage and recovers on the first later remote child", async () => {
  const state = createOutageFixture();
  await recordFallback(state, "transport");
  await recordFallback(state, "transport");
  await recordRemoteChildStarted(state);
  expect(state.messages.map((message) => message.kind)).toEqual(["outage", "recovery"]);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/notifications`
Expected: FAIL because notifier modules are missing.

- [ ] **Step 3: Implement secure config loading and durable transitions**

```ts
export interface NotificationEvent {
  kind: "outage" | "recovery";
  consumer: string;
  profile: string;
  remoteLabel: string;
  reason: string;
  timestamp: string;
}
```

Load only `BOT_TOKEN` and numeric `CHAT_ID` from `~/.claude/.telegram-ask.conf`; require current-user ownership and no group/other permissions. POST `sendMessage` directly with a bounded timeout. Persist pending/sent outage state atomically. Do not block fallback on delivery failure; retain a retry marker. Send recovery at the first later remote child-start marker even if that child eventually fails.

- [ ] **Step 4: Verify redaction and retry behavior**

Run: `pnpm vitest run tests/unit/notifications`
Expected: tests pass for invalid ownership/mode, malformed config, first outage, repeated fallback, failed delivery retry, recovery after remote start, and token/secret absence from messages and logs.

- [ ] **Step 5: Commit**

```bash
rtk git add src/notifications tests/unit/notifications
rtk git commit -m "feat: notify remote outages and recovery"
```

### Task 11: Install and self-heal the macOS controller

**Files:**
- Create: `src/controller/controller.ts`
- Create: `src/install/macos.ts`
- Create: `src/install/mutagen.ts`
- Create: `assets/versions.json`
- Create: `assets/com.lipchey.remote-runner.plist`
- Modify: `src/cli.ts`
- Test: `tests/unit/controller/controller.test.ts`
- Test: `tests/unit/install/macos.test.ts`
- Test: `tests/unit/install/mutagen.test.ts`

- [ ] **Step 1: Write failing install and invocation-repair tests**

```ts
it("installs only owned files and bootstraps the LaunchAgent idempotently", async () => {
  const runtime = fakeMacRuntime();
  await installMac(runtime);
  await installMac(runtime);
  expect(runtime.ownedWrites()).toEqual([
    "~/.local/bin/remote-runner",
    "~/Library/LaunchAgents/com.lipchey.remote-runner.plist",
  ]);
  expect(runtime.launchctlBootstraps).toBe(1);
});

it("a run repairs a stopped controller before preparing the profile", async () => {
  const runtime = fakeControllerRuntime({ running: false });
  await ensureController(runtime);
  expect(runtime.actions).toEqual(["inspect", "bootstrap", "inspect"]);
});

it("installs the pinned Mutagen archive and rejects a checksum mismatch", async () => {
  const runtime = fakeMutagenInstallRuntime({ version: "0.18.1", checksumMatches: false });
  await expect(installMutagen(runtime)).rejects.toThrow("checksum mismatch");
  expect(runtime.promoted).toBe(false);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/controller tests/unit/install`
Expected: FAIL because controller/install modules do not exist.

- [ ] **Step 3: Implement idempotent install, upgrade, controller, and uninstall**

```ts
export const OWNED_MAC_PATHS = [
  "~/.local/bin/remote-runner",
  "~/Library/LaunchAgents/com.lipchey.remote-runner.plist",
  "~/.local/state/remote-runner",
  "~/.cache/remote-runner",
] as const;
```

`assets/versions.json` pins Mutagen `0.18.1`. Download the matching official macOS archive and checksum manifest, require its exact entry to match, then atomically install below `~/.local/share/remote-runner/bin`; never require Homebrew or sudo. Render a versioned plist with `RunAtLoad` and `KeepAlive` only for the controller; atomically replace owned executable/plist files; use the modern `launchctl bootstrap/bootout/kickstart` domain for the current UID; preserve compatible state across upgrade. The controller scans registered profiles, starts/reconnects Mutagen, records bounded health, and never starts workloads. Every `run` calls `ensureController`, so a dead controller cannot silently disable healing or alerts.

- [ ] **Step 4: Verify lifecycle and exact ownership**

Run: `pnpm vitest run tests/unit/controller tests/unit/install`
Expected: tests pass for clean Mutagen/CLI install, checksum mismatch, second install, upgrade, stopped controller, corrupt plist, login bootstrap, exact-path uninstall, and refusal to delete unowned/sibling paths.

- [ ] **Step 5: Commit**

```bash
rtk git add src/controller src/install src/cli.ts assets/versions.json assets/com.lipchey.remote-runner.plist tests/unit/controller tests/unit/install
rtk git commit -m "feat: self-heal remote-runner at login"
```

### Task 12: Add status, doctor, logs, confined repair, and the runbook

**Files:**
- Create: `src/diagnostics/doctor.ts`
- Create: `src/diagnostics/repair.ts`
- Modify: `src/cli.ts`
- Create: `docs/RUNBOOK.md`
- Test: `tests/unit/diagnostics/doctor.test.ts`
- Test: `tests/unit/diagnostics/repair.test.ts`

- [ ] **Step 1: Write failing stable-code and dry-run tests**

```ts
it("reports stable reason codes without raw SSH output", async () => {
  const report = await doctor(fakeDoctorRuntime({ sshStderr: "postgres://secret-canary", reason: "transport" }));
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "ssh.transport", status: "fail", reason: "transport" }));
  expect(JSON.stringify(report)).not.toContain("secret-canary");
});

it("dry-run describes one identity and performs no mutation", async () => {
  const runtime = fakeRepairRuntime();
  const plan = await repair(runtime, "verify-full", { apply: false });
  expect(plan.actions.every((action) => action.target.includes(runtime.identity))).toBe(true);
  expect(runtime.mutations).toBe(0);
});
```

- [ ] **Step 2: Run and verify failures**

Run: `pnpm vitest run tests/unit/diagnostics`
Expected: FAIL because diagnostics and repair are missing.

- [ ] **Step 3: Implement commands and symptom-first procedures**

```ts
export interface DiagnosticCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  reason?: string;
  next: string;
}
export interface RepairAction {
  id: string;
  target: string;
  destructive: boolean;
}
```

`status` reports concise controller/session/workspace/fingerprint/outage state; `doctor` checks every documented reason code read-only; `logs` tails bounded rotated logs; `repair --dry-run` is mandatory before `--apply` and records the exact confined target. Write `docs/RUNBOOK.md` with copy-paste-safe diagnosis for SSH/Tailscale, host key, Mutagen, workspace, disk, bootstrap, Telegram, reboot, controller crash, corrupt state, upgrade, uninstall, privacy-safe bundle, and harmless sync canary.

- [ ] **Step 4: Run diagnostic tests and validate runbook command coverage**

Run: `pnpm vitest run tests/unit/diagnostics tests/unit/runbook.test.ts`
Expected: every reason code has one read-only command and one confined repair where applicable; all mutating procedures have a dry-run predecessor.

- [ ] **Step 5: Commit**

```bash
rtk git add src/diagnostics src/cli.ts docs/RUNBOOK.md tests/unit/diagnostics tests/unit/runbook.test.ts
rtk git commit -m "feat: diagnose and repair remote-runner"
```

### Task 13: Benchmark laptop and workstation workloads

**Files:**
- Create: `src/benchmark/run-benchmark.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/benchmark/run-benchmark.test.ts`

- [ ] **Step 1: Write a failing matrix and statistic test**

```ts
it("runs warm-up plus three cold and three warm samples per location", async () => {
  const runtime = fakeBenchmarkRuntime();
  const report = await runBenchmark(runtime, profile);
  expect(runtime.samples("local", "full")).toEqual(["warmup", "cold", "cold", "cold", "warm", "warm", "warm"]);
  expect(report.rows[0]).toMatchObject({ medianMs: 2000, minMs: 1800, maxMs: 2300, status: 0 });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tests/unit/benchmark/run-benchmark.test.ts`
Expected: FAIL because benchmark collection is missing.

- [ ] **Step 3: Implement the declared matrix and sanitized report**

```ts
export interface BenchmarkSample {
  location: "local" | "remote";
  cache: "warmup" | "cold" | "warm";
  syncMs: number;
  setupMs: number;
  workloadMs: number;
  status: number;
  cpuLoad?: number;
  peakMemoryBytes?: number;
  transferredBytes?: number;
}
```

Execute only commands declared by the validated profile. Separate sync/setup/workload time; record wall time, status, cache ratio, load, memory, and transfer when available; compute median/range; write a timestamped JSON receipt and Markdown summary without environment values.

- [ ] **Step 4: Verify deterministic aggregation and failure reporting**

Run: `pnpm vitest run tests/unit/benchmark`
Expected: tests pass for sample counts, warm-up exclusion, median/range, failed workload preservation, missing optional metrics, and secret redaction.

- [ ] **Step 5: Commit**

```bash
rtk git add src/benchmark src/cli.ts tests/unit/benchmark
rtk git commit -m "feat: compare local and remote workloads"
```

### Task 14: Prove live acceptance, lifecycle recovery, and publish readiness

**Files:**
- Create: `tests/live/acceptance.test.ts`
- Create: `tests/live/secret-canary.test.ts`
- Create: `tests/live/runbook.test.ts`
- Create: `docs/acceptance/2026-07-31-ariadne-pilot.md`
- Modify: `README.md`
- Modify: `docs/specs/2026-07-31-remote-runner-design.md`

- [ ] **Step 1: Write a failing acceptance inventory test**

```ts
const REQUIRED_SCENARIOS = [
  "clean-install", "login-start", "empty-workstation-bootstrap", "dirty-source",
  "untracked-source", "generated-isolation", "fingerprint-idempotency",
  "remote-exit", "no-post-child-fallback", "outage-alert", "outage-dedup",
  "recovery-alert", "controller-self-heal", "workstation-reboot",
  "secret-canary", "runbook-repairs",
] as const;

it("records a passing receipt for every required live scenario", async () => {
  const receipt = await readAcceptanceReceipt();
  expect(Object.keys(receipt.scenarios).sort()).toEqual([...REQUIRED_SCENARIOS].sort());
  expect(Object.values(receipt.scenarios).every((scenario) => scenario.status === "pass")).toBe(true);
});
```

- [ ] **Step 2: Run deterministic verification before touching the live workstation**

Run: `pnpm verify`
Expected: typecheck, all unit tests, and build pass; the live receipt test remains excluded until a receipt path is supplied.

- [ ] **Step 3: Execute the trusted-workstation matrix**

Run: `REMOTE_RUNNER_LIVE=1 pnpm vitest run tests/live/acceptance.test.ts tests/live/secret-canary.test.ts`
Expected: clean install; no preinstalled Node/pnpm assumption; dirty and untracked source visible; generated state absent locally; setup once per fingerprint; remote exit exact; deliberate remote child failure has no local retry; unreachable fixture triggers one fallback alert; repetition sends none; recovery child sends one; killed controller is repaired by the next run.

For the reboot scenario, first record `remote-runner status verify-full`, obtain the owner’s explicit approval for the workstation reboot, run `ssh -t admin@pop-os 'sudo systemctl reboot'`, wait for strict SSH probes to recover, then run `remote-runner run verify-full -- ./scripts/verify --full`. Expected: `sshd` and `tailscaled` return automatically and the invocation recreates all runner state without a Linux resident daemon.

- [ ] **Step 4: Prove secrecy, runbook, and benchmark acceptance**

Run: `REMOTE_RUNNER_LIVE=1 pnpm vitest run tests/live/secret-canary.test.ts tests/live/runbook.test.ts`
Expected: canaries are absent from local/remote argv, repositories, persistent remote files, state, logs, diagnostics, and Telegram payload fixtures; each runbook diagnosis and dry-run/apply repair works only on its fixture identity.

Run: `remote-runner benchmark verify-full`
Expected: a sanitized receipt with warm-up plus at least three cold and three warm local/remote samples, separated sync/setup/workload time, median/range, and an explicit laptop CPU-pressure conclusion.

- [ ] **Step 5: Record evidence and rerun the complete gate**

Update `docs/acceptance/2026-07-31-ariadne-pilot.md` with command, timestamp, workstation label, version identities, receipt paths, scenario verdicts, benchmark table, and no secret values. Change the design status to `implemented` only after all completion criteria are evidenced.

Run: `pnpm verify && REMOTE_RUNNER_LIVE_RECEIPT=docs/acceptance/2026-07-31-ariadne-pilot.md pnpm vitest run tests/live`
Expected: all deterministic and receipt-validation tests pass.

- [ ] **Step 6: Commit and publish a ready-for-review branch**

`rtk git remote get-url origin` must resolve before push. If this private repository still has no origin, create it once with:

```bash
rtk gh repo create lipchey/remote-runner --private --source=. --remote=origin
```

```bash
rtk git add README.md docs src assets tests package.json pnpm-lock.yaml tsconfig.json vitest.config.ts
rtk git commit -m "feat: deliver remote-runner pilot"
rtk git push -u origin codex/remote-runner-implementation
rtk gh pr create --base main --head codex/remote-runner-implementation --title "feat: deliver remote-runner pilot" --body-file docs/acceptance/2026-07-31-ariadne-pilot.md
```

Expected: the pull request is ready for review, not draft, and its URL resolves before handoff.

## Self-review coverage

- Profile schema, modes, fallback, and validation: Tasks 1–2 and 9.
- Identity, locking, state reconstruction, redacted logs: Task 3.
- Strict SSH trust and two-probe availability: Task 4.
- Private Git refs, confined generated worktrees, dirty overlay substrate: Task 5.
- One-way Mutagen pause/reconcile/resume/flush and exclusions: Task 6.
- Native Node/pnpm/uv/gitleaks and dependency fingerprints: Task 7.
- Captured provider, framed secrets, fixed child-start marker: Task 8.
- Exact selected-process output/exit/signal semantics: Task 9.
- Telegram outage deduplication, retry, and recovery: Task 10.
- Login controller, invocation self-healing, install/upgrade/uninstall, Mutagen install: Task 11.
- Status/doctor/logs/repair and every runbook reason: Task 12.
- Cold/warm local-vs-remote benchmark: Task 13.
- Reboot/controller recovery, secret canaries, live acceptance, and ready PR evidence: Task 14.
