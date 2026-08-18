import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeNextPrewarmRequest,
  inspectPrewarmRequest,
  publishPrewarmRequest,
  type PrewarmOutcome,
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
  readonly resultPath: string;
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
  const basename = `${request.consumer}_${request.profile}_${request.identity}`;
  const queueRoot = join(home, ".local", "state", "remote-runner", "prewarm");
  return { home, request, queueRoot, basename, resultPath: join(queueRoot, "results", `${basename}.json`) };
}

async function recordedOutcome(home: string, request: PrewarmRequest, since: number): Promise<PrewarmOutcome> {
  const state = await inspectPrewarmRequest(home, request);
  if (typeof state === "string") throw new Error(`expected a recorded outcome, got ${state}`);
  expect(new Date(state.at).toISOString()).toBe(state.at);
  expect(Date.parse(state.at)).toBeGreaterThanOrEqual(since);
  expect(Date.parse(state.at)).toBeLessThanOrEqual(Date.now());
  return state;
}

describe("durable prewarm queue", () => {
  it("publishes once, coalesces duplicates, and exposes queued/running/idle state", async () => {
    const { home, request } = await fixture();
    const before = Date.now();

    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("idle");
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
    expect(await recordedOutcome(home, request, before)).toMatchObject({ outcome: "ok", status: 0 });
    await expect(consumeNextPrewarmRequest(home, async () => 0)).resolves.toBe("idle");
  });

  it("keeps the last outcome readable without letting it block or answer for the next request", async () => {
    const { home, request } = await fixture();
    const before = Date.now();
    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => 0);
    expect(await recordedOutcome(home, request, before)).toMatchObject({ outcome: "ok", status: 0 });

    await expect(publishPrewarmRequest(home, request)).resolves.toBe("published");
    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("queued");
    await expect(
      consumeNextPrewarmRequest(home, async () => {
        await expect(inspectPrewarmRequest(home, request)).resolves.toBe("running");
        return 1;
      }),
    ).resolves.toBe("processed");

    expect(await recordedOutcome(home, request, before)).toMatchObject({ outcome: "failed", status: 1 });
  });

  it("reports an unreadable outcome as unknown and still accepts the next request", async () => {
    const { home, request, resultPath } = await fixture();
    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => 0);
    await writeFile(resultPath, '{"schemaVersion":1,"status":0,"at":"who knows"}', { mode: 0o600 });

    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("unknown");
    await expect(publishPrewarmRequest(home, request)).resolves.toBe("published");
  });

  it("marks a claim so a lost terminal write cannot leave the previous outcome standing", async () => {
    const { home, request, resultPath } = await fixture();
    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => 0);

    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => {
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({ status: null });
      return 0;
    });
  });

  it("keeps two profiles apart when hyphens would have joined them into one key", async () => {
    const { home, request } = await fixture();
    const ran = { ...request, consumer: "remote", profile: "runner-full" };
    const other = { ...request, consumer: "remote-runner", profile: "full" };
    expect(`${ran.consumer}-${ran.profile}`).toBe(`${other.consumer}-${other.profile}`);

    await publishPrewarmRequest(home, ran);
    await expect(inspectPrewarmRequest(home, other)).resolves.toBe("idle");
    await expect(publishPrewarmRequest(home, other)).resolves.toBe("published");

    const statusFor = async (claimed: PrewarmRequest): Promise<number> => (claimed.consumer === "remote" ? 0 : 1);
    await consumeNextPrewarmRequest(home, statusFor);
    await consumeNextPrewarmRequest(home, statusFor);
    await expect(inspectPrewarmRequest(home, ran)).resolves.toMatchObject({ outcome: "ok", status: 0 });
    await expect(inspectPrewarmRequest(home, other)).resolves.toMatchObject({ outcome: "failed", status: 1 });
  });

  it("reports an unsafe results directory as unknown rather than never-ran", async () => {
    const { home, request, queueRoot } = await fixture();
    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => 0);
    await rm(join(queueRoot, "results"), { recursive: true, force: true });
    await symlink(join(queueRoot, ".."), join(queueRoot, "results"));

    await expect(inspectPrewarmRequest(home, request)).resolves.toBe("unknown");
  });

  it("recovers a claimed request left by a controller restart", async () => {
    const { home, request, queueRoot, basename } = await fixture();
    const before = Date.now();
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
    expect(await recordedOutcome(home, request, before)).toMatchObject({ outcome: "failed", status: 23 });
  });

  it("drops the claim when the run fails, so the controller does not replay it forever", async () => {
    const { home, request } = await fixture();
    const before = Date.now();
    await publishPrewarmRequest(home, request);

    await expect(
      consumeNextPrewarmRequest(home, async () => {
        throw new Error("prewarm failed");
      }),
    ).rejects.toThrow("prewarm failed");

    expect(await recordedOutcome(home, request, before)).toMatchObject({ outcome: "failed", status: 70 });
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
    await writeFile(join(queueRoot, "other_profile_0123456789abcdef01234567.json"), JSON.stringify(request), {
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
