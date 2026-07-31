import { isAbsolute, posix } from "node:path";

import { worktreeIdentity } from "../runtime/identity.js";
import {
  encodePosixCommand,
  runSsh,
  sshArguments,
  type BoundedProcessResult,
  type SshProcessRuntime,
} from "../ssh/client.js";

const CAPTURE_BYTES = 64 * 1024;
const PUSH_CAPTURE_BYTES = 4 * 1024 * 1024;
const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const PREPARE_TRANSACTION = String.raw`set -eu
umask 077
root_input=$1
candidate_input=$2
mirror_input=$3
lock_input=$4
object_format=$5
fail() { printf '%s\n' "$1" >&2; exit 73; }
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
if [ ! -e "$root_input" ]; then
  mkdir -p -- "$root_input"
  chmod 700 -- "$root_input"
fi
[ -d "$root_input" ] || fail 'root must be a directory'
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
root=$(realpath -- "$root_input")
[ "$(stat -c %u -- "$root")" = "$(id -u)" ] || fail 'root must be owned by the runner user'
[ "$(stat -c %a -- "$root")" = 700 ] || fail 'root mode must be 0700'
confined() {
  resolved=$(realpath --canonicalize-missing -- "$1")
  case "$resolved" in "$root"/*) printf '%s\n' "$resolved";; *) fail 'path must be a strict descendant of root';; esac
}
lock_dir=$(confined "$root/.locks")
mkdir -p -- "$lock_dir"
chmod 700 -- "$lock_dir"
lock=$(confined "$lock_input")
exec 9>"$lock"
flock -x 9
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
[ "$(realpath -- "$root_input")" = "$root" ] || fail 'root changed after lock'
[ "$(stat -c %u -- "$root")" = "$(id -u)" ] || fail 'root must be owned by the runner user'
[ "$(stat -c %a -- "$root")" = 700 ] || fail 'root mode must be 0700'
candidate=$(confined "$candidate_input")
mirror=$(confined "$mirror_input")
mkdir -p -- "$(dirname -- "$mirror")"
mirror=$(confined "$mirror_input")
mirror_created=no
if [ ! -e "$mirror" ]; then mkdir -m 700 -- "$mirror"; mirror_created=yes; fi
[ -d "$mirror" ] || fail 'mirror must be a directory'
[ ! -L "$mirror" ] || fail 'mirror must not be a symlink'
[ "$(stat -c %u -- "$mirror")" = "$(id -u)" ] || fail 'mirror must be owned by the runner user'
[ "$(stat -c %a -- "$mirror")" = 700 ] || fail 'mirror mode must be 0700'
cd -- "$mirror"
[ "$(pwd -P)" = "$mirror" ] || fail 'mirror inode changed before init'
if [ "$mirror_created" = yes ]; then
  git init --bare --object-format="$object_format" -- .
fi
[ "$(git rev-parse --show-object-format)" = "$object_format" ] || fail 'mirror object format mismatch'
[ "$(git rev-parse --is-bare-repository)" = true ] || fail 'mirror must be bare'
printf 'root=%s\ncandidate=%s\nmirror=%s\n' "$root" "$candidate" "$mirror"`;

const RECEIVE_PACK_TRANSACTION = String.raw`set -eu
umask 077
root_input=$1
lock_input=$2
mirror_input=$3
fail() { printf '%s\n' "$1" >&2; exit 73; }
[ -d "$root_input" ] || fail 'root must be a directory'
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
root=$(realpath -- "$root_input")
[ "$root" = "$root_input" ] || fail 'root canonical path changed'
[ "$(stat -c %u -- "$root")" = "$(id -u)" ] || fail 'root must be owned by the runner user'
[ "$(stat -c %a -- "$root")" = 700 ] || fail 'root mode must be 0700'
case "$lock_input" in "$root"/.locks/*) ;; *) fail 'lock must be below root';; esac
exec 9>"$lock_input"
flock -x 9
[ ! -L "$mirror_input" ] || fail 'mirror must not be a symlink'
mirror=$(realpath -- "$mirror_input")
[ "$mirror" = "$mirror_input" ] || fail 'mirror canonical path changed'
[ "$(stat -c %u -- "$mirror")" = "$(id -u)" ] || fail 'mirror must be owned by the runner user'
[ "$(stat -c %a -- "$mirror")" = 700 ] || fail 'mirror mode must be 0700'
cd -- "$mirror"
[ "$(pwd -P)" = "$mirror" ] || fail 'mirror inode changed before receive-pack'
exec git-receive-pack .`;

const RECONCILE_TRANSACTION = String.raw`set -eu
umask 077
root_input=$1
candidate_input=$2
mirror_input=$3
lock_input=$4
oid=$5
fail() { printf '%s\n' "$1" >&2; exit 73; }
[ -d "$root_input" ] || fail 'root must be a directory'
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
root=$(realpath -- "$root_input")
[ "$root" = "$root_input" ] || fail 'root canonical path changed'
[ "$(stat -c %u -- "$root")" = "$(id -u)" ] || fail 'root must be owned by the runner user'
[ "$(stat -c %a -- "$root")" = 700 ] || fail 'root mode must be 0700'
confined() {
  resolved=$(realpath --canonicalize-missing -- "$1")
  case "$resolved" in "$root"/*) printf '%s\n' "$resolved";; *) fail 'path must be a strict descendant of root';; esac
}
confined_candidate() {
  resolved=$(confined "$candidate_input")
  [ "$resolved" = "$candidate_input" ] || fail 'candidate changed or contains a symlink'
  printf '%s\n' "$resolved"
}
lock_dir=$(confined "$root/.locks")
[ -d "$lock_dir" ] || fail 'runner lock directory is missing'
[ ! -L "$lock_dir" ] || fail 'runner lock directory must not be a symlink'
[ "$(stat -c %u -- "$lock_dir")" = "$(id -u)" ] || fail 'runner lock directory owner changed'
[ "$(stat -c %a -- "$lock_dir")" = 700 ] || fail 'runner lock directory mode changed'
lock=$(confined "$lock_input")
exec 9>"$lock"
flock -x 9
# Threat boundary: same-UID processes that ignore the consumer lock are not defended.
# Root/mirror/workspace ownership and 0700 modes exclude other users.
[ ! -L "$root_input" ] || fail 'root must not be a symlink'
[ "$(realpath -- "$root_input")" = "$root" ] || fail 'root changed after lock'
[ "$(stat -c %u -- "$root")" = "$(id -u)" ] || fail 'root must be owned by the runner user'
[ "$(stat -c %a -- "$root")" = 700 ] || fail 'root mode must be 0700'
mirror=$(confined "$mirror_input")
[ "$mirror" = "$mirror_input" ] || fail 'mirror changed or contains a symlink'
[ ! -L "$mirror" ] || fail 'mirror must not be a symlink'
[ "$(stat -c %u -- "$mirror")" = "$(id -u)" ] || fail 'mirror must be owned by the runner user'
[ "$(stat -c %a -- "$mirror")" = 700 ] || fail 'mirror mode must be 0700'
cd -- "$mirror"
[ "$(pwd -P)" = "$mirror" ] || fail 'mirror inode changed before reconciliation'
[ "$(git --git-dir=. rev-parse --is-bare-repository)" = true ] || fail 'mirror must be bare'
candidate=$(confined_candidate)
worktree_listing=$(git --git-dir=. worktree list --porcelain)
if ! printf '%s\n' "$worktree_listing" | grep -Fqx -- "worktree $candidate"; then
  candidate_parent=$(confined "$(dirname -- "$candidate_input")")
  [ "$candidate_parent" = "$(dirname -- "$candidate_input")" ] || fail 'candidate parent changed or contains a symlink'
  mkdir -p -- "$candidate_parent"
  chmod 700 -- "$candidate_parent"
  candidate=$(confined_candidate)
  git --git-dir=. worktree add --force --detach -- "$candidate" "$oid"
fi
candidate=$(confined_candidate)
cd -- "$candidate"
[ "$(pwd -P)" = "$candidate" ] || fail 'workspace inode changed before reconciliation'
git reset --hard "$oid" --
git clean -ffd --
git submodule sync --recursive
git submodule update --init --recursive --force --
git submodule foreach --recursive 'git reset --hard HEAD -- && git clean -ffd --'`;

export type PrivateRef = `refs/remote-runner/${string}/${string}/${string}`;

export interface GitWorkspaceOptions {
  readonly consumer: string;
  readonly profile: string;
  readonly sourceRoot: string;
  readonly remoteTarget: string;
  readonly generatedRoot: string;
  readonly baseRef?: string;
  readonly knownHostsPath: string;
  readonly connectTimeoutSeconds: number;
}

function remoteTrackingRef(baseRef: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(baseRef)) {
    throw new Error("workspace base ref must be a safe remote-tracking name");
  }
  return `refs/remotes/${baseRef}`;
}

export interface WorkspaceResult {
  readonly identity: string;
  readonly remoteRoot: string;
  readonly privateRef: PrivateRef;
}

function assertComponent(value: string, label: string): void {
  if (!COMPONENT.test(value)) throw new Error(`${label} must be a safe ref component`);
}

function assertAbsolutePath(value: string, label: string): void {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || !posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path without control terminators`);
  }
}

export function assertConfinedWorkspace(generatedRoot: string, candidate: string): string {
  assertAbsolutePath(generatedRoot, "generated root");
  assertAbsolutePath(candidate, "workspace candidate");
  const relative = posix.relative(generatedRoot, candidate);
  if (relative === "" || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
    throw new Error("workspace target must be a strict descendant of the generated root");
  }
  return candidate;
}

function assertBoundedSuccess(
  result: BoundedProcessResult,
  label: string,
  maximumBytes = CAPTURE_BYTES,
): void {
  if (
    result.outputTruncated ||
    result.stdout.byteLength > maximumBytes ||
    result.stderr.byteLength > maximumBytes
  ) {
    throw new Error(`${label} exceeded the process output limit`);
  }
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
}

function singleRecord(contents: Uint8Array, label: string): string {
  let output = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  if (output.endsWith("\r\n")) output = output.slice(0, -2);
  else if (output.endsWith("\n") || output.endsWith("\r")) output = output.slice(0, -1);
  if (output.includes("\n") || output.includes("\r")) throw new Error(`${label} returned multiple records`);
  return output;
}

function canonicalRecords(result: BoundedProcessResult): {
  root: string;
  candidate: string;
  mirror: string;
} {
  let output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  if (output.endsWith("\r\n")) output = output.slice(0, -2);
  else if (output.endsWith("\n") || output.endsWith("\r")) output = output.slice(0, -1);
  const records = new Map<string, string>();
  for (let line of output.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("prepare workspace returned a malformed canonical record");
    const key = line.slice(0, separator);
    if (records.has(key)) throw new Error(`prepare workspace returned duplicate ${key}`);
    records.set(key, line.slice(separator + 1));
  }
  if (records.size !== 3 || !records.has("root") || !records.has("candidate") || !records.has("mirror")) {
    throw new Error("prepare workspace returned incomplete canonical records");
  }
  const root = records.get("root")!;
  const candidate = records.get("candidate")!;
  const mirror = records.get("mirror")!;
  assertAbsolutePath(root, "canonical generated root");
  assertAbsolutePath(candidate, "canonical workspace");
  assertAbsolutePath(mirror, "canonical mirror");
  return { root, candidate, mirror };
}

async function remote(
  processes: SshProcessRuntime,
  options: GitWorkspaceOptions,
  args: readonly string[],
  label: string,
): Promise<BoundedProcessResult> {
  const result = await runSsh(
    processes,
    options.remoteTarget,
    args,
    options.connectTimeoutSeconds,
    options.knownHostsPath,
    CAPTURE_BYTES,
  );
  assertBoundedSuccess(result, label);
  return result;
}

export async function reconcileWorkspace(
  options: GitWorkspaceOptions,
  processes: SshProcessRuntime,
): Promise<WorkspaceResult> {
  assertComponent(options.consumer, "consumer");
  assertComponent(options.profile, "profile");
  if (options.sourceRoot.includes("\0") || !isAbsolute(options.sourceRoot)) {
    throw new Error("source root must be an absolute path without NUL");
  }
  assertAbsolutePath(options.generatedRoot, "generated root");
  if (options.generatedRoot === "/") throw new Error("generated root must not be the filesystem root");

  const transport = sshArguments(
    options.remoteTarget,
    ["true"],
    options.connectTimeoutSeconds,
    options.knownHostsPath,
  ).slice(0, -2);
  const identity = worktreeIdentity(options.sourceRoot);
  if (!/^[0-9a-f]{24}$/u.test(identity)) {
    throw new Error("workspace identity must be 24 lowercase hex digits");
  }
  const privateRef = `refs/remote-runner/${options.consumer}/${options.profile}/${identity}` as PrivateRef;
  const candidateInput = posix.join(options.generatedRoot, options.consumer, options.profile, identity);
  const mirrorInput = posix.join(options.generatedRoot, options.consumer, ".mirror.git");
  const lockInput = posix.join(
    options.generatedRoot,
    ".locks",
    `${options.consumer}.lock`,
  );

  const formatResult = await processes.run({
    command: "git",
    args: ["rev-parse", "--show-object-format"],
    cwd: options.sourceRoot,
    maxOutputBytes: CAPTURE_BYTES,
  });
  assertBoundedSuccess(formatResult, "resolve local object format");
  const objectFormat = singleRecord(formatResult.stdout, "resolve local object format");
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error("local object format must be sha1 or sha256");
  }

  const headResult = await processes.run({
    command: "git",
    args: ["rev-parse", "--verify", "HEAD^{commit}", "--"],
    cwd: options.sourceRoot,
    maxOutputBytes: CAPTURE_BYTES,
  });
  assertBoundedSuccess(headResult, "resolve local HEAD");
  const headOid = singleRecord(headResult.stdout, "resolve local HEAD");
  const expectedOidLength = objectFormat === "sha1" ? 40 : 64;
  if (!OBJECT_ID.test(headOid) || headOid.length !== expectedOidLength) {
    throw new Error(`local HEAD object ID must match ${objectFormat}`);
  }
  const baseRef = options.baseRef === undefined ? undefined : remoteTrackingRef(options.baseRef);
  let baseOid: string | undefined;
  if (baseRef !== undefined) {
    const baseResult = await processes.run({
      command: "git",
      args: ["rev-parse", "--verify", `${baseRef}^{commit}`, "--"],
      cwd: options.sourceRoot,
      maxOutputBytes: CAPTURE_BYTES,
    });
    assertBoundedSuccess(baseResult, "resolve local base ref");
    baseOid = singleRecord(baseResult.stdout, "resolve local base ref");
    if (!OBJECT_ID.test(baseOid) || baseOid.length !== expectedOidLength) {
      throw new Error(`local base ref object ID must match ${objectFormat}`);
    }
  }

  const prepared = canonicalRecords(await remote(
    processes,
    options,
    [
      "sh",
      "-ceu",
      PREPARE_TRANSACTION,
      "remote-runner-git-prepare",
      options.generatedRoot,
      candidateInput,
      mirrorInput,
      lockInput,
      objectFormat,
    ],
    "prepare workspace",
  ));
  assertConfinedWorkspace(prepared.root, prepared.candidate);
  assertConfinedWorkspace(prepared.root, prepared.mirror);
  if (prepared.candidate !== posix.join(prepared.root, options.consumer, options.profile, identity)) {
    throw new Error("prepare workspace returned an unexpected canonical workspace");
  }
  if (prepared.mirror !== posix.join(prepared.root, options.consumer, ".mirror.git")) {
    throw new Error("prepare workspace returned an unexpected canonical mirror");
  }
  const consumerLock = posix.join(prepared.root, ".locks", `${options.consumer}.lock`);
  const receivePack = encodePosixCommand([
    "sh",
    "-ceu",
    RECEIVE_PACK_TRANSACTION,
    "remote-runner-git-receive",
    prepared.root,
    consumerLock,
  ]);

  const push = await processes.run({
    command: "git",
    args: [
      "push",
      "--quiet",
      "--force",
      `--receive-pack=${receivePack}`,
      "--",
      `${options.remoteTarget}:${prepared.mirror}`,
      `${headOid}:${privateRef}`,
      ...(baseRef === undefined || baseOid === undefined ? [] : [`${baseOid}:${baseRef}`]),
    ],
    cwd: options.sourceRoot,
    environment: {
      GIT_SSH_COMMAND: encodePosixCommand(["ssh", ...transport]),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    },
    maxOutputBytes: PUSH_CAPTURE_BYTES,
  });
  assertBoundedSuccess(push, "push HEAD object", PUSH_CAPTURE_BYTES);

  await remote(
    processes,
    options,
    [
      "sh",
      "-ceu",
      RECONCILE_TRANSACTION,
      "remote-runner-git-reconcile",
      prepared.root,
      prepared.candidate,
      prepared.mirror,
      consumerLock,
      headOid,
    ],
    "reconcile workspace",
  );

  return { identity, remoteRoot: prepared.candidate, privateRef };
}
