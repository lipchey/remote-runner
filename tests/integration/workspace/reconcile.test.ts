import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProcessRuntime } from "../../../src/node/process.js";
import { reconcileWorkspace, type GitWorkspaceOptions } from "../../../src/workspace/git-workspace.js";

const TEST_TIMEOUT_MS = 30_000;
const ENVIRONMENT_KEYS = [
  "PATH",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
] as const;
const temporaryRoots: string[] = [];
let savedEnvironment: Map<string, string | undefined> | undefined;

interface GitFixture {
  mirrorRoot: string;
  options: GitWorkspaceOptions;
  sourceRoot: string;
  subRoot: string;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

async function installShims(binRoot: string): Promise<void> {
  await mkdir(binRoot);
  await writeExecutable(
    path.join(binRoot, "ssh"),
    `#!/bin/sh
last=
for argument do
  last=$argument
done
exec sh -c "$last"
`,
  );

  if (process.platform === "linux") {
    return;
  }

  await writeExecutable(
    path.join(binRoot, "flock"),
    `#!/bin/sh
# This tier covers git/submodule semantics, not mutual exclusion; Linux uses real flock. It still
# rejects a transaction that closes or never opens the descriptor it claims to lock, because real
# flock would then guard nothing while every assertion below still passed.
if [ "$#" -ne 2 ] || [ "$1" != "-x" ] || [ "$2" != "9" ]; then
  echo "unsupported flock form: $*" >&2
  exit 2
fi
if ! { : >&9; } 2>/dev/null; then
  echo "flock: file descriptor 9 is not open for writing" >&2
  exit 2
fi
`,
  );
  await writeExecutable(
    path.join(binRoot, "chmod"),
    `#!/usr/bin/env node
const fs = require("node:fs");

const [mode, separator, target] = process.argv.slice(2);
if (
  mode !== "700" ||
  separator !== "--" ||
  target === undefined ||
  process.argv.length !== 5
) {
  console.error(\`unsupported chmod form: \${process.argv.slice(2).join(" ")}\`);
  process.exit(2);
}
fs.chmodSync(target, 0o700);
`,
  );
  await writeExecutable(
    path.join(binRoot, "stat"),
    `#!/usr/bin/env node
const fs = require("node:fs");

const [flag, format, separator, target] = process.argv.slice(2);
if (
  flag !== "-c" ||
  !["%u", "%a"].includes(format) ||
  separator !== "--" ||
  target === undefined ||
  process.argv.length !== 6
) {
  console.error(\`unsupported stat form: \${process.argv.slice(2).join(" ")}\`);
  process.exit(2);
}

const metadata = fs.statSync(target);
console.log(format === "%u" ? metadata.uid : (metadata.mode & 0o7777).toString(8));
`,
  );
  await writeExecutable(
    path.join(binRoot, "realpath"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

function canonicalizeMissing(target) {
  let existing = path.resolve(target);
  const remainder = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      break;
    }
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...remainder);
}

if (args.length === 2 && args[0] === "--") {
  console.log(fs.realpathSync(args[1]));
} else if (
  args.length === 3 &&
  args[0] === "--canonicalize-missing" &&
  args[1] === "--"
) {
  console.log(canonicalizeMissing(args[2]));
} else {
  console.error(\`unsupported realpath form: \${args.join(" ")}\`);
  process.exit(2);
}
`,
  );
}

function configureEnvironment(binRoot: string, subRoot: string): void {
  savedEnvironment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  process.env.PATH = `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`;

  /* Local-path submodules are disabled by default, and this inherited setting must reach fixture and remote commands. */
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
  /* A stable URL literal keeps commit IDs reproducible while insteadOf resolves the per-test path. */
  process.env.GIT_CONFIG_KEY_1 = `url.${subRoot}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_1 = "file:///remote-runner-fixture-sub";
  process.env.GIT_AUTHOR_NAME = "Remote Runner Integration";
  process.env.GIT_AUTHOR_EMAIL = "remote-runner@example.test";
  process.env.GIT_AUTHOR_DATE = "2000-01-01T00:00:00Z";
  process.env.GIT_COMMITTER_NAME = "Remote Runner Integration";
  process.env.GIT_COMMITTER_EMAIL = "remote-runner@example.test";
  process.env.GIT_COMMITTER_DATE = "2000-01-01T00:00:00Z";
}

function restoreEnvironment(): void {
  if (savedEnvironment === undefined) {
    return;
  }
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnvironment = undefined;
}

async function createFixture(): Promise<GitFixture> {
  /* The transaction scripts compare canonical roots, while macOS exposes /tmp through a symlink. */
  const root = await mkdtemp(path.join(realpathSync(tmpdir()), "remote-runner-git-integration-"));
  temporaryRoots.push(root);

  const binRoot = path.join(root, "bin");
  const subRoot = path.join(root, "sub");
  const sourceRoot = path.join(root, "source");
  const generatedRoot = path.join(root, "remote-root");
  const knownHostsPath = path.join(root, "known_hosts");

  await installShims(binRoot);
  configureEnvironment(binRoot, subRoot);
  await writeFile(knownHostsPath, "");

  git("-c", "init.defaultBranch=main", "init", subRoot);
  await writeFile(path.join(subRoot, "payload.txt"), "payload v1\n");
  git("-C", subRoot, "add", "payload.txt");
  git("-C", subRoot, "commit", "-m", "Add submodule payload");

  git("-c", "init.defaultBranch=main", "init", sourceRoot);
  await writeFile(path.join(sourceRoot, "source.txt"), "source payload\n");
  git("-C", sourceRoot, "add", "source.txt");
  git("-C", sourceRoot, "commit", "-m", "Add source payload");
  git("-C", sourceRoot, "submodule", "add", "file:///remote-runner-fixture-sub", "sub");
  git("-C", sourceRoot, "commit", "-m", "Add local submodule");

  await mkdir(generatedRoot, { mode: 0o700 });
  await chmod(generatedRoot, 0o700);
  /* Left uncreated on purpose: the transaction must be the one that creates the bare mirror. */
  const mirrorRoot = path.join(generatedRoot, "runner", ".mirror.git");

  return {
    mirrorRoot,
    sourceRoot,
    subRoot,
    options: {
      clientId: "integration-client",
      connectTimeoutSeconds: 10,
      consumer: "runner",
      generatedRoot,
      knownHostsPath,
      profile: "integration",
      remoteTarget: "localhost",
      sourceRoot,
    },
  };
}

async function addSecondSubmoduleCommit(fixture: GitFixture): Promise<string> {
  await writeFile(path.join(fixture.subRoot, "payload.txt"), "payload v2\n");
  git("-C", fixture.subRoot, "add", "payload.txt");
  git("-C", fixture.subRoot, "commit", "-m", "Update submodule payload");
  const submoduleHead = git("-C", fixture.subRoot, "rev-parse", "HEAD");

  const sourceSubmodule = path.join(fixture.sourceRoot, "sub");
  git("-C", sourceSubmodule, "fetch", "origin");
  git("-C", sourceSubmodule, "checkout", "--detach", submoduleHead);
  git("-C", fixture.sourceRoot, "add", "sub");
  git("-C", fixture.sourceRoot, "commit", "-m", "Move submodule pointer");

  return submoduleHead;
}

function workspaceStatus(workspaceRoot: string): string {
  return git("-C", workspaceRoot, "status", "--porcelain", "--ignore-submodules=none");
}

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAbsent = gitProbe.error !== undefined && (gitProbe.error as NodeJS.ErrnoException).code === "ENOENT";

describe.skipIf(gitAbsent)("real Git workspace reconciliation", () => {
  it(
    "materialises the submodule on the first reconcile",
    async () => {
      const fixture = await createFixture();
      const sourceHead = git("-C", fixture.sourceRoot, "rev-parse", "HEAD");

      const result = await reconcileWorkspace(fixture.options, new NodeProcessRuntime());

      expect((await stat(result.remoteRoot)).isDirectory()).toBe(true);
      expect(git("-C", result.remoteRoot, "rev-parse", "HEAD")).toBe(sourceHead);
      await expect(readFile(path.join(result.remoteRoot, "sub", "payload.txt"), "utf8")).resolves.toBe("payload v1\n");
      expect(workspaceStatus(result.remoteRoot)).toBe("");

      expect(git("-C", fixture.mirrorRoot, "rev-parse", "--is-bare-repository")).toBe("true");
      expect(git("--git-dir", fixture.mirrorRoot, "rev-parse", result.privateRef)).toBe(sourceHead);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "follows a moved submodule pointer on the next reconcile",
    async () => {
      const fixture = await createFixture();
      const first = await reconcileWorkspace(fixture.options, new NodeProcessRuntime());
      /* The initialized submodule's remote lives under the shared mirror, so staling it makes recursive sync observable. */
      git(
        "-C",
        path.join(first.remoteRoot, "sub"),
        "remote",
        "set-url",
        "origin",
        path.join(fixture.sourceRoot, "missing-submodule"),
      );
      const newSubmoduleHead = await addSecondSubmoduleCommit(fixture);

      const result = await reconcileWorkspace(fixture.options, new NodeProcessRuntime());

      expect(git("-C", path.join(result.remoteRoot, "sub"), "rev-parse", "HEAD")).toBe(newSubmoduleHead);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cleans local dirt inside the submodule",
    async () => {
      const fixture = await createFixture();
      const first = await reconcileWorkspace(fixture.options, new NodeProcessRuntime());
      const submoduleRoot = path.join(first.remoteRoot, "sub");
      const junkPath = path.join(submoduleRoot, "junk.txt");
      await writeFile(path.join(submoduleRoot, "payload.txt"), "local change\n");
      await writeFile(junkPath, "junk\n");

      const result = await reconcileWorkspace(fixture.options, new NodeProcessRuntime());

      await expect(readFile(path.join(result.remoteRoot, "sub", "payload.txt"), "utf8")).resolves.toBe("payload v1\n");
      expect(existsSync(junkPath)).toBe(false);
      expect(workspaceStatus(result.remoteRoot)).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});
