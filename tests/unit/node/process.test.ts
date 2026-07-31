import process from "node:process";

import { describe, expect, it } from "vitest";

import { NodeProcessRuntime, runStreamingProcess } from "../../../src/node/process.js";

describe("NodeProcessRuntime", () => {
  it("passes an argv array without shell expansion", async () => {
    const runtime = new NodeProcessRuntime();
    const result = await runtime.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "$(printf secret-canary)"],
      maxOutputBytes: 1_024,
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("$(printf secret-canary)");
    expect(result.outputTruncated).toBe(false);
  });

  it("bounds captured output and marks a killed overflow", async () => {
    const runtime = new NodeProcessRuntime();
    const result = await runtime.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      maxOutputBytes: 128,
    });

    expect(result.stdout.byteLength).toBeLessThanOrEqual(128);
    expect(result.outputTruncated).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("runStreamingProcess", () => {
  it("filters the child marker, invokes it once, streams output, and wipes stdin", async () => {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const input = new TextEncoder().encode("secret-canary");
    let markers = 0;

    const result = await runStreamingProcess({
      command: process.execPath,
      args: ["-e", [
        "process.stdin.resume();",
        "process.stderr.write('before\\nRR_CHILD_STARTED\\nafter\\n');",
        "process.stdout.write('visible');",
      ].join("")],
      stdin: input,
      marker: new TextEncoder().encode("RR_CHILD_STARTED\n"),
      onMarker: async () => { markers += 1; },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(result).toEqual({ exitCode: 0, signal: null, markerSeen: true, spawned: true });
    expect(markers).toBe(1);
    expect(Buffer.concat(stdout.map(Buffer.from))).toEqual(Buffer.from("visible"));
    expect(Buffer.concat(stderr.map(Buffer.from)).toString()).toBe("before\nafter\n");
    expect(input.every((byte) => byte === 0)).toBe(true);
  });

  it("reports a missing executable as not spawned without throwing raw diagnostics", async () => {
    const result = await runStreamingProcess({
      command: "/definitely/missing/remote-runner-test",
      args: [],
      marker: new TextEncoder().encode("RR_CHILD_STARTED\n"),
      onMarker: async () => undefined,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(result).toEqual({ exitCode: 127, signal: null, markerSeen: false, spawned: false });
  });
});
