import { createHash, randomUUID } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import process from "node:process";

import {
  formatInstallReceipt,
  INSTALL_RECEIPT_NAME,
  packageVersion,
  parseInstallReceipt,
  type InstallReceipt,
} from "./install-receipt.js";
import { NodeProcessRuntime } from "./process.js";

const LABEL = "com.lipchey.remote-runner";
const OWNED_MARKER = "# remote-runner-owned:v1";

export interface LocalLaunchRuntime {
  status(): Promise<{ readonly loaded: boolean; readonly running: boolean }>;
  bootout(): Promise<void>;
  bootstrap(plistPath: string): Promise<void>;
  kickstart(): Promise<void>;
}

export interface LocalInstallOptions {
  readonly home: string;
  readonly sourceRoot: string;
  readonly nodePath: string;
  readonly launch: LocalLaunchRuntime;
  readonly settleLaunchd?: () => Promise<void>;
}

async function bootstrapLaunchAgent(
  launch: LocalLaunchRuntime,
  plistPath: string,
  settle: () => Promise<void>,
): Promise<void> {
  const attempts = 20;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await launch.bootstrap(plistPath);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await settle();
    }
  }
}

export interface LocalInstallResult {
  readonly appRoot: string;
  readonly appIdentity: string;
  readonly version: string;
  readonly executablePath: string;
  readonly plistPath: string;
}

export class NodeLocalLaunchRuntime implements LocalLaunchRuntime {
  private readonly processes = new NodeProcessRuntime();
  private domain(): string {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("current uid is unavailable");
    return `gui/${uid}`;
  }
  async status() {
    const result = await this.processes.run({
      command: "launchctl",
      args: ["print", `${this.domain()}/${LABEL}`],
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) return { loaded: false, running: false };
    return { loaded: true, running: /state\s*=\s*running/u.test(new TextDecoder().decode(result.stdout)) };
  }
  async bootout() {
    const result = await this.processes.run({
      command: "launchctl",
      args: ["bootout", `${this.domain()}/${LABEL}`],
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error("LaunchAgent bootout failed");
  }
  async bootstrap(plistPath: string) {
    const result = await this.processes.run({
      command: "launchctl",
      args: ["bootstrap", this.domain(), plistPath],
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error("LaunchAgent bootstrap failed");
  }
  async kickstart() {
    const result = await this.processes.run({
      command: "launchctl",
      args: ["kickstart", "-k", `${this.domain()}/${LABEL}`],
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error("LaunchAgent kickstart failed");
  }
}

function assertAbsolute(value: string, label: string): void {
  if (
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/" ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a canonical non-root absolute path`);
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function treeDigest(roots: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (root: string, path: string): Promise<void> => {
    const metadata = await lstat(path);
    const name = relative(root, path);
    if (metadata.isSymbolicLink()) {
      const resolved = await import("node:fs/promises").then(({ realpath }) => realpath(path));
      await visit(resolved, resolved);
      return;
    }
    if (metadata.isDirectory()) {
      hash.update(`d:${name}\0`);
      for (const entry of (await readdir(path)).sort()) await visit(root, join(path, entry));
      return;
    }
    if (!metadata.isFile()) throw new Error("install source contains an unsupported file type");
    hash.update(`f:${name}\0`);
    hash.update(await readFile(path));
  };
  for (const root of roots) await visit(root, root);
  return hash.digest("hex").slice(0, 24);
}

async function atomicOwnedFile(
  path: string,
  contents: string,
  mode: number,
  owns: (existing: string) => boolean,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("refusing to replace a foreign install artifact");
    const existing = await readFile(path, "utf8");
    if (!owns(existing)) throw new Error("refusing to replace a foreign install artifact");
    if (existing === contents && (metadata.mode & 0o777) === mode) return false;
  } catch (caught) {
    if (!(
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { code?: unknown }).code === "ENOENT"
    ))
      throw caught;
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw caught;
  }
  return true;
}

function plist(executablePath: string): string {
  if (/[<>&]/u.test(executablePath)) throw new Error("LaunchAgent executable path is not XML-safe");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${executablePath}</string><string>controller</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export async function installLocalApplication(options: LocalInstallOptions): Promise<LocalInstallResult> {
  assertAbsolute(options.home, "install home");
  assertAbsolute(options.sourceRoot, "install source root");
  assertAbsolute(options.nodePath, "install Node path");
  const sourceCompiled = join(options.sourceRoot, "dist", "src");
  await access(join(sourceCompiled, "main.js")).catch((caught: unknown) => {
    throw new Error("install source must contain built dist/src/main.js", { cause: caught });
  });
  const sourcePackage = join(options.sourceRoot, "package.json");
  const sourcePackageContents = await readFile(sourcePackage, "utf8");
  const version = packageVersion(sourcePackageContents);
  const sources = {
    compiled: sourceCompiled,
    assets: join(options.sourceRoot, "assets"),
    yaml: join(options.sourceRoot, "node_modules", "yaml"),
    package: sourcePackage,
  };
  const digest = await treeDigest([sources.compiled, sources.assets, sources.yaml, sources.package]);
  const receipt: InstallReceipt = { schemaVersion: 1, version, appIdentity: digest };
  const shareRoot = join(options.home, ".local", "share", "remote-runner");
  const appParent = join(shareRoot, "app");
  const appRoot = join(appParent, digest);
  const executablePath = join(options.home, ".local", "bin", "remote-runner");
  const plistPath = join(options.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  await Promise.all([
    mkdir(appParent, { recursive: true, mode: 0o700 }),
    mkdir(join(options.home, ".local", "bin"), { recursive: true, mode: 0o700 }),
    mkdir(join(options.home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 }),
  ]);
  try {
    const marker = await readFile(join(appRoot, ".remote-runner-owned"), "utf8");
    if (marker !== `${digest}\n`) throw new Error("refusing to reuse a foreign install application");
    const existingReceipt = parseInstallReceipt(await readFile(join(appRoot, INSTALL_RECEIPT_NAME), "utf8"));
    if (formatInstallReceipt(existingReceipt) !== formatInstallReceipt(receipt)) {
      throw new Error("refusing to reuse an install application with a mismatched receipt");
    }
  } catch (caught) {
    if (!(
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { code?: unknown }).code === "ENOENT"
    ))
      throw caught;
    const staging = join(appParent, `.tmp-${digest}-${randomUUID()}`);
    try {
      await mkdir(staging, { mode: 0o700 });
      await Promise.all([
        cp(sources.compiled, join(staging, "src"), { recursive: true, dereference: true }),
        cp(sources.assets, join(staging, "assets"), { recursive: true, dereference: true }),
        cp(sources.yaml, join(staging, "node_modules", "yaml"), { recursive: true, dereference: true }),
      ]);
      await writeFile(
        join(staging, "package.json"),
        `${JSON.stringify({ private: true, type: "module", version })}\n`,
        { mode: 0o600 },
      );
      await writeFile(join(staging, ".remote-runner-owned"), `${digest}\n`, { mode: 0o600 });
      await writeFile(join(staging, INSTALL_RECEIPT_NAME), formatInstallReceipt(receipt), { mode: 0o600 });
      await rename(staging, appRoot);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const executable = `#!/bin/sh\n${OWNED_MARKER}\nexec ${shellArgument(options.nodePath)} ${shellArgument(join(appRoot, "src", "main.js"))} "$@"\n`;
  const launchPlist = plist(executablePath);
  const [executableChanged, plistChanged, launch] = await Promise.all([
    atomicOwnedFile(
      executablePath,
      executable,
      0o755,
      (value) => value.startsWith(`${OWNED_MARKER}\n`) || value.startsWith(`#!/bin/sh\n${OWNED_MARKER}\n`),
    ),
    atomicOwnedFile(plistPath, launchPlist, 0o600, (value) => value.includes(`<string>${LABEL}</string>`)),
    options.launch.status(),
  ]);
  const settleLaunchd = options.settleLaunchd ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  if (launch.loaded && (executableChanged || plistChanged)) {
    await options.launch.bootout();
    await bootstrapLaunchAgent(options.launch, plistPath, settleLaunchd);
  } else if (!launch.loaded) {
    await bootstrapLaunchAgent(options.launch, plistPath, settleLaunchd);
  } else if (!launch.running) {
    await options.launch.kickstart();
  }
  return { appRoot, appIdentity: digest, version, executablePath, plistPath };
}

export async function installCurrentApplication(
  home: string,
  sourceRoot: string = process.cwd(),
): Promise<LocalInstallResult> {
  return installLocalApplication({
    home,
    sourceRoot,
    nodePath: process.execPath,
    launch: new NodeLocalLaunchRuntime(),
  });
}
