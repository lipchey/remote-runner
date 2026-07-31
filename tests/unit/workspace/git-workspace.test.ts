import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { worktreeIdentity } from "../../../src/runtime/identity.js";
import { sshArguments } from "../../../src/ssh/client.js";
import {
  assertConfinedWorkspace,
  reconcileWorkspace,
  type GitWorkspaceOptions,
} from "../../../src/workspace/git-workspace.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../../src/ssh/client.js";

const temporaryRoots: string[] = [];
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";
const BASE_OID = "abcdef0123456789abcdef0123456789abcdef01";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeProcesses {
  readonly requests: BoundedProcessRequest[] = [];
  failAt?: number;
  candidateCanonical?: string;
  localObjectFormat = "sha1";
  localOid = HEAD_OID;
  existingMirrorFormat?: string;
  swapAfterPrepare = false;
  worktreeRegistered = false;
  pushStdout = "";

  constructor(
    private readonly root = "/cache/workspaces",
    private readonly consumer = "ariadne",
    private readonly profile = "verify-full",
  ) {}

  async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
    this.requests.push(request);
    if (this.failAt === this.requests.length) return result(17, "", "injected failure");
    if (request.command !== "ssh") {
      if (request.args.includes("--show-object-format")) {
        return result(0, `${this.localObjectFormat}\n`);
      }
      if (request.args[0] === "rev-parse") {
        return result(0, `${request.args.includes("refs/remotes/origin/main^{commit}") ? BASE_OID : this.localOid}\n`);
      }
      if (request.args[0] === "push") return result(0, this.pushStdout);
      return result();
    }
    const remote = request.args.at(-1) ?? "";
    if (remote.includes("remote-runner-git-prepare")) {
      if (
        this.existingMirrorFormat !== undefined &&
        remote.endsWith(` ${this.localObjectFormat}`) &&
        this.existingMirrorFormat !== this.localObjectFormat
      ) {
        return result(73, "", "mirror object format mismatch");
      }
      const identity = worktreeIdentity(this.sourceRoot());
      return result(0, [
        `root=${this.root}`,
        `candidate=${this.candidateCanonical ?? `${this.root}/${this.consumer}/${this.profile}/${identity}`}`,
        `mirror=${this.root}/${this.consumer}/.mirror.git`,
        "",
      ].join("\n"));
    }
    if (remote.includes("remote-runner-git-reconcile")) {
      return this.swapAfterPrepare ? result(73, "", "candidate escaped after lock") : result();
    }
    if (remote === `realpath --canonicalize-missing -- ${this.root}`) return result(0, `${this.root}\n`);
    if (remote.includes("realpath --canonicalize-missing --") && remote.endsWith("/.mirror.git")) {
      return result(0, `${this.root}/ariadne/.mirror.git\n`);
    }
    if (remote.includes("realpath --canonicalize-missing --")) {
      return result(0, `${this.candidateCanonical ?? remote.split(" ").at(-1)}\n`);
    }
    if (remote.includes("worktree list --porcelain")) {
      const identity = worktreeIdentity(this.sourceRoot());
      return result(0, this.worktreeRegistered ? `worktree ${this.root}/ariadne/${identity}\nHEAD deadbeef\n` : "");
    }
    return result();
  }

  sourceRoot(): string {
    const push = this.requests.find((request) => request.command === "git");
    return push?.cwd ?? process.cwd();
  }
}

function result(exitCode = 0, stdout = "", stderr = ""): BoundedProcessResult {
  return { exitCode, stdout: bytes(stdout), stderr: bytes(stderr), outputTruncated: false };
}

async function fixture(
  root = "/cache/workspaces",
  consumer = "ariadne",
  profile = "verify-full",
): Promise<{ options: GitWorkspaceOptions; processes: FakeProcesses }> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "remote-runner-workspace-"));
  temporaryRoots.push(sourceRoot);
  return {
    options: {
      consumer,
      profile,
      sourceRoot,
      remoteTarget: "admin@pop-os",
      generatedRoot: root,
      knownHostsPath: "/runner/known_hosts",
      connectTimeoutSeconds: 4,
    },
    processes: new FakeProcesses(root, consumer, profile),
  };
}

function remoteCommand(request: BoundedProcessRequest): string {
  return request.args.at(-1) ?? "";
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o700);
}

function runShell(command: string, environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env: environment, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

async function waitForLog(path: string, fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.includes(fragment)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${fragment}`);
}

describe("confined Git workspace reconciliation", () => {
  it("creates the mirror, pushes HEAD, creates the worktree, resets it, then updates submodules", async () => {
    const { options, processes } = await fixture();
    const identity = worktreeIdentity(options.sourceRoot);
    const privateRef = `refs/remote-runner/ariadne/verify-full/${identity}`;
    const candidate = `/cache/workspaces/ariadne/verify-full/${identity}`;

    await expect(reconcileWorkspace(options, processes)).resolves.toEqual({
      identity,
      remoteRoot: candidate,
      privateRef,
    });

    expect(processes.requests.map((request) => request.command)).toEqual(["git", "git", "ssh", "git", "ssh"]);
    expect(remoteCommand(processes.requests[2]!)).toContain("remote-runner-git-prepare");
    expect(remoteCommand(processes.requests[2]!)).toContain("git init --bare");
    expect(processes.requests[3]).toMatchObject({
      command: "git",
      cwd: options.sourceRoot,
      maxOutputBytes: 4 * 1024 * 1024,
      args: [
        "push",
        "--quiet",
        "--force",
        expect.stringContaining("--receive-pack=sh -ceu"),
        "--",
        "admin@pop-os:/cache/workspaces/ariadne/.mirror.git",
        `${HEAD_OID}:${privateRef}`,
      ],
    });
    expect(remoteCommand(processes.requests[4]!)).toContain("remote-runner-git-reconcile");
    expect(remoteCommand(processes.requests[4]!)).toContain(HEAD_OID);
    expect(processes.requests[3]?.environment?.GIT_SSH_COMMAND).toBe(
      ["ssh", ...sshArguments("admin@pop-os", ["true"], 4, "/runner/known_hosts").slice(0, -2)].join(" "),
    );
    expect(processes.requests[3]?.environment).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    });
  });

  it("accepts bounded push protocol output above the ordinary 64 KiB command limit", async () => {
    const { options, processes } = await fixture();
    processes.pushStdout = "p".repeat(64 * 1024 + 1);

    await expect(reconcileWorkspace(options, processes)).resolves.toMatchObject({
      privateRef: expect.stringContaining("refs/remote-runner/"),
    });
  });

  it("reuses a registered worktree without adding it again", async () => {
    const { options, processes } = await fixture();
    processes.worktreeRegistered = true;

    await reconcileWorkspace(options, processes);

    expect(processes.requests.filter((request) => request.command === "ssh").map(remoteCommand)).toHaveLength(2);
    expect(processes.requests.map(remoteCommand).filter((command) => command.includes("remote-runner-git-reconcile"))).toHaveLength(1);
  });

  it("rejects root, sibling, prefix-trick, and relative candidates", () => {
    expect(() => assertConfinedWorkspace("/cache/workspaces", "/cache/workspaces")).toThrow("strict descendant");
    expect(() => assertConfinedWorkspace("/cache/workspaces", "/cache/sibling")).toThrow("strict descendant");
    expect(() => assertConfinedWorkspace("/cache/workspaces", "/cache/workspaces-evil/item")).toThrow("strict descendant");
    expect(() => assertConfinedWorkspace("/cache/workspaces", "cache/workspaces/item")).toThrow("absolute");
  });

  it("rejects a remotely canonicalized symlink escape before any mutation", async () => {
    const { options, processes } = await fixture();
    processes.candidateCanonical = "/outside/stolen";

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow("strict descendant");
    expect(processes.requests).toHaveLength(3);
    expect(processes.requests.map((request) => request.command)).toEqual(["git", "git", "ssh"]);
  });

  it("derives identity only from the canonical source root and never accepts a branch name", async () => {
    const { options, processes } = await fixture();
    const alias = join(tmpdir(), `remote-runner-alias-${Date.now()}`);
    temporaryRoots.push(alias);
    await symlink(options.sourceRoot, alias);
    const branch = "feature/../../github-main";

    const outcome = await reconcileWorkspace({ ...options, sourceRoot: alias }, processes);

    expect(outcome.identity).toBe(worktreeIdentity(await realpath(options.sourceRoot)));
    expect(JSON.stringify(processes.requests)).not.toContain(branch);
    expect(JSON.stringify(processes.requests)).not.toContain("refs/heads");
    expect(JSON.stringify(processes.requests)).not.toContain("github");
  });

  it.each([
    ["consumer", { consumer: "../ariadne" }],
    ["profile", { profile: "Verify Full" }],
    ["generated root", { generatedRoot: "../cache" }],
    ["SSH target", { remoteTarget: "bad\0target" }],
    ["known_hosts", { knownHostsPath: "bad\0path" }],
    ["timeout", { connectTimeoutSeconds: 0 }],
  ] as const)("rejects invalid %s command input before launching a process", async (_label, patch) => {
    const { options, processes } = await fixture();
    await expect(reconcileWorkspace({ ...options, ...patch }, processes)).rejects.toThrow();
    expect(processes.requests).toEqual([]);
  });

  it("short-circuits every later step after the first command failure", async () => {
    const { options, processes } = await fixture();
    processes.failAt = 3;

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow("prepare workspace failed");
    expect(processes.requests).toHaveLength(3);
    expect(processes.requests.filter((request) => request.command === "git")).toHaveLength(2);
  });

  it("never resets the mirror, source root, generated root, or an unrelated worktree", async () => {
    const { options, processes } = await fixture();
    processes.worktreeRegistered = true;
    const { remoteRoot } = await reconcileWorkspace(options, processes);
    const resets = processes.requests.map(remoteCommand).filter((command) => command.includes("reset --hard"));

    expect(resets).toHaveLength(1);
    expect(resets[0]).toContain("candidate=$(confined_candidate)");
    expect(remoteRoot).toContain(`/ariadne/verify-full/`);
    expect(resets[0]).not.toContain("--git-dir=\"$mirror\" reset");
    expect(resets[0]).not.toContain("git -C \"$root\" reset");
    expect(resets[0]).not.toContain(options.sourceRoot);
  });

  it("pushes and resets the immutable local HEAD OID in a profile-isolated ref", async () => {
    const { options, processes } = await fixture();

    const outcome = await reconcileWorkspace(options, processes);
    const localGit = processes.requests.filter((request) => request.command === "git");
    const remote = processes.requests.filter((request) => request.command === "ssh").map(remoteCommand);

    expect(localGit[1]).toMatchObject({
      args: ["rev-parse", "--verify", "HEAD^{commit}", "--"],
      cwd: options.sourceRoot,
    });
    expect(outcome.privateRef).toBe(`refs/remote-runner/ariadne/verify-full/${outcome.identity}`);
    expect(localGit[2]?.args.at(-1)).toBe(`${HEAD_OID}:${outcome.privateRef}`);
    expect(remote.find((command) => command.includes("reset --hard"))).toContain(HEAD_OID);
    expect(remote.find((command) => command.includes("reset --hard"))).not.toContain(outcome.privateRef);
  });

  it("propagates a declared remote-tracking base ref for history-sensitive gates", async () => {
    const { options, processes } = await fixture();

    await reconcileWorkspace({ ...options, baseRef: "origin/main" }, processes);
    const push = processes.requests.find((request) => request.command === "git" && request.args[0] === "push");

    expect(push?.args).toContain(`${BASE_OID}:refs/remotes/origin/main`);
  });

  it("runs reuse cleanup and recursive submodule cleanup inside one locked transaction", async () => {
    const { options, processes } = await fixture();
    processes.worktreeRegistered = true;

    await reconcileWorkspace(options, processes);
    const remote = processes.requests.filter((request) => request.command === "ssh").map(remoteCommand);
    const transaction = remote.find((command) => command.includes("remote-runner-git-reconcile"));

    expect(transaction).toContain("flock -x");
    expect(transaction).toContain('mkdir -p -- "$candidate_parent"');
    expect(transaction!.indexOf("mkdir -p --")).toBeLessThan(transaction!.indexOf("worktree add"));
    const ordered = [
      "reset --hard",
      "clean -ffd --",
      "submodule sync --recursive",
      "submodule update --init --recursive --force",
      "submodule foreach --recursive",
    ];
    let cursor = -1;
    for (const fragment of ordered) {
      const next = transaction?.indexOf(fragment) ?? -1;
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(transaction).not.toContain("clean -ffdx");
  });

  it("captures worktree listing before testing registration so list failure cannot be masked", async () => {
    const { options, processes } = await fixture();

    await reconcileWorkspace(options, processes);
    const transaction = processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand)
      .find((command) => command.includes("remote-runner-git-reconcile"))!;

    expect(transaction).toContain("worktree_listing=$(git --git-dir=. worktree list --porcelain)");
    expect(transaction).toContain('"$worktree_listing" | grep -Fqx -- "worktree $candidate"; then');
    expect(transaction).not.toContain('if ! git --git-dir="$mirror" worktree list --porcelain |');
  });

  it("revalidates confinement after locking and immediately before each destructive use", async () => {
    const { options, processes } = await fixture();

    await reconcileWorkspace(options, processes);
    const transaction = processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand)
      .find((command) => command.includes("remote-runner-git-reconcile"));

    expect(transaction).toContain("root must not be a symlink");
    expect(transaction).toContain("root must be owned by the runner user");
    expect(transaction).toContain("root mode must be 0700");
    expect(transaction?.match(/candidate=\$\(confined_candidate\)/gu)).toHaveLength(3);
    expect(transaction).toContain(".locks/ariadne.lock");
  });

  it("preserves canonical path whitespace while removing only record terminators", async () => {
    const { options, processes } = await fixture("/cache/workspaces ");
    const identity = worktreeIdentity(options.sourceRoot);

    const outcome = await reconcileWorkspace(options, processes);

    expect(outcome.remoteRoot).toBe(`/cache/workspaces /ariadne/verify-full/${identity}`);
  });

  it("rejects a canonical candidate redirected to an unrelated descendant", async () => {
    const { options, processes } = await fixture();
    processes.candidateCanonical = "/cache/workspaces/ariadne/unrelated/worktree";

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow("unexpected canonical workspace");
    expect(processes.requests.map((request) => request.command)).toEqual(["git", "git", "ssh"]);
  });

  it("uses one lock key for concurrent calls of the same profile and identity", async () => {
    const { options, processes } = await fixture();
    const identity = worktreeIdentity(options.sourceRoot);

    await Promise.all([
      reconcileWorkspace(options, processes),
      reconcileWorkspace(options, processes),
    ]);
    const transactions = processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand)
      .filter((command) => command.includes("remote-runner-git-reconcile"));

    expect(transactions).toHaveLength(2);
    for (const transaction of transactions) {
      expect(transaction).toContain(".locks/ariadne.lock");
      expect(transaction).toContain("flock -x");
    }
  });

  it("fails closed when the candidate swaps outside after prepare", async () => {
    const { options, processes } = await fixture();
    processes.swapAfterPrepare = true;

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow("reconcile workspace failed");
    expect(processes.requests.map((request) => request.command)).toEqual(["git", "git", "ssh", "git", "ssh"]);
  });

  it("uses one consumer lock across prepare, receive-pack, and reconcile", async () => {
    const { options, processes } = await fixture();

    await reconcileWorkspace(options, processes);
    const remote = processes.requests.filter((request) => request.command === "ssh").map(remoteCommand);
    const push = processes.requests.filter((request) => request.command === "git")[2]!;
    const receivePack = push.args.find((argument) => argument.startsWith("--receive-pack="));

    expect(remote).toHaveLength(2);
    expect(remote.every((command) => command.includes(".locks/ariadne.lock"))).toBe(true);
    expect(receivePack).toContain("remote-runner-git-receive");
    expect(receivePack).toContain(".locks/ariadne.lock");
    expect(receivePack).toContain("flock -x 9");
    expect(receivePack).not.toContain(options.profile);
  });

  it("shares locks across profiles of one consumer and separates consumers", async () => {
    const first = await fixture("/cache/workspaces", "ariadne", "verify-full");
    const second = await fixture("/cache/workspaces", "ariadne", "quick");
    const other = await fixture("/cache/workspaces", "zephyr", "verify-full");

    await Promise.all([
      reconcileWorkspace(first.options, first.processes),
      reconcileWorkspace(second.options, second.processes),
      reconcileWorkspace(other.options, other.processes),
    ]);
    const lockArgument = (processes: FakeProcesses): string => processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand)
      .find((command) => command.includes("remote-runner-git-reconcile"))!;

    expect(lockArgument(first.processes)).toContain(".locks/ariadne.lock");
    expect(lockArgument(second.processes)).toContain(".locks/ariadne.lock");
    expect(lockArgument(other.processes)).toContain(".locks/zephyr.lock");
  });

  it("pins verified mirror and workspace inodes before Git mutations", async () => {
    const { options, processes } = await fixture();

    await reconcileWorkspace(options, processes);
    const [prepare, reconcile] = processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand);

    expect(prepare).toContain('cd -- "$mirror"');
    expect(prepare).toContain('[ "$(pwd -P)" = "$mirror" ]');
    expect(prepare).toContain('git init --bare --object-format="$object_format" -- .');
    expect(reconcile).toContain('cd -- "$candidate"');
    expect(reconcile).toContain('[ "$(pwd -P)" = "$candidate" ]');
    expect(reconcile).toContain('git reset --hard "$oid" --');
    expect(reconcile).not.toContain('git -C "$candidate" reset');
    expect(reconcile).toContain("Threat boundary: same-UID processes that ignore the consumer lock are not defended");
  });

  it.each(["sha1", "sha256"] as const)("initializes and reuses a matching %s mirror", async (format) => {
    const { options, processes } = await fixture();
    processes.localObjectFormat = format;
    processes.localOid = format === "sha1" ? HEAD_OID : "a".repeat(64);
    processes.existingMirrorFormat = format;

    await reconcileWorkspace(options, processes);
    const localGit = processes.requests.filter((request) => request.command === "git");
    const prepare = processes.requests.filter((request) => request.command === "ssh").map(remoteCommand)[0]!;

    expect(localGit[0]?.args).toEqual(["rev-parse", "--show-object-format"]);
    expect(localGit[1]?.args).toEqual(["rev-parse", "--verify", "HEAD^{commit}", "--"]);
    expect(prepare).toContain("git init --bare --object-format=\"$object_format\" -- .");
    expect(prepare).toContain("rev-parse --show-object-format");
    expect(prepare).toContain(` ${format}`);
  });

  it.each([
    ["md5", HEAD_OID],
    ["sha256", HEAD_OID],
    ["sha1", "a".repeat(64)],
  ])("rejects invalid or mismatched local format %s/OID before remote mutation", async (format, oid) => {
    const { options, processes } = await fixture();
    processes.localObjectFormat = format;
    processes.localOid = oid;

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow(/object format|object ID/);
    expect(processes.requests.every((request) => request.command === "git")).toBe(true);
  });

  it("stops before push and reconcile when an existing mirror format mismatches", async () => {
    const { options, processes } = await fixture();
    processes.localObjectFormat = "sha1";
    processes.existingMirrorFormat = "sha256";

    await expect(reconcileWorkspace(options, processes)).rejects.toThrow("prepare workspace failed");
    expect(processes.requests.map((request) => request.command)).toEqual(["git", "git", "ssh"]);
  });

  it("serializes competing profile shells and keeps destructive work on the opened inode", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "remote-runner-shell-")));
    temporaryRoots.push(root);
    const first = await fixture(root, "ariadne", "verify-full");
    const second = await fixture(root, "ariadne", "quick");
    const firstResult = await reconcileWorkspace(first.options, first.processes);
    const secondResult = await reconcileWorkspace(second.options, second.processes);
    const transaction = (processes: FakeProcesses): string => processes.requests
      .filter((request) => request.command === "ssh")
      .map(remoteCommand)
      .find((command) => command.includes("remote-runner-git-reconcile"))!;
    const mirror = join(root, "ariadne", ".mirror.git");
    const lockDirectory = join(root, ".locks");
    const tools = join(root, "test-bin");
    const log = join(root, "git.log");
    const hold = join(root, "hold");
    const moved = join(root, "moved-workspace");
    const trap = join(root, "trap-workspace");
    await Promise.all([
      mkdir(mirror, { recursive: true, mode: 0o700 }),
      mkdir(firstResult.remoteRoot, { recursive: true, mode: 0o700 }),
      mkdir(secondResult.remoteRoot, { recursive: true, mode: 0o700 }),
      mkdir(lockDirectory, { recursive: true, mode: 0o700 }),
      mkdir(tools, { mode: 0o700 }),
      mkdir(trap, { mode: 0o700 }),
      writeFile(hold, "hold"),
    ]);
    await writeExecutable(join(tools, "realpath"), `#!/usr/bin/python3
import os, sys
print(os.path.realpath(sys.argv[-1]))
`);
    await writeExecutable(join(tools, "stat"), `#!/usr/bin/python3
import os, stat, sys
value = os.stat(sys.argv[-1])
print(value.st_uid if "%u" in sys.argv else format(stat.S_IMODE(value.st_mode), "o"))
`);
    await writeExecutable(join(tools, "flock"), `#!/usr/bin/python3
import fcntl, sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)
`);
    await writeExecutable(join(tools, "git"), `#!/bin/sh
printf '%s|%s\n' "$(pwd -P)" "$*" >> "$RR_LOG"
case " $* " in
  *" rev-parse --is-bare-repository "*) printf 'true\n' ;;
  *" worktree list --porcelain "*) printf 'worktree %s\n' "$RR_CANDIDATE" ;;
  *" reset --hard "*)
    if [ -n "\${RR_RENAME_FROM:-}" ] && [ -d "$RR_RENAME_FROM" ] && [ ! -L "$RR_RENAME_FROM" ]; then
      mv "$RR_RENAME_FROM" "$RR_MOVED"
      ln -s "$RR_TRAP" "$RR_RENAME_FROM"
    fi
    while [ -e "$RR_HOLD" ]; do sleep 0.01; done
    ;;
esac
`);
    const baseEnvironment = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      RR_LOG: log,
      RR_HOLD: hold,
      RR_MOVED: moved,
      RR_TRAP: trap,
    };
    const firstRun = runShell(transaction(first.processes), {
      ...baseEnvironment,
      RR_CANDIDATE: firstResult.remoteRoot,
      RR_RENAME_FROM: firstResult.remoteRoot,
    });
    await waitForLog(log, "reset --hard");
    const secondRun = runShell(transaction(second.processes), {
      ...baseEnvironment,
      RR_CANDIDATE: secondResult.remoteRoot,
      RR_RENAME_FROM: "",
    });
    await delay(100);
    expect(await readFile(log, "utf8")).not.toContain(secondResult.remoteRoot);
    await rm(hold);
    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([0, 0]);
    const completedLog = await readFile(log, "utf8");
    expect(completedLog).toContain(moved);
    expect(completedLog).not.toContain(trap);
  });
});
