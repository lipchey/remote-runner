#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import process from "node:process";

import { createNodeCliDependencies, installedMutagenPath } from "./app/default-dependencies.js";
import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { runController } from "./node/controller.js";
import { ensureManagedSshTransport } from "./node/managed-ssh.js";
import { installCurrentApplication } from "./node/local-install.js";

export interface MainDependencies {
  installLocal(): Promise<{ readonly executablePath: string }>;
}

export async function runMain(
  argv: readonly string[],
  io: CliIo,
  dependencies?: CliDependencies,
  mainDependencies: MainDependencies = {
    installLocal: () => installCurrentApplication(process.env.HOME ?? ""),
  },
): Promise<number> {
  if (argv[0] === "install") {
    try {
      const installed = await mainDependencies.installLocal();
      io.stdout(`installed remote-runner: ${installed.executablePath}`);
      return 0;
    } catch {
      io.stderr("remote-runner install failed");
      return 70;
    }
  }
  if (argv[0] === "controller") {
    const home = process.env.HOME ?? "";
    const managedSsh = await ensureManagedSshTransport(home);
    return runController(installedMutagenPath(home), managedSsh.directory);
  }
  return runCli(argv, io, dependencies ?? await createNodeCliDependencies());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runMain(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
