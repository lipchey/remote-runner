import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import type { Profile } from "../config/types.js";
import { NodeProcessRuntime } from "../node/process.js";
import { errorCode } from "../runtime/errno.js";
import type { SshProcessRuntime } from "../ssh/client.js";

import {
  ensureDependencySetup,
  packageManagerFromPackageJson,
  type HealthySetupState,
  type SetupResult,
} from "./dependencies.js";
import { dependencyFingerprint, type GitlinkIdentity } from "./fingerprint.js";
import { localNodeVersion } from "./node.js";

const SETUP_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface LocalDependencyOptions {
  readonly workspaceRoot: string;
  readonly statePath: string;
  readonly bootstrap: Pick<Profile["bootstrap"], "packageManager" | "setup" | "artifacts" | "ensure">;
  readonly fingerprintFiles: readonly string[];
  readonly gitlinks: readonly GitlinkIdentity[];
  readonly processes?: SshProcessRuntime;
}

async function readHealthyState(path: string): Promise<HealthySetupState | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as Partial<HealthySetupState> | null;
    if (
      state === null ||
      typeof state !== "object" ||
      typeof state.fingerprint !== "string" ||
      state.environment === null ||
      typeof state.environment !== "object" ||
      typeof state.environment.node !== "string" ||
      typeof state.environment.packageManager !== "string" ||
      (state.environment.uv !== undefined && typeof state.environment.uv !== "string")
    )
      return undefined;
    return state as HealthySetupState;
  } catch (caught) {
    if (errorCode(caught) === "ENOENT" || caught instanceof SyntaxError) return undefined;
    throw caught;
  }
}

async function writeHealthyState(path: string, state: HealthySetupState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.local-setup-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ensureLocalDependencies(options: LocalDependencyOptions): Promise<SetupResult> {
  const { workspaceRoot, statePath, bootstrap } = options;
  const processes = options.processes ?? new NodeProcessRuntime();
  const environment = {
    node: `${localNodeVersion()}-${process.platform}-${process.arch}`,
    packageManager: packageManagerFromPackageJson(await readFile(join(workspaceRoot, bootstrap.packageManager))),
  };
  const fingerprint = await dependencyFingerprint(
    {
      readFile: (path) => readFile(join(workspaceRoot, path)),
      listGitlinks: async () => options.gitlinks,
      sha256: async (contents) => createHash("sha256").update(contents).digest("hex"),
    },
    { environment, files: options.fingerprintFiles },
  );
  const run = async (command: readonly string[]) => {
    const result = await processes.run({
      command: command[0]!,
      args: command.slice(1),
      cwd: workspaceRoot,
      /* Bootstrap uses the local toolchain and ambient environment. Workload-only overrides can
         contain remote absolute paths, and secrets are collected separately before the workload. */
      environment: {
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":"),
        REMOTE_RUNNER_CHILD: "1",
        REMOTE_RUNNER_PROVIDER: "local",
      },
      maxOutputBytes: SETUP_CAPTURE_BYTES,
    });
    if (result.outputTruncated) throw new Error("local dependency command output exceeded the limit");
    return { exitCode: result.exitCode, spawned: result.spawned };
  };
  return ensureDependencySetup(
    {
      readHealthyState: () => readHealthyState(statePath),
      checkArtifact: async (artifact) => {
        try {
          return { exitCode: (await stat(join(workspaceRoot, artifact))).isFile() ? 0 : 1, spawned: true };
        } catch (caught) {
          if (errorCode(caught) === "ENOENT" || errorCode(caught) === "ENOTDIR") return { exitCode: 1, spawned: true };
          throw caught;
        }
      },
      runSetup: (script) => run([script]),
      runEnsure: (command) => run(command),
      writeHealthyState: (state) => writeHealthyState(statePath, state),
    },
    {
      fingerprint,
      environment,
      workspaceRoot,
      setup: bootstrap.setup,
      artifacts: bootstrap.artifacts,
      ensure: bootstrap.ensure,
    },
  );
}
