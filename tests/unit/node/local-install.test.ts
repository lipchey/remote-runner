import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installLocalApplication,
  type LocalLaunchRuntime,
} from "../../../src/node/local-install.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeLaunch implements LocalLaunchRuntime {
  readonly actions: string[] = [];
  loaded = false;
  running = false;
  async status() { return { loaded: this.loaded, running: this.running }; }
  async bootout() { this.actions.push("bootout"); this.loaded = false; this.running = false; }
  async bootstrap(_plist: string) { this.actions.push("bootstrap"); this.loaded = true; this.running = true; }
  async kickstart() { this.actions.push("kickstart"); this.running = true; }
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
  await writeFile(join(sourceRoot, "node_modules/yaml/package.json"), '{"name":"yaml","type":"module"}\n');
  await writeFile(join(sourceRoot, "node_modules/yaml/index.js"), "export const parse = () => ({});\n");
  return sourceRoot;
}

describe("self-contained local macOS install", () => {
  it("installs an immutable app, stable executable, and LaunchAgent idempotently", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-home-"));
    roots.push(home);
    const launch = new FakeLaunch();

    const first = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });
    const second = await installLocalApplication({ home, sourceRoot, nodePath: "/usr/bin/node", launch });

    expect(second.appRoot).toBe(first.appRoot);
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

  it("refuses to overwrite a foreign stable executable", async () => {
    const sourceRoot = await sourceFixture();
    const home = await mkdtemp(join(tmpdir(), "remote-runner-install-foreign-"));
    roots.push(home);
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(home, ".local/bin/remote-runner"), "foreign\n");

    await expect(installLocalApplication({
      home,
      sourceRoot,
      nodePath: "/usr/bin/node",
      launch: new FakeLaunch(),
    })).rejects.toThrow(/foreign/u);
  });
});
