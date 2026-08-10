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
const OWNED_NAME = ".remote-runner-owned";

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

/* `launchctl bootout` reports success once launchd ACCEPTS the request, not once the job is gone:
   measured on darwin 24.6, the label still answers `launchctl print` more than four seconds after
   rc=0 while the controller is torn down, and every `bootstrap` inside that window fails with
   `5: Input/output error` — the same generic code an unusable plist produces. Retrying bootstrap
   blind for the two seconds this settle budget used to cover therefore reported
   `LaunchAgent bootstrap failed` on an install that had already swapped both artifacts, while the
   next install — seeing an unloaded agent — silently succeeded. Wait for the domain to release the
   label instead of guessing how long a teardown takes. */
export const SETTLE_POLLS = 300;

async function bootoutAndSettle(launch: LocalLaunchRuntime, settle: () => Promise<void>): Promise<void> {
  await launch.bootout();
  for (let poll = 1; poll <= SETTLE_POLLS; poll += 1) {
    if (!(await launch.status()).loaded) return;
    await settle();
  }
  /* The last settle is a wait like every other one, so the label has to be looked at after it too —
     throwing straight out of the loop would report a stuck agent for a teardown that just finished. */
  if ((await launch.status()).loaded) throw new Error("LaunchAgent is still loaded after bootout");
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

async function mtimeRange(
  roots: readonly string[],
): Promise<{ readonly oldest: number; readonly newest: number } | undefined> {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    oldest = Math.min(oldest, metadata.mtimeMs);
    newest = Math.max(newest, metadata.mtimeMs);
  };
  for (const root of roots) {
    try {
      await visit(root);
    } catch (caught) {
      if (!(
        typeof caught === "object" &&
        caught !== null &&
        "code" in caught &&
        (caught as { code?: unknown }).code === "ENOENT"
      )) {
        throw caught;
      }
    }
  }
  return newest === Number.NEGATIVE_INFINITY ? undefined : { oldest, newest };
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

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
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

async function applicationSources(sourceRoot: string): Promise<{
  readonly version: string;
  readonly digest: string;
  readonly sources: {
    readonly compiled: string;
    readonly assets: string;
    readonly yaml: string;
    readonly package: string;
  };
}> {
  assertAbsolute(sourceRoot, "install source root");
  const compiled = join(sourceRoot, "dist", "src");
  await access(join(compiled, "main.js")).catch((caught: unknown) => {
    throw new Error("install source must contain built dist/src/main.js", { cause: caught });
  });
  /* An identity hashed from an unbuilt `dist` is a lie in the one direction that matters: merge new
     sources, skip the build, and the digest still equals the installed receipt — so `install --check`
     reports `current` for exactly the drift it exists to catch, and `install` publishes the previous
     build under the current checkout's name. `mtimeRange` is checked BEFORE the digest so neither
     path can produce an identity no build attested.
     ponytail: mtimes, not a build-emitted content fingerprint — `touch` costs one needless rebuild
     and nothing worse, and git stamps checked-out sources with the checkout time, so the dangerous
     direction (new source looking older than the build) does not occur. Upgrade to a fingerprint
     written by `build` if that ever bites. */
  const built = await mtimeRange([compiled]);
  const authored = await mtimeRange([join(sourceRoot, "src"), join(sourceRoot, "tsconfig.json")]);
  if (built !== undefined && authored !== undefined && authored.newest > built.oldest) {
    throw new Error("install source dist/src is older than src: run `pnpm build`");
  }
  const sourcePackage = join(sourceRoot, "package.json");
  const version = packageVersion(await readFile(sourcePackage, "utf8"));
  const sources = {
    compiled,
    assets: join(sourceRoot, "assets"),
    yaml: join(sourceRoot, "node_modules", "yaml"),
    package: sourcePackage,
  };
  return {
    version,
    sources,
    digest: await treeDigest([sources.compiled, sources.assets, sources.yaml, sources.package]),
  };
}

/* The installed identity is the digest of what a checkout BUILDS, so the same computation answers
   "is the runner in ~/.local the one this checkout produces" without writing anything — the only
   local signal that a merged fix never reached the machine, since merging upstream installs
   nothing. It is exact only because `pnpm build` clears `dist` first: tsc leaves orphaned outputs
   of deleted sources behind, and those would drift the digest away from the checkout. */
export async function applicationIdentity(sourceRoot: string): Promise<InstallReceipt> {
  const { version, digest } = await applicationSources(sourceRoot);
  return { schemaVersion: 1, version, appIdentity: digest };
}

/* Every install publishes a new `app/<digest>` and repoints the shim at it; nothing ever removed the
   one it replaced, so the directory accumulated one full copy of the application per install. Pruning
   runs AFTER the launchd swap, so the controller is already executing out of the current application
   when its predecessor disappears. What authorises a deletion is the marker this installer writes
   inside every directory it creates, never the shape of the name: a `<digest>`-looking directory or a
   `.tmp-` prefix proves nothing about who made it, and `appParent` may itself be a symlink into a
   tree that is none of our business. An entry whose marker cannot be READ is skipped rather than
   assumed unowned — EACCES/EIO mean "cannot tell", and a wrong answer here costs data, while the
   wrong answer in the other direction costs disk.
   ponytail: keeps the current digest and nothing else, and install takes no lock, so it inherits two
   ceilings a keep-nothing policy makes destructive rather than merely wasteful — a `run` already
   started from an older application fails with `remote launcher asset is missing` if it has not yet
   reached `executionResources()` (that asset is read from the application directory on demand), and
   two concurrent installs can each delete the other's published application, leaving the shim
   pointing at nothing. Both recover by installing again; keep the N most recent, or serialize on the
   runtime lock, if either ever bites. */
async function pruneSupersededApplications(appParent: string, keep: string): Promise<void> {
  /* Enumeration failing is not evidence that nothing is here, so it prunes nothing rather than
     guessing — the same asymmetry the marker read below rests on. */
  const entries = await readdir(appParent, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== keep)
      .map(async (entry) => {
        const path = join(appParent, entry.name);
        const marker = await readFile(join(path, OWNED_NAME), "utf8").catch(() => undefined);
        /* Both shapes this installer creates carry a bare digest: the published `<digest>` directory
           and the `.tmp-<digest>-<uuid>` staging a crashed install leaves behind. */
        if (marker === undefined || !/^[0-9a-f]{24}\n$/u.test(marker)) return;
        /* Best effort: a superseded copy that resists removal is disk to reclaim on the next install,
           never a reason to fail an install that already succeeded. */
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }),
  );
}

export async function installLocalApplication(options: LocalInstallOptions): Promise<LocalInstallResult> {
  assertAbsolute(options.home, "install home");
  assertAbsolute(options.sourceRoot, "install source root");
  assertAbsolute(options.nodePath, "install Node path");
  const { version, sources, digest } = await applicationSources(options.sourceRoot);
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
    const marker = await readFile(join(appRoot, OWNED_NAME), "utf8");
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
      /* Written before the payload, not after it: the marker is what authorises pruning to delete a
         staging directory, and a crash lands anywhere inside the copy that follows. */
      await writeFile(join(staging, OWNED_NAME), `${digest}\n`, { mode: 0o600 });
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
      await writeFile(join(staging, INSTALL_RECEIPT_NAME), formatInstallReceipt(receipt), { mode: 0o600 });
      await rename(staging, appRoot);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const executable = `#!/bin/sh\n${OWNED_MARKER}\nexec ${shellArgument(options.nodePath)} ${shellArgument(join(appRoot, "src", "main.js"))} "$@"\n`;
  const launchPlist = plist(executablePath);
  /* allSettled, not all: Promise.all returns at the first rejection while the sibling artifact is
     mid-write, so its `.tmp-<uuid>` file lands after the caller has already given up on the
     install — an orphan in ~/Library/LaunchAgents nobody owns. */
  const written = await Promise.allSettled([
    atomicOwnedFile(
      executablePath,
      executable,
      0o755,
      (value) => value.startsWith(`${OWNED_MARKER}\n`) || value.startsWith(`#!/bin/sh\n${OWNED_MARKER}\n`),
    ),
    atomicOwnedFile(plistPath, launchPlist, 0o600, (value) => value.includes(`<string>${LABEL}</string>`)),
    options.launch.status(),
  ]);
  const executableChanged = settledValue(written[0]);
  const plistChanged = settledValue(written[1]);
  const launch = settledValue(written[2]);
  const settleLaunchd = options.settleLaunchd ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  if (launch.loaded && (executableChanged || plistChanged)) {
    await bootoutAndSettle(options.launch, settleLaunchd);
    await bootstrapLaunchAgent(options.launch, plistPath, settleLaunchd);
  } else if (!launch.loaded) {
    await bootstrapLaunchAgent(options.launch, plistPath, settleLaunchd);
  } else if (!launch.running) {
    await options.launch.kickstart();
  }
  await pruneSupersededApplications(appParent, digest);
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
