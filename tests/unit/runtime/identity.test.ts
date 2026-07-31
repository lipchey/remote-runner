import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { worktreeIdentity } from "../../../src/runtime/identity.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worktreeIdentity", () => {
  it("hashes the canonical real path without exposing path or branch text", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "remote-runner-identity-"));
    temporaryRoots.push(temporaryRoot);
    const root = join(temporaryRoot, "ariadne-feature-secret-branch");
    const alias = join(temporaryRoot, "alias");
    await mkdir(root);
    await symlink(root, alias);

    const canonicalRoot = await realpath(root);
    const expected = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 24);

    expect(worktreeIdentity(alias)).toBe(expected);
    expect(worktreeIdentity(alias)).toMatch(/^[0-9a-f]{24}$/);
    expect(worktreeIdentity(alias)).not.toContain("feature");
  });
});
