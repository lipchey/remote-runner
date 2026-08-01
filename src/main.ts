#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import process from "node:process";

import { createNodeCliDependencies, installedMutagenPath } from "./app/default-dependencies.js";
import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { runController } from "./node/controller.js";
import { ensureManagedSshTransport } from "./node/managed-ssh.js";
import { formatInstallVersion, readInstalledReceipt, type InstallReceipt } from "./node/install-receipt.js";
import { installCurrentApplication } from "./node/local-install.js";
import type { PrewarmRequest } from "./prewarm/queue.js";

export interface MainDependencies {
  installLocal(sourceRoot: string): Promise<{
    readonly executablePath: string;
    readonly version: string;
    readonly appIdentity: string;
  }>;
  readInstallReceipt?(): Promise<InstallReceipt>;
  createCliDependencies?(sourceRoot: string): Promise<CliDependencies>;
  runController?(runPrewarm: (request: PrewarmRequest) => Promise<number>): Promise<number>;
}

const DEFAULT_MAIN_DEPENDENCIES: MainDependencies = {
  installLocal: (sourceRoot) => installCurrentApplication(process.env.HOME ?? "", sourceRoot),
  readInstallReceipt: () => readInstalledReceipt(import.meta.url),
  createCliDependencies: (sourceRoot) => createNodeCliDependencies({ sourceRoot }),
  async runController(runPrewarm) {
    const home = process.env.HOME ?? "";
    const managedSsh = await ensureManagedSshTransport(home);
    return runController(installedMutagenPath(home), managedSsh.directory, home, runPrewarm);
  },
};

function boundedCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 512);
}

export async function runMain(
  argv: readonly string[],
  io: CliIo,
  dependencies?: CliDependencies,
  mainDependencies: MainDependencies = DEFAULT_MAIN_DEPENDENCIES,
): Promise<number> {
  if (argv[0] === "--version") {
    if (argv.length !== 1) {
      io.stderr("remote-runner --version does not accept arguments");
      return 2;
    }
    try {
      const readReceipt = mainDependencies.readInstallReceipt ?? DEFAULT_MAIN_DEPENDENCIES.readInstallReceipt!;
      io.stdout(formatInstallVersion(await readReceipt()));
      return 0;
    } catch (error) {
      io.stderr(`remote-runner version unavailable: ${boundedCause(error)}`);
      return 70;
    }
  }
  if (argv[0] === "install") {
    if (argv.length !== 1) {
      io.stderr("remote-runner install does not accept arguments");
      return 2;
    }
    try {
      const installed = await mainDependencies.installLocal(process.cwd());
      io.stdout(
        `installed ${formatInstallVersion({ schemaVersion: 1, version: installed.version, appIdentity: installed.appIdentity })}: ${installed.executablePath}`,
      );
      return 0;
    } catch (error) {
      io.stderr(`remote-runner install failed: ${boundedCause(error)}`);
      return 70;
    }
  }
  if (argv[0] === "controller") {
    const controller = mainDependencies.runController ?? DEFAULT_MAIN_DEPENDENCIES.runController!;
    const createDependencies =
      mainDependencies.createCliDependencies ?? DEFAULT_MAIN_DEPENDENCIES.createCliDependencies!;
    return controller(async (request) => {
      const queuedDependencies = await createDependencies(request.sourceRoot);
      return runCli(
        ["run", request.profile, "--mode", "remote", "--manifest", request.manifestPath],
        io,
        queuedDependencies,
      );
    });
  }
  return runCli(argv, io, dependencies ?? (await createNodeCliDependencies()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runMain(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
