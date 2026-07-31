#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import process from "node:process";

import { createNodeCliDependencies, installedMutagenPath } from "./app/default-dependencies.js";
import { runCli, type CliDependencies, type CliIo } from "./cli.js";
import { runController } from "./node/controller.js";

export async function runMain(
  argv: readonly string[],
  io: CliIo,
  dependencies?: CliDependencies,
): Promise<number> {
  if (argv[0] === "controller") return runController(installedMutagenPath(process.env.HOME ?? ""));
  return runCli(argv, io, dependencies ?? await createNodeCliDependencies());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runMain(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
