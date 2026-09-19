import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DependencyCommandError } from "../../../src/bootstrap/dependencies.js";
import { ensureLocalDependencies } from "../../../src/bootstrap/local-dependencies.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "remote-runner-local-setup-")));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@11.9.0" }));
  await writeFile(
    join(workspaceRoot, "setup.mjs"),
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
appendFileSync('calls', 'setup\\n');
if (existsSync('fail-setup')) process.exit(7);
writeFileSync('artifact', 'ready');
writeFileSync('observed.json', JSON.stringify({
  node: process.versions.node,
  cwd: process.cwd(),
  provider: process.env.REMOTE_RUNNER_PROVIDER,
  child: process.env.REMOTE_RUNNER_CHILD,
  browsers: process.env.PLAYWRIGHT_BROWSERS_PATH,
  ambient: process.env.LOCAL_SETUP_CANARY,
}));
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(workspaceRoot, "ensure.mjs"),
    `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync('calls', 'ensure\\n');
if (!existsSync('artifact') || existsSync('fail-ensure')) process.exit(9);
`,
  );
  const statePath = join(root, "state", "local-setup.json");
  const options = {
    workspaceRoot,
    statePath,
    bootstrap: {
      packageManager: "package.json",
      setup: ["./setup.mjs"],
      artifacts: ["artifact"],
      ensure: [["node", "ensure.mjs"]],
    },
    fingerprintFiles: ["package.json", "setup.mjs", "ensure.mjs"],
    gitlinks: [],
  };
  return { ...options, options, readCalls: () => readFile(join(workspaceRoot, "calls"), "utf8") };
}

describe("local dependency preparation", () => {
  it("caches successful setup, checks every run, and repairs a missing artifact", async () => {
    const local = await fixture();

    expect((await ensureLocalDependencies(local.options)).setupRan).toBe(true);
    expect(await local.readCalls()).toBe("setup\nensure\n");
    expect((await ensureLocalDependencies(local.options)).setupRan).toBe(false);
    expect(await local.readCalls()).toBe("setup\nensure\nensure\n");

    await rm(join(local.workspaceRoot, "artifact"));
    expect((await ensureLocalDependencies(local.options)).setupRan).toBe(true);
    expect(await local.readCalls()).toBe("setup\nensure\nensure\nsetup\nensure\n");
    expect((await stat(local.statePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(local.statePath, ".."))).toEqual(["local-setup.json"]);
    expect(existsSync(join(local.workspaceRoot, "local-setup.json"))).toBe(false);
  });

  it("uses the local environment and fingerprints its Node platform without a remote uv", async () => {
    const local = await fixture();
    const browsers = join(local.workspaceRoot, "local-browser-cache");
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", browsers);
    vi.stubEnv("LOCAL_SETUP_CANARY", "ambient");
    vi.stubEnv("REMOTE_RUNNER_PROVIDER", "remote");
    const result = await ensureLocalDependencies(local.options);

    expect(JSON.parse(await readFile(join(local.workspaceRoot, "observed.json"), "utf8"))).toEqual({
      node: process.versions.node,
      cwd: local.workspaceRoot,
      provider: "local",
      child: "1",
      browsers,
      ambient: "ambient",
    });
    expect(result.environment).toEqual({
      node: `${process.versions.node}-${process.platform}-${process.arch}`,
      packageManager: "pnpm@11.9.0",
    });
    expect(JSON.stringify(result)).not.toContain("/home/admin");
  });

  it("invalidates the healthy state when files or submodule revisions change", async () => {
    const local = await fixture();
    const initial = await ensureLocalDependencies(local.options);
    await writeFile(join(local.workspaceRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@11.9.1" }));
    const changed = await ensureLocalDependencies(local.options);
    expect(changed.setupRan).toBe(true);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    const gitlink = await ensureLocalDependencies({
      ...local.options,
      gitlinks: [{ path: "vendor/tool", oid: "a".repeat(40) }],
    });
    expect(gitlink.setupRan).toBe(true);
    expect(gitlink.fingerprint).not.toBe(changed.fingerprint);
  });

  it.each(["fail-setup", "fail-ensure"])("does not save healthy state after %s", async (failure) => {
    const local = await fixture();
    await writeFile(join(local.workspaceRoot, failure), "");

    await expect(ensureLocalDependencies(local.options)).rejects.toBeInstanceOf(DependencyCommandError);
    expect(existsSync(local.statePath)).toBe(false);
    expect(await local.readCalls()).toBe(failure === "fail-setup" ? "setup\n" : "setup\nensure\n");
  });

  it("repairs a malformed cached environment without treating it as healthy", async () => {
    const local = await fixture();
    const initial = await ensureLocalDependencies(local.options);
    await writeFile(local.statePath, JSON.stringify({ fingerprint: initial.fingerprint, environment: null }));

    expect((await ensureLocalDependencies(local.options)).setupRan).toBe(true);
    expect(await local.readCalls()).toBe("setup\nensure\nsetup\nensure\n");
  });

  it("preserves spawn failure attribution and rejects truncated command output", async () => {
    const local = await fixture();
    const missing = ensureLocalDependencies({
      ...local.options,
      bootstrap: { ...local.bootstrap, setup: ["./missing.mjs"] },
    });
    await expect(missing).rejects.not.toBeInstanceOf(DependencyCommandError);
    expect(existsSync(local.statePath)).toBe(false);

    await expect(
      ensureLocalDependencies({
        ...local.options,
        processes: {
          run: async () => ({
            exitCode: 0,
            spawned: true,
            outputTruncated: true,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
        },
      }),
    ).rejects.toThrow(/output.*limit/u);
    expect(existsSync(local.statePath)).toBe(false);
  });
});
