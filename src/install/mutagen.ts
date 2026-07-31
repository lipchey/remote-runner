import { posix } from "node:path";

const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface MutagenInstallRuntime {
  createTemporaryDirectory(label: string): Promise<string>;
  readText(url: string): Promise<string>;
  download(url: string, path: string): Promise<void>;
  sha256(path: string): Promise<string>;
  extract(archive: string, destination: string): Promise<void>;
  promote(from: string, to: string): Promise<void>;
  cleanup(path: string): Promise<void>;
}

export interface MutagenInstallOptions {
  readonly version: string;
  readonly machine: string;
  readonly installRoot: string;
}

export function mutagenDarwinArchitecture(machine: string): "amd64" | "arm64" {
  if (machine === "x86_64" || machine === "amd64") return "amd64";
  if (machine === "arm64" || machine === "aarch64") return "arm64";
  throw new Error(`unsupported Darwin architecture: ${JSON.stringify(machine)}`);
}

function exactDigest(manifest: string, archive: string): string {
  if (manifest.length > 1024 * 1024 || manifest.includes("\0")) throw new Error("Mutagen checksum manifest is invalid");
  const matches = manifest.split(/\r?\n/u).flatMap((line) => {
    const match = /^([0-9a-f]{64})  (\S+)$/u.exec(line);
    return match?.[2] === archive ? [match[1]!] : [];
  });
  if (matches.length !== 1) throw new Error("Mutagen checksum manifest is missing the exact archive entry");
  return matches[0]!;
}

export async function installMutagen(runtime: MutagenInstallRuntime, options: MutagenInstallOptions) {
  if (!VERSION.test(options.version)) throw new Error("Mutagen version must be exact semver");
  if (!posix.isAbsolute(options.installRoot) || posix.normalize(options.installRoot) !== options.installRoot || options.installRoot === "/") {
    throw new Error("Mutagen install root must be a canonical absolute path");
  }
  const arch = mutagenDarwinArchitecture(options.machine);
  const archive = `mutagen_darwin_${arch}_v${options.version}.tar.gz`;
  const baseUrl = `https://github.com/mutagen-io/mutagen/releases/download/v${options.version}`;
  const expected = exactDigest(await runtime.readText(`${baseUrl}/SHA256SUMS`), archive);
  const temporary = await runtime.createTemporaryDirectory(`mutagen-${options.version}-${arch}`);
  const temporaryParent = posix.join(options.installRoot, ".tmp");
  if (!temporary.startsWith(`${temporaryParent}/`) || posix.normalize(temporary) !== temporary) {
    throw new Error("temporary directory escaped the Mutagen install root");
  }
  const archivePath = posix.join(temporary, archive);
  const stagedRoot = posix.join(temporary, "extract");
  const finalRoot = posix.join(options.installRoot, `mutagen-v${options.version}-darwin-${arch}`);
  try {
    await runtime.download(`${baseUrl}/${archive}`, archivePath);
    const actual = await runtime.sha256(archivePath);
    if (!SHA256.test(actual) || actual !== expected) throw new Error("Mutagen archive checksum mismatch");
    await runtime.extract(archivePath, stagedRoot);
    await runtime.promote(stagedRoot, finalRoot);
    return { version: options.version, arch, root: finalRoot } as const;
  } finally {
    await runtime.cleanup(temporary);
  }
}
