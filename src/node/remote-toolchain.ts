import { posix } from "node:path";

export interface RemoteCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface RemoteCommandPort {
  run(args: readonly string[]): Promise<RemoteCommandResult>;
}

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

function checked(result: RemoteCommandResult, label: string): RemoteCommandResult {
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
  return result;
}

function singleLine(contents: Uint8Array, label: string): string {
  const value = decoder.decode(contents).replace(/\r?\n$/u, "");
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} returned an invalid record`);
  }
  return value;
}

export class RemoteToolchainRuntime {
  readonly temporaryRoot: string;

  constructor(
    private readonly remote: RemoteCommandPort,
    readonly toolchainRoot: string,
  ) {
    if (!posix.isAbsolute(toolchainRoot) || posix.normalize(toolchainRoot) !== toolchainRoot || toolchainRoot === "/") {
      throw new Error("toolchain root must be a canonical absolute path");
    }
    this.temporaryRoot = posix.join(toolchainRoot, ".tmp");
  }

  private assertBelowRoot(path: string, label: string): void {
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path) throw new Error(`${label} must be canonical`);
    const relative = posix.relative(this.toolchainRoot, path);
    if (relative === "" || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
      throw new Error(`${label} escaped the toolchain root`);
    }
  }

  private assertTemporary(path: string): void {
    this.assertBelowRoot(path, "temporary path");
    const relative = posix.relative(this.temporaryRoot, path);
    if (relative === "" || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) {
      throw new Error("temporary path escaped the toolchain temporary root");
    }
  }

  private async run(args: readonly string[], label: string): Promise<RemoteCommandResult> {
    return checked(await this.remote.run(args), label);
  }

  async createTemporaryDirectory(label: string): Promise<string> {
    if (!SAFE_LABEL.test(label)) throw new Error("temporary directory label is invalid");
    const result = await this.run([
      "sh", "-ceu",
      'umask 077; mkdir -p -- "$1"; chmod 700 -- "$1"; mktemp -d "$1/$2.XXXXXX"',
      "remote-runner-toolchain-temp",
      this.temporaryRoot,
      label,
    ], "create remote toolchain temporary directory");
    const path = singleLine(result.stdout, "remote mktemp");
    this.assertTemporary(path);
    return path;
  }

  async readText(url: string): Promise<string> {
    this.assertDownloadUrl(url);
    const result = await this.run([
      "curl", "--fail", "--location", "--silent", "--show-error", url,
    ], "read remote release manifest");
    return decoder.decode(result.stdout);
  }

  private assertDownloadUrl(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("download URL is invalid"); }
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      throw new Error("download URL must be credential-free HTTPS");
    }
  }

  async download(url: string, destination: string): Promise<void> {
    this.assertDownloadUrl(url);
    this.assertTemporary(destination);
    await this.run([
      "curl", "--fail", "--location", "--silent", "--show-error", "--output", destination, url,
    ], "download remote toolchain archive");
  }

  async sha256(path: string): Promise<string> {
    this.assertBelowRoot(path, "digest path");
    const result = await this.run(["sha256sum", "--", path], "hash remote toolchain archive");
    const output = decoder.decode(result.stdout);
    const digest = output.trim().split(/\s+/u)[0] ?? "";
    if (!SHA256.test(digest)) throw new Error("remote sha256sum returned an invalid digest");
    return digest;
  }

  async extract(archive: string, destination: string): Promise<void> {
    this.assertTemporary(archive);
    this.assertTemporary(destination);
    await this.run(["mkdir", "-p", "--", destination], "create remote extraction directory");
    await this.run(["tar", "-xf", archive, "-C", destination], "extract remote toolchain archive");
  }

  async installPackageManager(nodeRoot: string, spec: string): Promise<void> {
    this.assertTemporary(nodeRoot);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(spec)) {
      throw new Error("package manager specifier is invalid");
    }
    await this.run([
      posix.join(nodeRoot, "bin", "node"),
      posix.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      "install", "--global", "--prefix", nodeRoot, "--", spec,
    ], "install remote package manager");
  }

  async promote(from: string, to: string): Promise<void> {
    this.assertTemporary(from);
    this.assertBelowRoot(to, "promotion target");
    if (to.startsWith(`${this.temporaryRoot}/`) || to === this.temporaryRoot) {
      throw new Error("promotion target must be outside the temporary root");
    }
    await this.run([
      "sh", "-ceu",
      'umask 077; root=$1; source=$2; target=$3; mkdir -p -- "$root/.locks" "$(dirname -- "$target")"; exec 9>"$root/.locks/promote.lock"; flock -x 9; if [ ! -e "$target" ]; then mv -- "$source" "$target"; fi',
      "remote-runner-toolchain-promote",
      this.toolchainRoot,
      from,
      to,
    ], "promote remote toolchain");
  }

  async cleanup(path: string): Promise<void> {
    this.assertTemporary(path);
    await this.run(["rm", "-rf", "--", path], "remove remote toolchain temporary directory");
  }
}
