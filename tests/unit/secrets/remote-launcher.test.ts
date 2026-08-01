import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SECRET_FRAME_MAGIC, encodeSecretFrame } from "../../../src/secrets/frame.js";

const launcher = fileURLToPath(new URL("../../../assets/remote-launcher.mjs", import.meta.url));
const concat = (parts: readonly Uint8Array[]) => Buffer.concat(parts.map((part) => Buffer.from(part)));

async function runLauncher(
  frame: Uint8Array,
  allow = ["SECRET"],
  command = [
    process.execPath,
    "-e",
    "process.stdout.write(process.env.SECRET === 'secret-canary' ? 'present' : 'missing')",
  ],
) {
  const child = spawn(process.execPath, [launcher, JSON.stringify(allow), "--", ...command], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const marker: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdio[3]!.on("data", (chunk: Buffer) => marker.push(chunk));
  child.stdin.end(frame);
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    marker: Buffer.concat(marker).toString("utf8"),
  };
}

describe("fixed remote launcher", () => {
  it("emits the child marker only after a valid frame reaches the fixed child", async () => {
    const result = await runLauncher(encodeSecretFrame({ SECRET: "secret-canary" }, ["SECRET"]).stdin);
    expect(result).toEqual({ code: 0, signal: null, stdout: "present", stderr: "", marker: "RR_CHILD_STARTED\n" });
  });

  it.each([
    ["duplicate", concat([SECRET_FRAME_MAGIC, Buffer.from('[["SECRET","one"],["SECRET","two"]]')])],
    ["unknown", concat([SECRET_FRAME_MAGIC, Buffer.from('[["UNKNOWN","secret-canary"]]')])],
    ["malformed", concat([SECRET_FRAME_MAGIC, Buffer.from("not-json")])],
    ["bad magic", Buffer.from("WRONG\0[]")],
    ["oversized", concat([SECRET_FRAME_MAGIC, Buffer.from(`[["SECRET","${"x".repeat(64 * 1024 + 1)}"]]`)])],
  ])("rejects %s input before child start", async (_label, frame) => {
    const result = await runLauncher(frame);
    expect(result.code).toBe(64);
    expect(result.marker).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("secret-canary");
  });

  it("keeps secret values out of argv and launcher diagnostics", async () => {
    const canary = "secret-canary";
    const command = [
      process.execPath,
      "-e",
      "process.stdout.write(process.argv.includes('secret-canary') ? 'leaked' : 'clean')",
    ];
    const result = await runLauncher(encodeSecretFrame({ SECRET: canary }, ["SECRET"]).stdin, ["SECRET"], command);
    expect(result.stdout).toBe("clean");
    expect(result.stderr).not.toContain(canary);
  });

  it("preserves empty fixed child arguments without shell parsing", async () => {
    const command = [process.execPath, "-e", "process.stdout.write(process.argv[1] === '' ? 'empty' : 'changed')", ""];
    const result = await runLauncher(encodeSecretFrame({}, []).stdin, [], command);
    expect(result).toMatchObject({ code: 0, stdout: "empty", marker: "RR_CHILD_STARTED\n" });
  });

  it("does not claim child start when the executable cannot spawn", async () => {
    const result = await runLauncher(
      encodeSecretFrame({ SECRET: "secret-canary" }, ["SECRET"]).stdin,
      ["SECRET"],
      ["/definitely/missing"],
    );
    expect(result.code).toBe(70);
    expect(result.marker).toBe("");
    expect(result.stderr).not.toContain("secret-canary");
  });
});
