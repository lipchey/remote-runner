import { posix } from "node:path";

const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface GitleaksInstallRuntime {
  createTemporaryDirectory(label: string): Promise<string>;
  download(url: string, destination: string): Promise<void>;
  sha256(path: string): Promise<string>;
  extract(archive: string, destination: string): Promise<void>;
  promote(from: string, to: string): Promise<void>;
  cleanup(path: string): Promise<void>;
}

export interface GitleaksInstallOptions {
  readonly version: string;
  readonly machine: string;
  readonly sha256: string;
  readonly toolchainRoot: string;
}

export function gitleaksLinuxArchitecture(machine: string): "x64" | "arm64" {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error(`unsupported Linux architecture: ${JSON.stringify(machine)}`);
}

export async function installGitleaks(runtime: GitleaksInstallRuntime, options: GitleaksInstallOptions) {
  if (!VERSION.test(options.version)) throw new Error("gitleaks version must be exact semver");
  if (!SHA256.test(options.sha256)) throw new Error("gitleaks checksum must be pinned SHA-256");
  if (
    !posix.isAbsolute(options.toolchainRoot) ||
    posix.normalize(options.toolchainRoot) !== options.toolchainRoot ||
    options.toolchainRoot === "/"
  ) {
    throw new Error("toolchain root must be a canonical absolute path");
  }
  const arch = gitleaksLinuxArchitecture(options.machine);
  const archive = `gitleaks_${options.version}_linux_${arch}.tar.gz`;
  const temporary = await runtime.createTemporaryDirectory(`gitleaks-${options.version}-${arch}`);
  const temporaryParent = posix.join(options.toolchainRoot, ".tmp");
  if (!temporary.startsWith(`${temporaryParent}/`) || posix.normalize(temporary) !== temporary) {
    throw new Error("temporary directory escaped the toolchain root");
  }
  const archivePath = posix.join(temporary, archive);
  const stagedRoot = posix.join(temporary, "extract");
  const finalRoot = posix.join(options.toolchainRoot, `gitleaks-${options.version}-linux-${arch}`);
  try {
    await runtime.download(
      `https://github.com/gitleaks/gitleaks/releases/download/v${options.version}/${archive}`,
      archivePath,
    );
    if ((await runtime.sha256(archivePath)) !== options.sha256) throw new Error("gitleaks archive checksum mismatch");
    await runtime.extract(archivePath, stagedRoot);
    await runtime.promote(stagedRoot, finalRoot);
    return { version: options.version, arch, root: finalRoot } as const;
  } finally {
    await runtime.cleanup(temporary);
  }
}
