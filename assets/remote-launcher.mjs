#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";

const MAGIC = Buffer.from("RRSE1\0", "ascii");
const CHILD_MARKER = Buffer.from("RR_CHILD_STARTED\n", "ascii");
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message, code = 64) {
  process.stderr.write(`remote-runner launcher: ${message}\n`);
  process.exitCode = code;
}

function controlArguments() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  if (separator !== 1 || args.length <= 2) throw new Error("invalid control arguments");
  let allow;
  try { allow = JSON.parse(args[0]); } catch { throw new Error("invalid control arguments"); }
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
      if (typeof name !== "string" || typeof value !== "string" || !SECRET_NAME.test(name) ||
          !allowed.has(name) || names.has(name) || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
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
      env: { ...process.env, ...secrets },
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    fail("child spawn failed", 70);
    return;
  }
  secrets = undefined;
  const exit = once(child, "exit").catch(() => [null, null]);
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
    child.once("error", () => resolve("spawn-failed"));
  });
  if (start !== "started") {
    if (start === "marker-failed") await exit;
    fail(start === "marker-failed" ? "child marker failed" : "child spawn failed", 70);
    return;
  }
  const [code, signal] = await exit;
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = Number.isInteger(code) ? code : 70;
}

await launch();
