import { posix } from "node:path";

const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface UvInstallRuntime {
  installed(path: string): Promise<boolean>;
  createTemporaryDirectory(label: string): Promise<string>;
  download(url: string, destination: string): Promise<void>;
  sha256(path: string): Promise<string>;
  extract(archive: string, destination: string): Promise<void>;
  promote(from: string, to: string): Promise<void>;
  cleanup(path: string): Promise<void>;
}

export interface UvInstallOptions {
  readonly version: string;
  readonly machine: string;
  readonly sha256: string;
  readonly toolchainRoot: string;
}

export function uvLinuxTarget(machine: string): "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu" {
  if (machine === "x86_64" || machine === "amd64") return "x86_64-unknown-linux-gnu";
  if (machine === "aarch64" || machine === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`unsupported Linux architecture: ${JSON.stringify(machine)}`);
}

function validate(options: UvInstallOptions): void {
  if (!VERSION.test(options.version)) throw new Error("uv version must be exact semver");
  if (!SHA256.test(options.sha256)) throw new Error("uv checksum must be pinned SHA-256");
  if (
    !posix.isAbsolute(options.toolchainRoot) ||
    posix.normalize(options.toolchainRoot) !== options.toolchainRoot ||
    options.toolchainRoot === "/"
  ) {
    throw new Error("toolchain root must be a canonical absolute path");
  }
}

export async function installUv(runtime: UvInstallRuntime, options: UvInstallOptions) {
  validate(options);
  const target = uvLinuxTarget(options.machine);
  const archive = `uv-${target}.tar.gz`;
  const installedRoot = posix.join(options.toolchainRoot, `uv-${options.version}-${target}`);
  /* The promoted directory names the exact pinned version, so re-downloading it every run only
     buys a tens-of-megabytes transfer and a hard dependency on github.com being up right now. */
  if (await runtime.installed(posix.join(installedRoot, "uv"))) {
    return { version: options.version, target, root: installedRoot } as const;
  }
  const temporary = await runtime.createTemporaryDirectory(`uv-${options.version}-${target}`);
  const temporaryParent = posix.join(options.toolchainRoot, ".tmp");
  if (!temporary.startsWith(`${temporaryParent}/`) || posix.normalize(temporary) !== temporary) {
    throw new Error("temporary directory escaped the toolchain root");
  }
  const archivePath = posix.join(temporary, archive);
  const extractRoot = posix.join(temporary, "extract");
  const stagedRoot = posix.join(extractRoot, `uv-${target}`);
  const finalRoot = installedRoot;
  try {
    await runtime.download(
      `https://github.com/astral-sh/uv/releases/download/${options.version}/${archive}`,
      archivePath,
    );
    if ((await runtime.sha256(archivePath)) !== options.sha256) throw new Error("uv archive checksum mismatch");
    await runtime.extract(archivePath, extractRoot);
    await runtime.promote(stagedRoot, finalRoot);
    return { version: options.version, target, root: finalRoot } as const;
  } finally {
    await runtime.cleanup(temporary);
  }
}
