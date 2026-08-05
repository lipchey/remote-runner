import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureManagedSshTransport,
  ensureManagedKnownHost,
  managedKnownHostsContains,
  mergeManagedKnownHosts,
  mutagenSshEnvironment,
} from "../../../src/node/managed-ssh.js";

const roots: string[] = [];

function keyOf(material: string): string {
  return Buffer.from(new TextEncoder().encode(material)).toString("base64");
}

function pinOf(material: string): string {
  return `SHA256:${createHash("sha256").update(new TextEncoder().encode(material)).digest("base64").replace(/=+$/u, "")}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Mutagen SSH transport", () => {
  it("installs strict ssh/scp wrappers idempotently with no dependency on user SSH files", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-managed-ssh-"));
    roots.push(home);

    const first = await ensureManagedSshTransport(home);
    const second = await ensureManagedSshTransport(home);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.directory).toBe(join(home, ".local/share/remote-runner/ssh"));
    for (const tool of ["ssh", "scp"]) {
      const path = join(first.directory, tool);
      const contents = await readFile(path, "utf8");
      expect(contents).toContain(`/usr/bin/${tool}`);
      expect(contents).toContain(`UserKnownHostsFile=${first.knownHostsPath}`);
      expect(contents).toContain("StrictHostKeyChecking=yes");
      expect(contents).toContain("GlobalKnownHostsFile=/dev/null");
      expect(contents).toContain("ServerAliveInterval=15");
      expect(contents).toContain("ServerAliveCountMax=4");
      expect(contents).not.toContain("~/.ssh");
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });

  it("repairs a stale owned wrapper and reports the material change", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-managed-ssh-stale-"));
    roots.push(home);
    const installed = await ensureManagedSshTransport(home);
    const ssh = join(installed.directory, "ssh");
    await writeFile(ssh, "stale");
    await chmod(ssh, 0o600);

    const repaired = await ensureManagedSshTransport(home);

    expect(repaired.changed).toBe(true);
    expect(await readFile(ssh, "utf8")).toContain("StrictHostKeyChecking=yes");
    expect((await stat(ssh)).mode & 0o777).toBe(0o700);
  });

  it("merges verified host lines without dropping another managed target", () => {
    const existing = `alpha ssh-ed25519 ${keyOf("alpha-key")}\n`;
    const added = `beta ssh-ed25519 ${keyOf("beta-key")}\n`;

    expect(mergeManagedKnownHosts(existing, added)).toBe(existing + added);
    expect(mergeManagedKnownHosts(existing + added, added)).toBe(existing + added);
    expect(managedKnownHostsContains(existing + added, "alpha", pinOf("alpha-key"))).toBe(true);
    expect(managedKnownHostsContains(existing + added, "gamma", pinOf("alpha-key"))).toBe(false);
  });

  it("treats a host whose listed key is not the pinned one as absent", () => {
    const contents = `alpha ssh-ed25519 ${keyOf("superseded-key")}\n`;

    expect(managedKnownHostsContains(contents, "admin@alpha", pinOf("superseded-key"))).toBe(true);
    expect(managedKnownHostsContains(contents, "admin@alpha", pinOf("replacement-key"))).toBe(false);
  });

  /* Every version before the pin check merged the new record beside the old one, so this two-record
     shape is what a machine that has already re-pinned once has on disk. */
  it("treats a host still carrying a superseded record beside the pinned one as absent", () => {
    const contents = `alpha ssh-ed25519 ${keyOf("superseded-key")}\nalpha ssh-ed25519 ${keyOf("current-key")}\n`;

    expect(managedKnownHostsContains(contents, "alpha", pinOf("current-key"))).toBe(false);
  });

  it("scopes the documented Mutagen SSH override to the managed wrapper directory", () => {
    expect(mutagenSshEnvironment("/managed/ssh", { SAFE_EXISTING: "1" })).toEqual({
      SAFE_EXISTING: "1",
      MUTAGEN_SSH_PATH: "/managed/ssh",
    });
    expect(() => mutagenSshEnvironment("relative", {})).toThrow();
  });

  it("enrolls a verified second host without dropping the first managed key", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-managed-hosts-"));
    roots.push(home);
    const knownHostsPath = join(home, ".local/state/remote-runner/known_hosts/managed");
    await mkdir(join(home, ".local/state/remote-runner/known_hosts"), { recursive: true });
    await writeFile(knownHostsPath, "alpha ssh-ed25519 AAAA\n", { mode: 0o600 });
    const blob = new TextEncoder().encode("trusted-beta-key");
    const encoded = Buffer.from(blob).toString("base64");
    const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
    let scans = 0;

    await ensureManagedKnownHost(
      {
        async run() {
          scans += 1;
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(`beta ssh-ed25519 ${encoded}\n`),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
      },
      {
        target: "admin@beta",
        trustedFingerprint: fingerprint,
        knownHostsPath,
        connectTimeoutSeconds: 4,
      },
    );
    await ensureManagedKnownHost(
      {
        async run() {
          throw new Error("existing host must not be rescanned");
        },
      },
      {
        target: "admin@beta",
        trustedFingerprint: fingerprint,
        knownHostsPath,
        connectTimeoutSeconds: 4,
      },
    );

    expect(scans).toBe(1);
    expect(await readFile(knownHostsPath, "utf8")).toBe(`alpha ssh-ed25519 AAAA\nbeta ssh-ed25519 ${encoded}\n`);
    expect((await stat(knownHostsPath)).mode & 0o777).toBe(0o600);
  });

  it("re-enrolls a re-pinned host and evicts the key it superseded", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-managed-repin-"));
    roots.push(home);
    const knownHostsPath = join(home, ".local/state/remote-runner/known_hosts/managed");
    await mkdir(join(home, ".local/state/remote-runner/known_hosts"), { recursive: true });
    await writeFile(
      knownHostsPath,
      `alpha ssh-ed25519 ${keyOf("alpha-key")}\nbeta ssh-ed25519 ${keyOf("superseded-key")}\n`,
      { mode: 0o600 },
    );

    await ensureManagedKnownHost(
      {
        async run() {
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(`beta ssh-ed25519 ${keyOf("replacement-key")}\n`),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
      },
      {
        target: "admin@beta",
        trustedFingerprint: pinOf("replacement-key"),
        knownHostsPath,
        connectTimeoutSeconds: 4,
      },
    );

    expect(await readFile(knownHostsPath, "utf8")).toBe(
      `alpha ssh-ed25519 ${keyOf("alpha-key")}\nbeta ssh-ed25519 ${keyOf("replacement-key")}\n`,
    );
  });

  it("evicts only the re-pinned alias from a record that also serves another host", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-managed-alias-"));
    roots.push(home);
    const knownHostsPath = join(home, ".local/state/remote-runner/known_hosts/managed");
    await mkdir(join(home, ".local/state/remote-runner/known_hosts"), { recursive: true });
    await writeFile(knownHostsPath, `alpha,beta ssh-ed25519 ${keyOf("shared-key")}\n`, { mode: 0o600 });

    await ensureManagedKnownHost(
      {
        async run() {
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(`beta ssh-ed25519 ${keyOf("beta-key")}\n`),
            stderr: new Uint8Array(),
            outputTruncated: false,
            spawned: true,
          };
        },
      },
      {
        target: "admin@beta",
        trustedFingerprint: pinOf("beta-key"),
        knownHostsPath,
        connectTimeoutSeconds: 4,
      },
    );

    expect(await readFile(knownHostsPath, "utf8")).toBe(
      `alpha ssh-ed25519 ${keyOf("shared-key")}\nbeta ssh-ed25519 ${keyOf("beta-key")}\n`,
    );
  });
});
