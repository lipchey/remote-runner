import { appendFile, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createJsonlLogger, DEFAULT_LOG_MAX_BYTES, type LogFileSystem } from "../../../src/runtime/log.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class NodeLogFiles implements LogFileSystem {
  async appendFile(path: string, contents: Uint8Array, mode: number): Promise<void> {
    await appendFile(path, contents, { mode });
  }

  async stat(path: string): Promise<{ readonly size: number }> {
    return stat(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async remove(path: string): Promise<void> {
    await rm(path);
  }
}

describe("createJsonlLogger", () => {
  it("recursively redacts registered exact values and URL credentials before serialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-log-"));
    temporaryRoots.push(root);
    const path = join(root, "runner.jsonl");
    const logger = createJsonlLogger(new NodeLogFiles(), path);
    const canary = "exact-secret-canary-93f4";
    logger.registerSecret(canary);

    await logger.write({
      event: "probe",
      nested: { values: [canary, `prefix:${canary}:suffix`] },
      url: "https://alice:password@example.com/private?q=1",
    });

    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("password");
    expect(JSON.parse(serialized)).toEqual({
      event: "probe",
      nested: { values: ["[REDACTED]", "prefix:[REDACTED]:suffix"] },
      url: "https://example.com/private?q=1",
    });
  });

  it("rotates before exceeding the bound and retains current plus three rotated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-log-rotation-"));
    temporaryRoots.push(root);
    const path = join(root, "runner.jsonl");
    const logger = createJsonlLogger(new NodeLogFiles(), path, { maxBytes: 80 });

    for (let index = 0; index < 5; index++) {
      await logger.write({ index, message: "x".repeat(40) });
    }

    expect(DEFAULT_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    for (const suffix of ["", ".1", ".2", ".3"]) {
      await expect(stat(`${path}${suffix}`)).resolves.toBeDefined();
    }
    await expect(stat(`${path}.4`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts accessors and toJSON hooks to inert redacted data without invoking them", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-log-hooks-"));
    temporaryRoots.push(root);
    const path = join(root, "runner.jsonl");
    const logger = createJsonlLogger(new NodeLogFiles(), path);
    const canary = "hook-secret-canary-4f8a";
    logger.registerSecret(canary);
    let hookCalls = 0;
    const record = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(record, {
      accessor: {
        enumerable: true,
        get: () => {
          hookCalls++;
          return canary;
        },
      },
      toJSON: {
        enumerable: true,
        value: () => {
          hookCalls++;
          return { leaked: canary };
        },
      },
      url: {
        enumerable: true,
        value: "https://ali%63e:p%40ss@example.com/private",
      },
    });

    await logger.write(record);

    const serialized = await readFile(path, "utf8");
    expect(hookCalls).toBe(0);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("ali%63e");
    expect(serialized).not.toContain("p%40ss");
    expect(JSON.parse(serialized)).toEqual({
      accessor: "[ACCESSOR]",
      toJSON: "[FUNCTION]",
      url: "https://example.com/private",
    });
  });
});
