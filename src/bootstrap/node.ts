import { posix } from "node:path";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_MANAGER = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface NodeInstallRuntime {
  installed(path: string): Promise<boolean>;
  createTemporaryDirectory(label: string): Promise<string>;
  download(url: string, destination: string): Promise<void>;
  readText(url: string): Promise<string>;
  sha256(path: string): Promise<string>;
  extract(archive: string, destination: string): Promise<void>;
  installPackageManager(nodeRoot: string, spec: string): Promise<void>;
  promote(from: string, to: string): Promise<void>;
  cleanup(path: string): Promise<void>;
}

export interface NodeInstallOptions {
  readonly version: string;
  readonly machine: string;
  readonly packageManager: string;
  readonly toolchainRoot: string;
}

export interface InstalledNode {
  readonly version: string;
  readonly arch: "x64" | "arm64";
  readonly root: string;
  readonly packageManager: string;
}

export function localNodeVersion(versions: Readonly<{ node?: string }> = process.versions): string {
  const version = versions.node;
  if (version === undefined || !VERSION.test(version)) {
    throw new Error("local Node version must be exact semver");
  }
  return version;
}

export function nodeLinuxArchitecture(machine: string): "x64" | "arm64" {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error(`unsupported Linux architecture: ${JSON.stringify(machine)}`);
}

function assertRoot(root: string): void {
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    root === "/" ||
    /[\u0000-\u001f\u007f]/u.test(root)
  ) {
    throw new Error("toolchain root must be a canonical absolute path");
  }
}

function assertConfinedTemporary(root: string, temporary: string): void {
  const parent = posix.join(root, ".tmp");
  if (!temporary.startsWith(`${parent}/`) || posix.normalize(temporary) !== temporary) {
    throw new Error("temporary directory escaped the toolchain root");
  }
}

function slug(packageManager: string): string {
  return packageManager.replaceAll(/[^A-Za-z0-9.]/gu, "-");
}

function manifestDigest(manifest: string, archive: string): string {
  if (manifest.length > 1024 * 1024 || /\u0000/u.test(manifest)) {
    throw new Error("Node checksum manifest is invalid");
  }
  const matches = manifest.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})  (\S+)$/u.exec(line);
    return match?.[2] === archive ? [match[1]!] : [];
  });
  if (matches.length !== 1) throw new Error("Node checksum manifest is missing the exact archive entry");
  return matches[0]!;
}

export async function installNode(runtime: NodeInstallRuntime, options: NodeInstallOptions): Promise<InstalledNode> {
  if (!VERSION.test(options.version)) throw new Error("Node version must be exact semver");
  if (!PACKAGE_MANAGER.test(options.packageManager)) {
    throw new Error("package manager must be an exact package@version specifier");
  }
  assertRoot(options.toolchainRoot);
  const arch = nodeLinuxArchitecture(options.machine);
  const distribution = `node-v${options.version}-linux-${arch}`;
  const archive = `${distribution}.tar.xz`;
  /* The package manager is installed INTO this tree before promotion, so the directory has to name
     it too: keyed on the Node version alone, a package-manager bump would silently reuse a tree
     carrying the old one. */
  const finalRoot = posix.join(options.toolchainRoot, `${distribution}-${slug(options.packageManager)}`);
  /* Everything below the promotion is content-addressed by that name, so a promoted tree is final:
     re-downloading it every run only costs tens of megabytes and makes each run depend on
     nodejs.org answering right now. */
  if (await runtime.installed(posix.join(finalRoot, "bin", "node"))) {
    return { version: options.version, arch, root: finalRoot, packageManager: options.packageManager };
  }
  const baseUrl = `https://nodejs.org/dist/v${options.version}`;
  const expectedDigest = manifestDigest(await runtime.readText(`${baseUrl}/SHASUMS256.txt`), archive);
  const temporary = await runtime.createTemporaryDirectory(`node-${options.version}-${arch}`);
  assertConfinedTemporary(options.toolchainRoot, temporary);
  const archivePath = posix.join(temporary, archive);
  const extractRoot = posix.join(temporary, "extract");
  const stagedRoot = posix.join(extractRoot, distribution);
  try {
    await runtime.download(`${baseUrl}/${archive}`, archivePath);
    const actualDigest = await runtime.sha256(archivePath);
    if (!SHA256.test(actualDigest) || actualDigest !== expectedDigest) {
      throw new Error("Node archive checksum mismatch");
    }
    await runtime.extract(archivePath, extractRoot);
    // Node 25+ no longer bundles Corepack. The runtime installs the exact declared
    // package-manager package using the staged Node/npm before promotion.
    await runtime.installPackageManager(stagedRoot, options.packageManager);
    await runtime.promote(stagedRoot, finalRoot);
    return { version: options.version, arch, root: finalRoot, packageManager: options.packageManager };
  } finally {
    await runtime.cleanup(temporary);
  }
}
