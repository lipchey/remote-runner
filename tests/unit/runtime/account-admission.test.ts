import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCOUNT_ADMISSION_WAIT_MS,
  ACCOUNT_BUSY_MARKER,
  buildAccountAdmissionShell,
} from "../../../src/runtime/account-admission.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function account(cap?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "account-admission-"));
  roots.push(home);
  if (cap !== undefined) {
    await mkdir(join(home, ".config/remote-runner"), { recursive: true });
    await writeFile(join(home, ".config/remote-runner/concurrency"), cap);
  }
  return home;
}

function launch(home: string, command: readonly string[], waitMs = 1500, cwd = home) {
  const script = `${buildAccountAdmissionShell({ waitMs, pollMs: 20 })}\nexec "$@"`;
  const child = spawn("sh", ["-ceu", script, "account-admission-test", ...command], {
    cwd,
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end();
  const closed = once(child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stdout,
    stderr,
  }));
  return { child, closed, output: () => stdout };
}

const heldWorkload = [process.execPath, "-e", "process.stdout.write('holding\\n'); setInterval(() => {}, 1000)"];

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("account-admission observation timed out");
    await delay(10);
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("account admission shell", () => {
  it("builds valid POSIX shell with a finite production wait budget", () => {
    expect(ACCOUNT_ADMISSION_WAIT_MS).toBe(300_000);
    expect(spawnSync("sh", ["-n", "-c", buildAccountAdmissionShell()]).status).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unusable wait budget %s", (waitMs) => {
    expect(() => buildAccountAdmissionShell({ waitMs })).toThrow("positive safe integer");
  });

  it.each([undefined, "", "0", "-1", "two", "1\n2", "1; exit 42", "999999999999999999999999999"])(
    "leaves absent or malformed cap %s uncapped without creating slots",
    async (cap) => {
      const home = await account(cap);
      const run = launch(home, [process.execPath, "-e", "process.stdout.write('ran')"]);
      expect(await run.closed).toMatchObject({ code: 0, stdout: "ran", stderr: "" });
      await expect(readFile(join(home, ".local/state/remote-runner/slots/1"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe.skipIf(process.platform !== "linux")("real Linux account slot locks", () => {
  it("holds two slots across exec and blocks the third across independent workspaces until a kill", async () => {
    const home = await account("2\n");
    const firstDirectory = join(home, "first-profile/worktree");
    const secondDirectory = join(home, "other-profile/worktree");
    await mkdir(firstDirectory, { recursive: true });
    await mkdir(secondDirectory, { recursive: true });
    const first = launch(home, heldWorkload, 1500, firstDirectory);
    const second = launch(home, heldWorkload, 1500, secondDirectory);
    await until(() => first.output().includes("holding") && second.output().includes("holding"));
    const queued = launch(home, [process.execPath, "-e", "process.stdout.write('admitted')"]);
    await delay(100);
    expect(queued.output()).toBe("");
    first.child.kill("SIGKILL");
    expect(await first.closed).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(await queued.closed).toMatchObject({ code: 0, stdout: "admitted" });
    expect(second.child.exitCode).toBeNull();
    expect(await readFile(join(home, ".local/state/remote-runner/slots/1"), "utf8")).toBe("");
  });

  it("identifies deadline exhaustion separately from a workload's own exit 75", async () => {
    const home = await account("1");
    const holder = launch(home, heldWorkload);
    await until(() => holder.output().includes("holding"));
    const waiting = launch(home, [process.execPath, "-e", "process.stdout.write('unexpected')"], 150);
    expect(await waiting.closed).toMatchObject({ code: 75, stdout: "", stderr: ACCOUNT_BUSY_MARKER });
    holder.child.kill("SIGTERM");
    await holder.closed;
    const workload = launch(home, [process.execPath, "-e", "process.exit(75)"]);
    expect(await workload.closed).toMatchObject({ code: 75, stderr: "" });
  });

  it("releases a slot on normal exit and keeps another account independent", async () => {
    const home = await account("1");
    const other = await account("1");
    const first = launch(home, heldWorkload);
    await until(() => first.output().includes("holding"));
    expect(await launch(other, [process.execPath, "-e", "process.exit(0)"]).closed).toMatchObject({ code: 0 });
    expect(await launch(other, [process.execPath, "-e", "process.exit(0)"]).closed).toMatchObject({ code: 0 });
  });

  it("does not admit a waiter resumed after its deadline even when a slot became free", async () => {
    const home = await account("1");
    const holder = launch(home, heldWorkload);
    await until(() => holder.output().includes("holding"));
    const waiting = launch(home, [process.execPath, "-e", "process.stdout.write('unexpected')"], 500);
    await until(async () => {
      const pids = await readFile(`/proc/${waiting.child.pid}/task/${waiting.child.pid}/children`, "utf8");
      const names = await Promise.all(
        pids
          .trim()
          .split(/\s+/u)
          .map((pid) => readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")),
      );
      return names.some((name) => name.trim() === "sleep");
    });
    waiting.child.kill("SIGSTOP");
    await delay(550);
    holder.child.kill("SIGTERM");
    await holder.closed;
    waiting.child.kill("SIGCONT");
    expect(await waiting.closed).toMatchObject({ code: 75, stdout: "", stderr: ACCOUNT_BUSY_MARKER });
  });

  it("does not admit an orphaned waiter when its parent exits", async () => {
    const home = await account("1");
    const holder = launch(home, heldWorkload);
    await until(() => holder.output().includes("holding"));
    const admitted = join(home, "orphan-admitted");
    const pidFile = join(home, "waiter.pid");
    const script = `printf '%s' "$$" > "$1"; shift; ${buildAccountAdmissionShell({ waitMs: 1500, pollMs: 20 })}\nexec "$@"`;
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require('node:child_process');
      const child = spawn('sh', JSON.parse(process.argv[1]), { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => process.exit(0), 200);
    `,
        JSON.stringify([
          "-ceu",
          script,
          "orphan-test",
          pidFile,
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'bad')",
          admitted,
        ]),
      ],
      {
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(parent);
    const parentExit = once(parent, "close");
    await until(async () => /^\d+$/.test(await readFile(pidFile, "utf8").catch(() => "")));
    const pid = Number(await readFile(pidFile, "utf8"));
    try {
      await parentExit;
      await delay(100);
      holder.child.kill("SIGTERM");
      await holder.closed;
      await delay(200);
      await expect(readFile(admitted)).rejects.toMatchObject({ code: "ENOENT" });
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
      expect(status === "" || /^State:\s+Z/m.test(status)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already exited, including a reaped orphan. */
      }
    }
  });
});
