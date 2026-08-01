import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runMain } from "../../src/main.js";
import { launcherAssetCandidates } from "../../src/app/default-dependencies.js";
import type { PrewarmRequest } from "../../src/prewarm/queue.js";
import { validManifest } from "./config/manifest-fixture.js";

describe("executable entrypoint", () => {
  it("routes install before ordinary profile dependencies and reports the stable executable", async () => {
    const stdout: string[] = [];
    let installed = 0;
    const code = await runMain(
      ["install"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
      { readFile: async () => "" },
      {
        async installLocal() {
          installed += 1;
          return { executablePath: "/Users/admin/.local/bin/remote-runner" };
        },
      },
    );

    expect(code).toBe(0);
    expect(installed).toBe(1);
    expect(stdout).toEqual(["installed remote-runner: /Users/admin/.local/bin/remote-runner"]);
  });

  it("routes ordinary argv through the injected CLI dependencies", async () => {
    const stdout: string[] = [];
    const code = await runMain(
      ["validate"],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
      { readFile: async () => "schemaVersion: 1\nprofiles: []\n" },
    );

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
  });

  it("routes a controller request through the existing forced-remote run command", async () => {
    const calls: unknown[] = [];
    const request: PrewarmRequest = {
      schemaVersion: 1,
      consumer: "ariadne",
      profile: "verify-full",
      identity: "0123456789abcdef01234567",
      sourceRoot: "/worktrees/ariadne-feature",
      manifestPath: "/worktrees/ariadne-feature/.remote-runner.yaml",
    };
    const code = await runMain(["controller"], { stdout: () => undefined, stderr: () => undefined }, undefined, {
      installLocal: async () => ({ executablePath: "/unused" }),
      createCliDependencies: async (sourceRoot) => {
        calls.push(["dependencies", sourceRoot]);
        return {
          readFile: async (path) => {
            calls.push(["read", path]);
            return validManifest;
          },
          ensureController: async () => {
            calls.push(["controller-health"]);
          },
          runProfile: async (profile, command, mode) => {
            calls.push(["run", profile.id, command, mode]);
            return 23;
          },
        };
      },
      runController: async (runPrewarm) => runPrewarm(request),
    });

    expect(code).toBe(23);
    expect(calls).toEqual([
      ["dependencies", request.sourceRoot],
      ["read", request.manifestPath],
      ["controller-health"],
      ["run", "verify-full", ["./scripts/verify", "--full"], "remote"],
    ]);
  });

  it("publishes the executable bin from main rather than the inert CLI module", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.bin["remote-runner"]).toBe("./dist/src/main.js");
    const source = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("resolves the launcher from both source and compiled package layouts", () => {
    const candidates = launcherAssetCandidates("file:///app/dist/src/app/default-dependencies.js");
    expect(candidates.map((url) => url.pathname)).toEqual([
      "/app/dist/assets/remote-launcher.mjs",
      "/app/assets/remote-launcher.mjs",
    ]);
  });
});
