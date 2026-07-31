import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runMain } from "../../src/main.js";

describe("executable entrypoint", () => {
  it("routes ordinary argv through the injected CLI dependencies", async () => {
    const stdout: string[] = [];
    const code = await runMain(["validate"], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    }, { readFile: async () => "schemaVersion: 1\nprofiles: []\n" });

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
  });

  it("publishes the executable bin from main rather than the inert CLI module", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.bin["remote-runner"]).toBe("./dist/main.js");
    const source = await readFile(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
