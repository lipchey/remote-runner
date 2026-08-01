import process from "node:process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "process.stderr.write('before\\nRR_CHILD_STARTED\\nafter\\n');",
          "process.stdout.write('visible');",
        ].join(""),
      ],
      stdin: input,
      marker: new TextEncoder().encode("RR_CHILD_STARTED\n"),
      onMarker: async () => {
        markers += 1;
      },
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

  it("releases marker-handshake stdin only after the marker callback completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-marker-"));
    const receipt = join(root, "cleanup-complete");
    const release = new TextEncoder().encode("release\n");
    try {
      const result = await runStreamingProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs=require('node:fs');let value='';",
            "process.stderr.write('RETENTION_LOCKED\\n');",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data',chunk=>value+=chunk);",
            `process.stdin.on('end',()=>process.exit(value==='release\\n'&&fs.existsSync(${JSON.stringify(receipt)})?0:9));`,
          ].join(""),
        ],
        marker: new TextEncoder().encode("RETENTION_LOCKED\n"),
        releaseAfterMarker: release,
        onMarker: async () => {
          await writeFile(receipt, "ok");
        },
        stdout: () => undefined,
        stderr: () => undefined,
      });

      expect(result).toEqual({ exitCode: 0, signal: null, markerSeen: true, spawned: true });
      expect(release.every((byte) => byte === 0)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a marker callback failure without emitting an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const observe = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observe);
    try {
      await expect(
        runStreamingProcess({
          command: process.execPath,
          args: ["-e", "process.stderr.write('RETENTION_LOCKED\\n');process.stdin.resume();"],
          marker: new TextEncoder().encode("RETENTION_LOCKED\n"),
          releaseAfterMarker: new TextEncoder().encode("release\n"),
          onMarker: async () => {
            throw new Error("retention callback failed");
          },
          stdout: () => undefined,
          stderr: () => undefined,
        }),
      ).rejects.toThrow("retention callback failed");
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observe);
    }
  });
});
