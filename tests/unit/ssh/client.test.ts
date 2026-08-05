import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enrollKnownHost,
  NodeKnownHostsStore,
  runSsh,
  sshArguments,
  type KnownHostsFileSystem,
  type KnownHostsStore,
  type SshProcessRuntime,
} from "../../../src/ssh/client.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeProcesses implements SshProcessRuntime {
  readonly requests: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly maxOutputBytes: number;
  }> = [];

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout: Uint8Array;
      readonly stderr: Uint8Array;
      readonly outputTruncated: boolean;
      readonly spawned: boolean;
    },
  ) {}

  async run(request: { readonly command: string; readonly args: readonly string[]; readonly maxOutputBytes: number }) {
    this.requests.push(request);
    return this.result;
  }
}

class FakeStore implements KnownHostsStore {
  readonly writes: Array<{
    readonly path: string;
    readonly contents: Uint8Array;
    readonly mode: number;
  }> = [];

  async persistAtomically(path: string, contents: Uint8Array, mode: number): Promise<void> {
    this.writes.push({ path, contents, mode });
  }
}

function fingerprint(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
}

describe("strict SSH client", () => {
  it("forces batch mode, strict host keys, and a bounded timeout", () => {
    expect(sshArguments("admin@pop-os", ["true"], 4, "/runner/known_hosts")).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/runner/known_hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=4",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "--",
      "admin@pop-os",
      "true",
    ]);
  });

  it("encodes quotes and shell metacharacters into one documented POSIX command", () => {
    expect(
      sshArguments(
        "-oProxyCommand=touch /tmp/pwned",
        ["printf", "%s\\n", "it's; $(touch /tmp/pwned)"],
        1,
        "/runner/known hosts",
      ),
    ).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/runner/known hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "--",
      "-oProxyCommand=touch /tmp/pwned",
      "printf '%s\\n' 'it'\"'\"'s; $(touch /tmp/pwned)'",
    ]);
  });

  it.each([
    ["", ["true"]],
    ["host\0name", ["true"]],
    ["host", []],
    ["host", [""]],
    ["host", ["true", "bad\0arg"]],
  ])("rejects an invalid target or remote command", (target, command) => {
    expect(() => sshArguments(target, command, 4, "/runner/known_hosts")).toThrow();
  });

  it("requires the injected process runtime to enforce the output limit", async () => {
    const processes = new FakeProcesses({
      exitCode: 23,
      stdout: bytes("1234"),
      stderr: bytes("abcd"),
      outputTruncated: false,
      spawned: true,
    });

    const result = await runSsh(processes, "host", ["true"], 4, "/runner/known_hosts", 4);

    expect(new TextDecoder().decode(result.stdout)).toBe("1234");
    expect(new TextDecoder().decode(result.stderr)).toBe("abcd");
    expect(processes.requests).toEqual([
      {
        command: "ssh",
        args: sshArguments("host", ["true"], 4, "/runner/known_hosts"),
        maxOutputBytes: 4,
      },
    ]);
  });

  it("fails closed when the process runtime reports truncated output", async () => {
    const processes = new FakeProcesses({
      exitCode: 0,
      stdout: bytes("1234"),
      stderr: bytes(""),
      outputTruncated: true,
      spawned: true,
    });

    await expect(runSsh(processes, "host", ["true"], 4, "/runner/known_hosts", 4)).rejects.toThrow("output limit");
  });
});

describe("known_hosts enrollment", () => {
  it("persists only independently fingerprinted matching key material with 0600 semantics", async () => {
    const blob = bytes("trusted-key-blob");
    const line = `pop-os ssh-ed25519 ${Buffer.from(blob).toString("base64")}`;
    const processes = new FakeProcesses({
      exitCode: 0,
      stdout: bytes(`# comment\n${line}\n`),
      stderr: bytes(""),
      outputTruncated: false,
      spawned: true,
    });
    const store = new FakeStore();

    await enrollKnownHost(processes, store, {
      target: "pop-os",
      trustedFingerprint: fingerprint(blob),
      knownHostsPath: "/runner/known_hosts",
      connectTimeoutSeconds: 4,
    });

    expect(processes.requests).toEqual([
      {
        command: "ssh-keyscan",
        args: ["-T", "4", "--", "pop-os"],
        maxOutputBytes: 65_536,
      },
    ]);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.path).toBe("/runner/known_hosts");
    expect(store.writes[0]?.mode).toBe(0o600);
    expect(new TextDecoder().decode(store.writes[0]?.contents)).toBe(`${line}\n`);
  });

  it.each([
    [
      "mismatch",
      () => {
        const blob = bytes("actual");
        return {
          output: `host ssh-ed25519 ${Buffer.from(blob).toString("base64")}\n`,
          trusted: fingerprint(bytes("different")),
        };
      },
    ],
    [
      "ambiguity",
      () => {
        const blob = bytes("same-fingerprint");
        const encoded = Buffer.from(blob).toString("base64");
        return {
          output: `host ssh-ed25519 ${encoded}\nhost-alias ssh-ed25519 ${encoded}\n`,
          trusted: fingerprint(blob),
        };
      },
    ],
    ["no valid key", () => ({ output: "# only a comment\nmalformed\n", trusted: fingerprint(bytes("x")) })],
  ] as const)("fails closed on %s without a trust write", async (_label, fixture) => {
    const { output, trusted } = fixture();
    const processes = new FakeProcesses({
      exitCode: 0,
      stdout: bytes(output),
      stderr: bytes(""),
      outputTruncated: false,
      spawned: true,
    });
    const store = new FakeStore();

    await expect(
      enrollKnownHost(processes, store, {
        target: "host",
        trustedFingerprint: trusted,
        knownHostsPath: "/runner/known_hosts",
        connectTimeoutSeconds: 4,
      }),
    ).rejects.toThrow();

    expect(store.writes).toEqual([]);
  });

  it("fails closed without a trust write when keyscan output overflowed", async () => {
    const blob = bytes("trusted-key-blob");
    const processes = new FakeProcesses({
      exitCode: 0,
      stdout: bytes(`host ssh-ed25519 ${Buffer.from(blob).toString("base64")}\n`),
      stderr: bytes(""),
      outputTruncated: true,
      spawned: true,
    });
    const store = new FakeStore();

    await expect(
      enrollKnownHost(processes, store, {
        target: "host",
        trustedFingerprint: fingerprint(blob),
        knownHostsPath: "/runner/known_hosts",
        connectTimeoutSeconds: 4,
      }),
    ).rejects.toThrow("output limit");
    expect(store.writes).toEqual([]);
  });
});

class RecordingNodeFiles implements KnownHostsFileSystem {
  readonly events: string[] = [];
  failAt?: "write" | "sync-file" | "rename" | "sync-directory" | "remove";

  async writeExclusive(path: string, contents: Uint8Array, mode: number): Promise<void> {
    this.events.push(`write:${path}:${mode.toString(8)}`);
    await writeFile(path, contents, { flag: "wx", mode });
    if (this.failAt === "write") throw new Error("injected write failure");
  }

  async syncFile(path: string): Promise<void> {
    this.events.push(`sync-file:${path}`);
    if (this.failAt === "sync-file") throw new Error("injected sync failure");
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.events.push(`rename:${from}->${to}`);
    if (this.failAt === "rename") throw new Error("injected rename failure");
    await rename(from, to);
  }

  async syncDirectory(path: string): Promise<void> {
    this.events.push(`sync-directory:${path}`);
    if (this.failAt === "sync-directory") throw new Error("injected directory sync failure");
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async remove(path: string): Promise<void> {
    this.events.push(`remove:${path}`);
    if (this.failAt === "remove") throw new Error("injected cleanup failure");
    await rm(path);
  }
}

describe("NodeKnownHostsStore", () => {
  it("atomically writes same-directory material with mode 0600 and durable ordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-known-hosts-"));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const temporaryPath = `${path}.tmp-fixed-token`;
    const files = new RecordingNodeFiles();

    await new NodeKnownHostsStore(files, () => "fixed-token").persistAtomically(
      path,
      bytes("host ssh-ed25519 AAAA\n"),
      0o600,
    );

    expect(await readFile(path, "utf8")).toBe("host ssh-ed25519 AAAA\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(files.events).toEqual([
      `write:${temporaryPath}:600`,
      `sync-file:${temporaryPath}`,
      `rename:${temporaryPath}->${path}`,
      `sync-directory:${dirname(path)}`,
    ]);
  });

  it("cleans up its unique temporary file when persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-known-hosts-failure-"));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const files = new RecordingNodeFiles();
    files.failAt = "sync-file";

    await expect(
      new NodeKnownHostsStore(files, () => "failed-token").persistAtomically(path, bytes("material"), 0o600),
    ).rejects.toThrow("injected sync failure");

    expect(await readdir(root)).toEqual([]);
    expect(files.events.at(-1)).toBe(`remove:${path}.tmp-failed-token`);
  });

  it("preserves a foreign temporary file after an exclusive-write collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-known-hosts-collision-"));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const temporaryPath = `${path}.tmp-collision-token`;
    await writeFile(temporaryPath, "foreign", { mode: 0o600 });
    const files = new RecordingNodeFiles();

    await expect(
      new NodeKnownHostsStore(files, () => "collision-token").persistAtomically(path, bytes("ours"), 0o600),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(temporaryPath, "utf8")).toBe("foreign");
    expect(files.events.some((event) => event.startsWith("remove:"))).toBe(false);
  });

  it.each([
    ["write", "injected write failure"],
    ["rename", "injected rename failure"],
  ] as const)("attempts owned-temp cleanup after a %s failure", async (failure, message) => {
    const root = await mkdtemp(join(tmpdir(), `remote-runner-known-hosts-${failure}-`));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const temporaryPath = `${path}.tmp-${failure}-token`;
    const files = new RecordingNodeFiles();
    files.failAt = failure;

    await expect(
      new NodeKnownHostsStore(files, () => `${failure}-token`).persistAtomically(path, bytes("material"), 0o600),
    ).rejects.toThrow(message);

    expect(await readdir(root)).toEqual([]);
    expect(files.events.at(-1)).toBe(`remove:${temporaryPath}`);
  });

  it("surfaces directory-sync failure after rename without losing the completed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-known-hosts-directory-sync-"));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const files = new RecordingNodeFiles();
    files.failAt = "sync-directory";

    await expect(
      new NodeKnownHostsStore(files, () => "directory-token").persistAtomically(path, bytes("material"), 0o600),
    ).rejects.toThrow("injected directory sync failure");

    expect(await readFile(path, "utf8")).toBe("material");
    expect(files.events.some((event) => event.startsWith("remove:"))).toBe(false);
  });

  it("surfaces both the persistence and cleanup errors when cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-runner-known-hosts-cleanup-failure-"));
    temporaryRoots.push(root);
    const path = join(root, "known_hosts");
    const files = new RecordingNodeFiles();
    files.failAt = "sync-file";
    files.remove = async (temporaryPath: string) => {
      files.events.push(`remove:${temporaryPath}`);
      throw new Error("injected cleanup failure");
    };

    const failure = await new NodeKnownHostsStore(files, () => "cleanup-token")
      .persistAtomically(path, bytes("material"), 0o600)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "injected sync failure" }),
      expect.objectContaining({ message: "injected cleanup failure" }),
    ]);
    expect(files.events.at(-1)).toBe(`remove:${path}.tmp-cleanup-token`);
  });
});
