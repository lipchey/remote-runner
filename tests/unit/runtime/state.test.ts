import { open, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readVersionedState,
  type StateFileSystem,
  writeVersionedState,
} from "../../../src/runtime/state.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class NodeStateFiles implements StateFileSystem {
  readonly events: string[] = [];
  failCode = "EIO";
  failEvent?: string;

  private record(event: string): void {
    this.events.push(event);
    if (event === this.failEvent) {
      throw Object.assign(new Error("injected state failure"), { code: this.failCode });
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async writeFile(path: string, contents: Uint8Array, mode: number): Promise<void> {
    this.record(`write:${path}`);
    await writeFile(path, contents, { mode, flag: "wx" });
  }

  async sync(path: string): Promise<void> {
    this.record(`sync:${path}`);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.record(`rename:${from}->${to}`);
    await rename(from, to);
  }

  async remove(path: string): Promise<void> {
    this.record(`remove:${path}`);
    await rm(path);
  }
}

interface ExampleState {
  readonly ready: boolean;
}

const isExampleState = (value: unknown): value is ExampleState =>
  typeof value === "object" && value !== null && (value as { ready?: unknown }).ready === true;

describe("versioned state", () => {
  it("writes a 0600 versioned envelope by syncing a unique sibling before atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const files = new NodeStateFiles();
    await writeFile(path, JSON.stringify({ schemaVersion: 3, data: { ready: false } }), {
      mode: 0o600,
    });

    await writeVersionedState(files, path, 3, { ready: true }, () => "unique-token");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 3, data: { ready: true } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(files.events).toEqual([
      `write:${path}.tmp-unique-token`,
      `sync:${path}.tmp-unique-token`,
      `rename:${path}.tmp-unique-token->${path}`,
      `sync:${root}`,
    ]);
    await expect(readVersionedState(files, path, 3, isExampleState)).resolves.toEqual({ ready: true });
  });

  it.each(["write", "sync", "rename"])("removes the unique temp after a %s failure", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-failure-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const temporaryPath = `${path}.tmp-failure-token`;
    const files = new NodeStateFiles();
    files.failEvent =
      failure === "write"
        ? `write:${temporaryPath}`
        : failure === "sync"
          ? `sync:${temporaryPath}`
          : `rename:${temporaryPath}->${path}`;

    await expect(
      writeVersionedState(files, path, 1, { ready: true }, () => "failure-token"),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await readdir(root)).toEqual([]);
    expect(files.events.at(-1)).toBe(`remove:${temporaryPath}`);
  });

  it("removes its created temp when atomic rename reports EEXIST", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-rename-collision-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const temporaryPath = `${path}.tmp-rename-collision`;
    const files = new NodeStateFiles();
    files.failCode = "EEXIST";
    files.failEvent = `rename:${temporaryPath}->${path}`;

    await expect(
      writeVersionedState(files, path, 1, { ready: true }, () => "rename-collision"),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readdir(root)).toEqual([]);
    expect(files.events.at(-1)).toBe(`remove:${temporaryPath}`);
  });

  it("preserves a colliding temp that this operation did not create", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-create-collision-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const temporaryPath = `${path}.tmp-create-collision`;
    const files = new NodeStateFiles();
    await writeFile(temporaryPath, "pre-existing", { mode: 0o600 });

    await expect(
      writeVersionedState(files, path, 1, { ready: true }, () => "create-collision"),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(temporaryPath, "utf8")).toBe("pre-existing");
    expect(files.events.some((event) => event === `remove:${temporaryPath}`)).toBe(false);
  });

  it("retains corrupt state under a diagnostic name instead of overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-corrupt-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const files = new NodeStateFiles();
    await writeFile(path, "{broken", { mode: 0o600 });

    await expect(readVersionedState(files, path, 1, isExampleState, () => "diagnostic")).rejects.toThrow(
      "corrupt state retained",
    );

    expect(await readdir(root)).toEqual(["state.json.corrupt-diagnostic"]);
    expect(await readFile(join(root, "state.json.corrupt-diagnostic"), "utf8")).toBe("{broken");
  });

  it("rejects unsupported versions and invalid data shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-state-invalid-"));
    temporaryRoots.push(root);
    const path = join(root, "state.json");
    const files = new NodeStateFiles();
    await writeFile(path, JSON.stringify({ schemaVersion: 2, data: { ready: false } }), { mode: 0o600 });

    await expect(readVersionedState(files, path, 1, isExampleState, () => "invalid")).rejects.toThrow(
      "corrupt state retained",
    );
    expect(await readdir(root)).toEqual(["state.json.corrupt-invalid"]);
  });
});
