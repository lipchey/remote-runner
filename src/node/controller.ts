import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { ensureController, type ControllerRuntime, type ControllerStatus } from "../controller/controller.js";
import { mutagenSshEnvironment } from "./managed-ssh.js";
import { NodeProcessRuntime } from "./process.js";

const LABEL = "com.lipchey.remote-runner";

export class NodeControllerRuntime implements ControllerRuntime {
  constructor(
    private readonly home: string,
    private readonly processes = new NodeProcessRuntime(),
  ) {}

  private domain(): string {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("current uid is unavailable");
    return `gui/${uid}`;
  }

  async inspect(): Promise<ControllerStatus> {
    const result = await this.processes.run({
      command: "launchctl", args: ["print", `${this.domain()}/${LABEL}`], maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) return { loaded: false, running: false, compatible: true };
    const output = new TextDecoder().decode(result.stdout);
    return { loaded: true, running: /state\s*=\s*running/u.test(output), compatible: true };
  }
  async bootstrap() {
    const result = await this.processes.run({
      command: "launchctl",
      args: ["bootstrap", this.domain(), join(this.home, "Library", "LaunchAgents", `${LABEL}.plist`)],
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error("controller bootstrap failed");
  }
  async bootout() {
    const result = await this.processes.run({ command: "launchctl", args: ["bootout", `${this.domain()}/${LABEL}`], maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new Error("controller bootout failed");
  }
  async kickstart() {
    const result = await this.processes.run({ command: "launchctl", args: ["kickstart", "-k", `${this.domain()}/${LABEL}`], maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new Error("controller kickstart failed");
  }
  async registeredProfiles() {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.home, ".local", "state", "remote-runner", "registrations.json"), "utf8"));
      return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
    } catch { return []; }
  }
  async reconcile() { return { healthy: true }; }
  async recordHealth() {}
}

export async function ensureNodeController(home: string): Promise<void> {
  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  try { await access(plist); } catch { return; }
  await ensureController(new NodeControllerRuntime(home));
}

export async function runController(mutagenCommand: string, managedSshPath: string): Promise<number> {
  const processes = new NodeProcessRuntime();
  const result = await processes.run({
    command: mutagenCommand,
    args: ["daemon", "start"],
    environment: mutagenSshEnvironment(managedSshPath),
    maxOutputBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) return 70;
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  return 0;
}
