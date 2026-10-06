import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SECRET_FRAME_MAGIC, encodeSecretFrame } from "../../../src/secrets/frame.js";

const launcher = fileURLToPath(new URL("../../../assets/remote-launcher.mjs", import.meta.url));
const concat = (parts: readonly Uint8Array[]) => Buffer.concat(parts.map((part) => Buffer.from(part)));

const readPid = (path: string) => {
  const pid = existsSync(path) ? Number.parseInt(readFileSync(path, "utf8").trim(), 10) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
};

/* EPERM means the pid exists under another uid; only ESRCH proves it is gone. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runLauncher(
  frame: Uint8Array,
  allow = ["SECRET"],
  command = [
    process.execPath,
    "-e",
    "process.stdout.write(process.env.SECRET === 'secret-canary' ? 'present' : 'missing')",
  ],
  environment: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, [launcher, JSON.stringify(allow), "--", ...command], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", ...environment },
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

  it("keeps runner markers authoritative over allowlisted secrets", async () => {
    const name = "REMOTE_RUNNER_SELECTED_PROFILE";
    const result = await runLauncher(
      encodeSecretFrame({ [name]: "from-secret" }, [name]).stdin,
      [name],
      [process.execPath, "-e", `process.stdout.write(String(process.env.${name}))`],
      { [name]: "verify-full" },
    );

    expect(result).toMatchObject({ code: 0, stdout: "verify-full", marker: "RR_CHILD_STARTED\n" });
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
    expect(result.code).toBe(69);
    expect(result.marker).toBe("");
    expect(result.stderr).not.toContain("secret-canary");
  });

  it.each([
    ["exits normally", "process.exit(0)", 0, null],
    ["exits unsuccessfully", "process.exit(23)", 23, null],
    ["dies by signal", "process.kill(process.pid, 'SIGTERM')", null, "SIGTERM"],
  ])("kills the workload's background child when it %s", async (_label, exit, code, signal) => {
    const directory = await mkdtemp(join(tmpdir(), "remote-launcher-background-"));
    const started = join(directory, "background.pid");
    let backgroundPid: number | undefined;
    try {
      const result = await runLauncher(
        encodeSecretFrame({}, []).stdin,
        [],
        [
          process.execPath,
          "-e",
          `const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
         child.once("spawn", () => {
           require("node:fs").writeFileSync(process.argv[1], String(child.pid));
           ${exit};
         });`,
          started,
        ],
      );
      backgroundPid = readPid(started);
      expect(backgroundPid).toBeGreaterThan(0);
      expect(result).toMatchObject({ code, signal, marker: "RR_CHILD_STARTED\n" });
      await waitUntil(() => !alive(backgroundPid!), "the background child to be killed", 2000);
      expect(() => process.kill(backgroundPid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      if (backgroundPid && alive(backgroundPid)) process.kill(backgroundPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["workload", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)"],
    [
      "background child",
      `const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
       child.once("spawn", () => require("node:fs").writeFileSync(process.argv[1], String(child.pid)));
       setTimeout(() => {}, 60000);`,
    ],
  ])(
    "kills the %s once its own parent is gone",
    async (_label, script) => {
      const directory = await mkdtemp(join(tmpdir(), "remote-launcher-orphan-"));
      const started = join(directory, "workload.pid");
      const workload = [process.execPath, "-e", script, started];
      /* Wait for workload startup before orphaning so failed launcher startup cannot pass. */
      const parent = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
         const { existsSync, openSync } = require("node:fs");
         /* "ignore" opens /dev/null only for fds 0-2; the marker fd must be a real descriptor. */
         const child = spawn(process.execPath, JSON.parse(process.argv[1]), {
           detached: true,
           stdio: ["pipe", "ignore", "ignore", openSync("/dev/null", "w")],
         });
         child.stdin.end(Buffer.from(process.argv[2], "base64"));
         child.unref();
         const wait = setInterval(() => {
           if (!existsSync(process.argv[3])) return;
           clearInterval(wait);
           process.exit(0);
         }, 25);
         /* Bound startup so a failed launcher cannot leave this parent running. */
         setTimeout(() => process.exit(1), 10000);`,
          JSON.stringify([launcher, "[]", "--", ...workload]),
          Buffer.from(encodeSecretFrame({}, []).stdin).toString("base64"),
          started,
        ],
        { stdio: "ignore" },
      );
      /* Subscribe before observing the pid file because the parent can exit immediately. */
      const orphaned = once(parent, "exit");
      let workloadPid: number | undefined;
      try {
        /* Wait for a positive pid because the file appears before its contents and pid 0 targets our group. */
        await waitUntil(() => readPid(started) > 0, "the workload to start");
        workloadPid = readPid(started);
        expect(alive(workloadPid)).toBe(true);
        await orphaned;
        await waitUntil(() => !alive(workloadPid!), "the orphaned workload to be killed");
        expect(() => process.kill(workloadPid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      } finally {
        if (workloadPid !== undefined && alive(workloadPid)) process.kill(workloadPid, "SIGKILL");
        parent.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("keeps the outage code for a spawn failure that does not prove the command unusable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-launcher-loop-"));
    try {
      await symlink(join(directory, "b"), join(directory, "a"));
      await symlink(join(directory, "a"), join(directory, "b"));
      const result = await runLauncher(encodeSecretFrame({}, []).stdin, [], [join(directory, "a")]);
      expect(result).toMatchObject({ code: 70, marker: "" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
