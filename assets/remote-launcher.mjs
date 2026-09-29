#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";

const MAGIC = Buffer.from("RRSE1\0", "ascii");
const CHILD_MARKER = Buffer.from("RR_CHILD_STARTED\n", "ascii");
/* The workload command itself is not executable: a caller error, not a remote outage. The runner
   matches this code before the marker, so it must stay distinct from the shell's own 126/127,
   which a broken remote shell (missing flock or node) emits for the same ssh invocation. */
const WORKLOAD_SPAWN_EXIT_CODE = 69;
/* Only errors that prove the command itself is unusable may claim the caller's error. Everything
   else a spawn can fail with — EAGAIN, EMFILE, ENOMEM under remote load — is a genuine remote
   failure that must keep its outage code so the runner still notifies and falls back. */
const WORKLOAD_SPAWN_ERRORS = new Set(["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "ENOEXEC", "ENAMETOOLONG"]);
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;
const RUNNER_MARKERS = ["REMOTE_RUNNER_SELECTED_PROFILE", "REMOTE_RUNNER_REMOTE_LABEL"];
const decoder = new TextDecoder("utf-8", { fatal: true });

function runnerMarkers() {
  return Object.fromEntries(
    RUNNER_MARKERS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
  );
}

function fail(message, code = 64) {
  process.stderr.write(`remote-runner launcher: ${message}\n`);
  process.exitCode = code;
}

function spawnExitCode(error) {
  return WORKLOAD_SPAWN_ERRORS.has(error?.code) ? WORKLOAD_SPAWN_EXIT_CODE : 70;
}

/* sshd is this launcher's direct parent and exits the moment the client goes away (a killed
   local run, a laptop asleep past the ssh keepalives, a dropped link), leaving the launcher
   orphaned. The workload never notices: it runs to the end against a channel nobody reads,
   and every native tool that writes to the now-broken stdout is killed by SIGPIPE — so an
   abandoned run burns the host for its full length and then reports itself RED (observed: a
   gitleaks gate dying mid-write, 6 of 408 remote verify runs) instead of simply being gone.
   `process.ppid` follows reparenting (verified on darwin and linux node 26: it reads 1 once the
   parent exits), so watching the RELATIONSHIP is both live and exact — probing whether the
   recorded pid is still occupied would instead be fooled by pid reuse, and would say nothing
   about whose child we are. Recorded at module load: a disconnect during the frame read would
   otherwise be recorded as the orphaning that already happened, and never fire.
   Ceiling: this reaches the direct child only — a grandchild already spawned into its own
   process group (the verify runner puts every check in one) runs to its own end, but nothing
   further starts. */
const LAUNCH_PARENT = process.ppid;
const ORPHAN_POLL_MS = 1000;

function killWhenOrphaned(child) {
  const timer = setInterval(() => {
    if (process.ppid === LAUNCH_PARENT) return;
    clearInterval(timer);
    child.kill("SIGKILL");
  }, ORPHAN_POLL_MS);
  /* Never let the watch itself hold the launcher open past the workload's own exit. */
  timer.unref();
}

function controlArguments() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator !== 1 || args.length <= 2) throw new Error("invalid control arguments");
  let allow;
  try {
    allow = JSON.parse(args[0]);
  } catch {
    throw new Error("invalid control arguments");
  }
  if (!Array.isArray(allow)) throw new Error("invalid control arguments");
  const allowed = new Set();
  for (const name of allow) {
    if (typeof name !== "string" || !SECRET_NAME.test(name) || allowed.has(name)) {
      throw new Error("invalid control arguments");
    }
    allowed.add(name);
  }
  const command = args.slice(separator + 1);
  if (command.length === 0 || command[0].length === 0 || command.some((part) => part.includes("\0"))) {
    throw new Error("invalid control arguments");
  }
  return { allowed, command };
}

async function readFrame() {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_FRAME_BYTES) {
        bytes.fill(0);
        throw new Error("invalid secret frame");
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function decodeFrame(frame, allowed) {
  try {
    if (frame.byteLength < MAGIC.byteLength || !frame.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("invalid secret frame");
    }
    const text = decoder.decode(frame.subarray(MAGIC.byteLength));
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error("invalid secret frame");
    const names = new Set();
    const secrets = {};
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid secret frame");
      const [name, value] = entry;
      if (
        typeof name !== "string" ||
        typeof value !== "string" ||
        !SECRET_NAME.test(name) ||
        !allowed.has(name) ||
        names.has(name) ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES
      ) {
        throw new Error("invalid secret frame");
      }
      names.add(name);
      secrets[name] = value;
    }
    return secrets;
  } finally {
    frame.fill(0);
  }
}

async function launch() {
  let control;
  let frame;
  let secrets;
  try {
    control = controlArguments();
    frame = await readFrame();
    secrets = decodeFrame(frame, control.allowed);
    process.stdin.destroy();
  } catch {
    if (frame) frame.fill(0);
    process.stdin.destroy();
    fail("invalid input");
    return;
  }

  let child;
  try {
    child = spawn(control.command[0], control.command.slice(1), {
      env: { ...process.env, ...secrets, ...runnerMarkers() },
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (error) {
    fail("child spawn failed", spawnExitCode(error));
    return;
  }
  secrets = undefined;
  const exit = once(child, "exit").catch(() => [null, null]);
  let spawnError;
  const start = await new Promise((resolve) => {
    child.once("spawn", () => {
      try {
        writeSync(3, CHILD_MARKER);
        resolve("started");
      } catch {
        child.kill("SIGTERM");
        resolve("marker-failed");
      }
    });
    child.once("error", (error) => {
      spawnError = error;
      resolve("spawn-failed");
    });
  });
  if (start !== "started") {
    if (start === "marker-failed") await exit;
    fail(
      start === "marker-failed" ? "child marker failed" : "child spawn failed",
      start === "marker-failed" ? 70 : spawnExitCode(spawnError),
    );
    return;
  }
  killWhenOrphaned(child);
  const [code, signal] = await exit;
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 70;
}

await launch();
