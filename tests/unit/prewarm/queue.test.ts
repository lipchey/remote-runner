import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeNextPrewarmRequest,
  inspectPrewarmRequest,
  publishPrewarmRequest,
  type PrewarmRequest,
} from "../../../src/prewarm/queue.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly home: string;
  readonly request: PrewarmRequest;
  readonly queueRoot: string;
  readonly basename: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "remote-runner-prewarm-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory, { recursive: true });
  const sourceRoot = await realpath(sourceDirectory);
  const manifestPath = join(sourceRoot, ".remote-runner.yaml");
  await writeFile(manifestPath, "schemaVersion: 1\nprofiles: []\n");
  const request: PrewarmRequest = {
    schemaVersion: 1,
    consumer: "ariadne",
    profile: "verify-full",
    identity: "0123456789abcdef01234567",
    sourceRoot,
    manifestPath,
  };
  const basename = `${request.consumer}-${request.profile}-${request.identity}`;
  return {
    home,
    request,
    queueRoot: join(home, ".local", "state", "remote-runner", "prewarm"),
    basename,
  };
}

describe("durable prewarm queue", () => {
  it("publishes once, coalesces duplicates, and exposes queued/running/idle state", async () => {
    const { home, request } = await fixture();

    await expect(publishPrewarmRequest(home, request)).resolves.toBe("published");
    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("queued");
    await expect(publishPrewarmRequest(home, request)).resolves.toBe("coalesced");

    const observed: PrewarmRequest[] = [];
    await expect(
      consumeNextPrewarmRequest(home, async (claimed) => {
        observed.push(claimed);
        await expect(inspectPrewarmRequest(home, request)).resolves.toBe("running");
        return 0;
      }),
    ).resolves.toBe("processed");

    expect(observed).toEqual([request]);
    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("idle");
    await expect(consumeNextPrewarmRequest(home, async () => 0)).resolves.toBe("idle");
  });

  it("recovers a claimed request left by a controller restart", async () => {
    const { home, request, queueRoot, basename } = await fixture();
    await publishPrewarmRequest(home, request);
    await rename(join(queueRoot, `${basename}.json`), join(queueRoot, `${basename}.running`));

    const observed: PrewarmRequest[] = [];
    await expect(
      consumeNextPrewarmRequest(home, async (claimed) => {
        observed.push(claimed);
        return 23;
      }),
    ).resolves.toBe("processed");

    expect(observed).toEqual([request]);
    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("idle");
  });

  it("drops the claim when the run fails, so the controller does not replay it forever", async () => {
    const { home, request } = await fixture();
    await publishPrewarmRequest(home, request);

    await expect(
      consumeNextPrewarmRequest(home, async () => {
        throw new Error("prewarm failed");
      }),
    ).rejects.toThrow("prewarm failed");

    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("idle");
  });

  it("discards a malformed owned request without invoking the workload", async () => {
    const { home, queueRoot, basename } = await fixture();
    await mkdir(queueRoot, { recursive: true });
    await writeFile(join(queueRoot, `${basename}.json`), "{}", { mode: 0o600 });
    let calls = 0;

    await expect(
      consumeNextPrewarmRequest(home, async () => {
        calls += 1;
        return 0;
      }),
    ).resolves.toBe("discarded");

    expect(calls).toBe(0);
  });

  it("discards a payload whose identity does not match its queue filename", async () => {
    const { home, request, queueRoot } = await fixture();
    await mkdir(queueRoot, { recursive: true });
    await writeFile(join(queueRoot, "other-profile-0123456789abcdef01234567.json"), JSON.stringify(request), {
      mode: 0o600,
    });
    let calls = 0;

    await expect(
      consumeNextPrewarmRequest(home, async () => {
        calls += 1;
        return 0;
      }),
    ).resolves.toBe("discarded");

    expect(calls).toBe(0);
  });

  it("refuses a symlinked queue root without touching its target", async () => {
    const { home, request, queueRoot } = await fixture();
    const outside = join(home, "outside");
    await mkdir(join(queueRoot, ".."), { recursive: true });
    await mkdir(outside);
    await symlink(outside, queueRoot);

    await expect(publishPrewarmRequest(home, request)).rejects.toThrow(/queue root/u);
    await expect(
      readFile(join(outside, `${request.consumer}-${request.profile}-${request.identity}.json`)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
