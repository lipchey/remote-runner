import { readFile, realpath } from "node:fs/promises";
import { homedir, arch } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { CliDependencies } from "../cli.js";
import { mutagenDarwinArchitecture } from "../install/mutagen.js";
import { createNodeNotificationCallbacks } from "../node/notifications.js";
import { ensureNodeController } from "../node/controller.js";
import { worktreeIdentity } from "../runtime/identity.js";
import { runProfile } from "../run/run-profile.js";
import { createProfileRuntime } from "./profile-runtime.js";
import { NodeProfileServices } from "./pilot-services.js";

export function installedMutagenPath(home: string): string {
  const machine = arch() === "arm64" ? "arm64" : "x86_64";
  const distribution = mutagenDarwinArchitecture(machine);
  return join(home, ".local", "share", "remote-runner", "bin", `mutagen-v0.18.1-darwin-${distribution}`, "mutagen");
}

export async function createNodeCliDependencies(): Promise<CliDependencies> {
  const home = homedir();
  const sourceRoot = await realpath(process.cwd());
  const launcherSource = new Uint8Array(await readFile(new URL("../../assets/remote-launcher.mjs", import.meta.url)));
  const mutagenCommand = installedMutagenPath(home);
  return {
    readFile: async (path) => readFile(path),
    ensureController: () => ensureNodeController(home),
    async runProfile(profile, command, mode) {
      const identity = worktreeIdentity(sourceRoot);
      const notifications = createNodeNotificationCallbacks({
        statePath: join(home, ".local", "state", "remote-runner", "profiles", profile.consumer, profile.id, identity, "outage.json"),
        configPath: join(home, ".claude", ".telegram-ask.conf"),
        context: { consumer: profile.consumer, profile: profile.id, remoteLabel: profile.remote.label },
        stderr: (line) => process.stderr.write(`${line}\n`),
      });
      const services = new NodeProfileServices(profile, {
        home, sourceRoot, launcherSource, mutagenCommand,
        recordFallback: notifications.recordFallback,
        recordRemoteChildStarted: notifications.recordRemoteChildStarted,
      });
      return runProfile(createProfileRuntime(services), profile, command, mode);
    },
  };
}
