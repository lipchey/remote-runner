import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clientNamespace, resolveClientIdentity, worktreeIdentity } from "../../../src/runtime/identity.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worktreeIdentity", () => {
  it("persists a private client identity across calls and separates installations", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-client-"));
    temporaryRoots.push(home);
    const first = resolveClientIdentity(join(home, "first"));
    expect(resolveClientIdentity(join(home, "first"))).toBe(first);
    expect(resolveClientIdentity(join(home, "second"))).not.toBe(first);
    const path = join(home, "first", ".local", "state", "remote-runner", "client-id");
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(clientNamespace(first)).toMatch(/^[a-f0-9]{24}$/u);
    await writeFile(path, "corrupt");
    expect(() => resolveClientIdentity(join(home, "first"))).toThrow(/invalid remote-runner client identity/u);
  });

  it("refuses a symlinked identity instead of silently sharing another client's identity", async () => {
    const home = await mkdtemp(join(tmpdir(), "remote-runner-client-link-"));
    temporaryRoots.push(home);
    const state = join(home, ".local", "state", "remote-runner");
    await mkdir(state, { recursive: true });
    await writeFile(join(home, "shared"), "unused");
    await symlink(join(home, "shared"), join(state, "client-id"));
    expect(() => resolveClientIdentity(home)).toThrow();
  });
  it("hashes the canonical real path without exposing path or branch text", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "remote-runner-identity-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "ariadne-feature-secret-branch");
    const alias = join(temporaryRoot, "alias");
    await mkdir(root);
    await symlink(root, alias);

    const canonicalRoot = await realpath(root);
    const expected = createHash("sha256")
      .update(JSON.stringify(["client-one", canonicalRoot]))
      .digest("hex")
      .slice(0, 24);

    expect(worktreeIdentity(alias, "client-one")).toBe(expected);
    expect(worktreeIdentity(alias, "client-one")).toBe(worktreeIdentity(root, "client-one"));
    expect(worktreeIdentity(alias, "client-one")).toMatch(/^[0-9a-f]{24}$/);
    expect(worktreeIdentity(alias, "client-one")).not.toContain("feature");
    expect(worktreeIdentity(root, "client-two")).not.toBe(worktreeIdentity(root, "client-one"));
  });
});
