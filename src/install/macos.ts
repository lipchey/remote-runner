const LABEL = "com.lipchey.remote-runner";
const EXECUTABLE = "~/.local/bin/remote-runner";
const PLIST = "~/Library/LaunchAgents/com.lipchey.remote-runner.plist";

export const OWNED_MAC_PATHS = [
  EXECUTABLE,
  PLIST,
  "~/.local/state/remote-runner",
  "~/.cache/remote-runner",
] as const;

export type ArtifactStatus = "missing" | "compatible" | "owned-stale" | "foreign";

export interface MacInstallRuntime {
  currentUid(): Promise<number>;
  inspectArtifact(path: string, expected?: Uint8Array): Promise<ArtifactStatus>;
  writeOwned(path: string, contents: Uint8Array, mode: number): Promise<void>;
  launchStatus(): Promise<{ readonly loaded: boolean; readonly running: boolean }>;
  bootstrap(domain: string, plistPath: string): Promise<void>;
  bootout(domain: string, label: string): Promise<void>;
  kickstart(domain: string, label: string): Promise<void>;
  removeOwned(path: string): Promise<void>;
}

export interface MacInstallOptions {
  readonly executable: Uint8Array;
  readonly plistTemplate: string;
  readonly executablePath: string;
}

function renderPlist(template: string, executablePath: string): Uint8Array {
  if (!executablePath.startsWith("/") || /[\u0000-\u001f\u007f<>]/u.test(executablePath)) {
    throw new Error("controller executable path is invalid");
  }
  if (template.split("{{EXECUTABLE}}").length !== 2 || template.includes("{{VERSION}}")) {
    throw new Error("controller plist template is invalid");
  }
  return new TextEncoder().encode(template.replace("{{EXECUTABLE}}", executablePath));
}

export async function installMac(runtime: MacInstallRuntime, options: MacInstallOptions): Promise<void> {
  if (options.executable.byteLength === 0) throw new Error("remote-runner executable is empty");
  const plist = renderPlist(options.plistTemplate, options.executablePath);
  const [uid, executableStatus, plistStatus, launch] = await Promise.all([
    runtime.currentUid(),
    runtime.inspectArtifact(EXECUTABLE, options.executable),
    runtime.inspectArtifact(PLIST, plist),
    runtime.launchStatus(),
  ]);
  if (executableStatus === "foreign" || plistStatus === "foreign") {
    throw new Error("refusing to replace a foreign remote-runner artifact");
  }
  const domain = `gui/${uid}`;
  const plistChanged = plistStatus !== "compatible";
  const executableChanged = executableStatus !== "compatible";
  const artifactsChanged = executableChanged || plistChanged;
  if (launch.loaded && artifactsChanged) await runtime.bootout(domain, LABEL);
  if (executableChanged) await runtime.writeOwned(EXECUTABLE, options.executable, 0o755);
  if (plistChanged) await runtime.writeOwned(PLIST, plist, 0o600);
  if (!launch.loaded || artifactsChanged) await runtime.bootstrap(domain, PLIST);
  else if (!launch.running) await runtime.kickstart(domain, LABEL);
}

export async function uninstallMac(runtime: MacInstallRuntime): Promise<void> {
  const statuses = await Promise.all(OWNED_MAC_PATHS.map((path) => runtime.inspectArtifact(path)));
  if (statuses.includes("foreign")) throw new Error("refusing to remove a foreign remote-runner artifact");
  const [uid, launch] = await Promise.all([runtime.currentUid(), runtime.launchStatus()]);
  if (launch.loaded) await runtime.bootout(`gui/${uid}`, LABEL);
  for (let index = OWNED_MAC_PATHS.length - 1; index >= 0; index -= 1) {
    if (statuses[index] !== "missing") await runtime.removeOwned(OWNED_MAC_PATHS[index]!);
  }
}
