import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applicationIdentity,
  installLocalApplication,
  SETTLE_POLLS,
  type LocalLaunchRuntime,
} from "../../../src/node/local-install.js";
import { parseInstallReceipt } from "../../../src/node/install-receipt.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeLaunch implements LocalLaunchRuntime {
  readonly actions: string[] = [];
  loaded = false;
  running = false;
  bootstrapFailures = 0;
  /* Real launchd keeps the label in the domain for seconds after `bootout` returns, and refuses
     every bootstrap until it is gone; a fake that unloads synchronously cannot see that at all. */
  settlePollsAfterBootout = 0;
  private settling = 0;
  statusFailure?: string;
  async status() {
    if (this.statusFailure !== undefined) throw new Error(this.statusFailure);
    if (this.settling > 0) {
      this.settling -= 1;
      if (this.settling === 0) this.loaded = false;
      return { loaded: true, running: false };
    }
    return { loaded: this.loaded, running: this.running };
  }
  async bootout() {
    this.actions.push("bootout");
    this.settling = this.settlePollsAfterBootout;
    this.loaded = this.settling > 0;
    this.running = false;
  }
  async bootstrap(_plist: string) {
    this.actions.push("bootstrap");
    if (this.loaded) throw new Error("Bootstrap failed: 5: Input/output error");
    if (this.bootstrapFailures > 0) {
      this.bootstrapFailures -= 1;
      throw new Error("launchd is still settling");
    }
    this.loaded = true;
    this.running = true;
  }
  async kickstart() {
    this.actions.push("kickstart");
    this.running = true;
  }
}

async function sourceFixture(): Promise<string> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "remote-runner-install-source-"));
  roots.push(sourceRoot);
  await Promise.all([
    mkdir(join(sourceRoot, "dist/src"), { recursive: true }),
    mkdir(join(sourceRoot, "assets"), { recursive: true }),
    mkdir(join(sourceRoot, "node_modules/yaml"), { recursive: true }),
  ]);
  await writeFile(join(sourceRoot, "dist/src/main.js"), "#!/usr/bin/env node\nconsole.log('runner');\n");
  await writeFile(join(sourceRoot, "assets/remote-launcher.mjs"), "export {};\n");
  await writeFile(join(sourceRoot, "package.json"), '{"name":"remote-runner","version":"0.1.0","type":"module"}\n');
  await writeFile(join(sourceRoot, "node_modules/yaml/package.json"), '{"name":"yaml","type":"module"}\n');
  await writeFile(join(sourceRoot, "node_modules/yaml/index.js"), "export const parse = () => ({});\n");
  return sourceRoot;
}

/* A checkout, unlike the install fixture, also carries the sources `dist` was compiled from — the
   only place the build-attestation guard has anything to compare. */
async function checkoutFixture(builtAfterSource: boolean): Promise<string> {
  const sourceRoot = await sourceFixture();
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "src/main.ts"), "export {};\n");
  await writeFile(join(sourceRoot, "tsconfig.json"), "{}\n");
  const source = new Date(builtAfterSource ? 1_000_000_000_000 : 2_000_000_000_000);
  const built = new Date(builtAfterSource ? 2_000_000_000_000 : 1_000_000_000_000);
  await Promise.all([
    utimes(join(sourceRoot, "src/main.ts"), source, source),
    utimes(join(sourceRoot, "tsconfig.json"), source, source),
    utimes(join(sourceRoot, "dist/src/main.js"), built, built),
  ]);
  return sourceRoot;
}

describe("self-contained local macOS install", () => {
  it("identifies a checkout with the same identity the install publishes", async () => {
    const sourceRoot = await checkoutFixture(true);
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-identity-check-"));
    roots.push(home);

    const identity = await applicationIdentity(sourceRoot);
    const installed = await installLocalApplication({
      home,
      sourceRoot,
      nodePath: "/usr/bin/node",
      launch: new FakeLaunch(),
    });

    expect(identity).toEqual({ schemaVersion: 1, version: "0.1.0", appIdentity: installed.appIdentity });
  });

  it("refuses to identify or install a checkout whose build is older than its sources", async () => {
    const sourceRoot = await checkoutFixture(false);
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-stale-build-"));
    roots.push(home);

    await expect(applicationIdentity(sourceRoot)).rejects.toThrow("older than src");
    await expect(
      installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch: new FakeLaunch() }),
    ).rejects.toThrow("older than src");
  });

  it("reports the source root before the Node path when both are invalid", async () => {
    await expect(
      installLocalApplication({
        home: "/valid/home",
        sourceRoot: "relative/source",
        nodePath: "relative/node",
        launch: new FakeLaunch(),
      }),
    ).rejects.toThrow("install source root");
  });

  it("installs an immutable app, stable executable, and LaunchAgent idempotently", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-home-"));
    roots.push(home);
    const launch = new FakeLaunch();

    const first = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });
    const second = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });

    expect(second.appRoot).toBe(first.appRoot);
    expect(first.appIdentity).toMatch(/^[0-9a-f]{24}$/u);
    expect(first.version).toBe("0.1.0");
    expect(parseInstallReceipt(await readFile(join(first.appRoot, ".remote-runner-receipt.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      version: "0.1.0",
      appIdentity: first.appIdentity,
    });
    expect(await readFile(join(first.appRoot, "src/main.js"), "utf8")).toContain("runner");
    expect(await readFile(join(first.appRoot, "assets/remote-launcher.mjs"), "utf8")).toContain("export");
    expect(await readFile(join(first.appRoot, "node_modules/yaml/package.json"), "utf8")).toContain('"yaml"');
    const executable = await readFile(first.executablePath, "utf8");
    expect(executable.startsWith("#!/bin/sh\n# remote-runner-owned:v1\n")).toBe(true);
    expect(executable).toContain(`exec /usr/bin/node ${join(first.appRoot, "src/main.js")}`);
    expect((await stat(first.executablePath)).mode & 0o777).toBe(0o755);
    expect(await readFile(first.plistPath, "utf8")).toContain(first.executablePath);
    expect((await stat(first.plistPath)).mode & 0o777).toBe(0o600);
    expect(launch.actions).toEqual(["bootstrap"]);
  });

  it("changes immutable identity when compiled code or package version changes", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-identity-"));
    roots.push(home);
    const launch = new FakeLaunch();

    const original = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });
    await writeFile(join(sourceRoot, "dist/src/main.js"), "#!/usr/bin/env node\nconsole.log('changed');\n");
    const codeChanged = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });
    await writeFile(join(sourceRoot, "package.json"), '{"name":"remote-runner","version":"0.2.0","type":"module"}\n');
    const versionChanged = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });

    expect(codeChanged.appIdentity).not.toBe(original.appIdentity);
    expect(versionChanged.appIdentity).not.toBe(codeChanged.appIdentity);
    expect(versionChanged.version).toBe("0.2.0");
  });

  it("refuses to overwrite a foreign stable executable", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-foreign-"));
    roots.push(home);
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(home, ".local/bin/remote-runner"), "foreign\n");

    await expect(
      installLocalApplication({
        home,
        sourceRoot,
        nodePath: "/usr/bin/node",
        launch: new FakeLaunch(),
      }),
    ).rejects.toThrow(/foreign/u);
  });

  it("finishes every artifact write before reporting a failure", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-inflight-"));
    roots.push(home);
    const launch = new FakeLaunch();
    /* Rejects on the first microtask, so the plist write — three filesystem round trips behind — is
       still in flight: the rejection is the moment an escaped write would slip past the caller. */
    launch.statusFailure = "launchd is unreachable";

    await expect(installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch })).rejects.toThrow(
      /unreachable/u,
    );
    expect(await readdir(join(home, "Library", "LaunchAgents"))).toEqual(["com.lipchey.remote-runner.plist"]);
  });

  it("retries bootstrap after an upgrade bootout while launchd settles", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-upgrade-"));
    roots.push(home);
    const launch = new FakeLaunch();
    launch.loaded = true;
    launch.running = true;
    launch.bootstrapFailures = 1;

    await expect(
      installLocalApplication({
        home,
        sourceRoot,
        nodePath: "/usr/bin/node",
        launch,
        settleLaunchd: async () => undefined,
      }),
    ).resolves.toBeDefined();
    expect(launch.actions).toEqual(["bootout", "bootstrap", "bootstrap"]);
  });

  it("bootstraps the upgraded agent only after launchd releases the label", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-settle-"));
    roots.push(home);
    const launch = new FakeLaunch();
    launch.loaded = true;
    launch.running = true;
    /* More polls than the 20 blind bootstrap attempts this window used to be spent on, which is why
       an upgrade reported `LaunchAgent bootstrap failed` with both artifacts already swapped. */
    launch.settlePollsAfterBootout = 25;

    await expect(
      installLocalApplication({
        home,
        sourceRoot,
        nodePath: "/usr/bin/node",
        launch,
        settleLaunchd: async () => undefined,
      }),
    ).resolves.toBeDefined();
    expect(launch.actions).toEqual(["bootout", "bootstrap"]);
  });

  it("bootstraps when launchd releases the label on the very last settle", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-boundary-"));
    roots.push(home);
    const launch = new FakeLaunch();
    launch.loaded = true;
    launch.running = true;
    /* The exact boundary: the label is still there on the last polled status, so only a look AFTER
       the final settle can tell a finished teardown from a stuck agent. */
    launch.settlePollsAfterBootout = SETTLE_POLLS;

    await expect(
      installLocalApplication({
        home,
        sourceRoot,
        nodePath: "/usr/bin/node",
        launch,
        settleLaunchd: async () => undefined,
      }),
    ).resolves.toBeDefined();
    expect(launch.actions).toEqual(["bootout", "bootstrap"]);
  });

  it("names the stuck agent when launchd never releases the label", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-stuck-"));
    roots.push(home);
    const launch = new FakeLaunch();
    launch.loaded = true;
    launch.running = true;
    launch.settlePollsAfterBootout = Number.MAX_SAFE_INTEGER;

    await expect(
      installLocalApplication({
        home,
        sourceRoot,
        nodePath: "/usr/bin/node",
        launch,
        settleLaunchd: async () => undefined,
      }),
    ).rejects.toThrow(/still loaded after bootout/u);
    expect(launch.actions).toEqual(["bootout"]);
  });
});
