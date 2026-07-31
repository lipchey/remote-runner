import { readFile, realpath } from "node:fs/promises";
import { homedir, arch } from "node:os";
import { join } from "node:path";
import process from "node:process";

import type { CliDependencies } from "../cli.js";
import { mutagenDarwinArchitecture } from "../install/mutagen.js";
import { createNodeNotificationCallbacks } from "../node/notifications.js";
import { ensureNodeController } from "../node/controller.js";
import { ensureManagedSshTransport, mutagenSshEnvironment } from "../node/managed-ssh.js";
import { NodeProcessRuntime } from "../node/process.js";
import { worktreeIdentity } from "../runtime/identity.js";
import { runProfile } from "../run/run-profile.js";
import { createProfileRuntime } from "./profile-runtime.js";
import { NodeProfileServices } from "./pilot-services.js";

export function installedMutagenPath(home: string): string {
  const machine = arch() === "arm64" ? "arm64" : "x86_64";
  const distribution = mutagenDarwinArchitecture(machine);
  return join(home, ".local", "share", "remote-runner", "bin", `mutagen-v0.18.1-darwin-${distribution}`, "mutagen");
}

export function launcherAssetCandidates(moduleUrl: string): readonly URL[] {
  return [
    new URL("../../assets/remote-launcher.mjs", moduleUrl),
    new URL("../../../assets/remote-launcher.mjs", moduleUrl),
  ];
}

async function readLauncherSource(): Promise<Uint8Array> {
  for (const candidate of launcherAssetCandidates(import.meta.url)) {
    try { return new Uint8Array(await readFile(candidate)); }
    catch (caught) {
      if (!(typeof caught === "object" && caught !== null && "code" in caught && (caught as { code?: unknown }).code === "ENOENT")) throw caught;
    }
  }
  throw new Error("remote launcher asset is missing");
}

export async function createNodeCliDependencies(): Promise<CliDependencies> {
  const home = homedir();
  const managedSsh = await ensureManagedSshTransport(home);
  const sourceRoot = await realpath(process.cwd());
  const launcherSource = await readLauncherSource();
  const mutagenCommand = installedMutagenPath(home);
  if (managedSsh.changed) {
    const stopped = await new NodeProcessRuntime().run({
      command: mutagenCommand,
      args: ["daemon", "stop"],
      environment: mutagenSshEnvironment(managedSsh.directory),
      maxOutputBytes: 64 * 1024,
    });
    if (stopped.exitCode !== 0 && stopped.exitCode !== 127) {
      throw new Error("unable to restart Mutagen after managed SSH transport update");
    }
  }
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
        managedSshPath: managedSsh.directory,
        knownHostsPath: managedSsh.knownHostsPath,
        recordFallback: notifications.recordFallback,
        recordRemoteChildStarted: notifications.recordRemoteChildStarted,
      });
      return runProfile(createProfileRuntime(services), profile, command, mode);
    },
  };
}
