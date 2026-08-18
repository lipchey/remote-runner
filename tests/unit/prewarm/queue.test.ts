import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

/* The fixture identity sorts first by name; this one sorts last, so arrival order and hash order
   can be made to disagree. */
const HASH_LATE_IDENTITY = "fedcba9876543210fedcba98";

function basenameOf(request: PrewarmRequest): string {
  return `${request.consumer}_${request.profile}_${request.identity}`;
}

async function stamp(path: string, seconds: number): Promise<void> {
  await utimes(path, new Date(seconds * 1000), new Date(seconds * 1000));
}

async function claimedIdentity(home: string): Promise<string | undefined> {
  let identity: string | undefined;
  await consumeNextPrewarmRequest(home, async (claimed) => {
    identity = claimed.identity;
    return 0;
  });
  return identity;
}

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
  const { state } = await inspectPrewarmRequest(home, request);
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

    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "idle" });
    await expect(publishPrewarmRequest(home, request)).resolves.toBe("published");
    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "queued" });
    await expect(publishPrewarmRequest(home, request)).resolves.toBe("coalesced");

    const observed: PrewarmRequest[] = [];
    await expect(
      consumeNextPrewarmRequest(home, async (claimed) => {
        observed.push(claimed);
        await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "running" });
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
    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "queued" });
    await expect(
      consumeNextPrewarmRequest(home, async () => {
        await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "running" });
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

    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "unknown" });
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
    await expect(inspectPrewarmRequest(home, other)).resolves.toMatchObject({ state: "idle" });
    await expect(publishPrewarmRequest(home, other)).resolves.toBe("published");

    const statusFor = async (claimed: PrewarmRequest): Promise<number> => (claimed.consumer === "remote" ? 0 : 1);
    await consumeNextPrewarmRequest(home, statusFor);
    await consumeNextPrewarmRequest(home, statusFor);
    await expect(inspectPrewarmRequest(home, ran)).resolves.toMatchObject({ state: { outcome: "ok", status: 0 } });
    await expect(inspectPrewarmRequest(home, other)).resolves.toMatchObject({
      state: { outcome: "failed", status: 1 },
    });
  });

  it("reports an unsafe results directory as unknown rather than never-ran", async () => {
    const { home, request, queueRoot } = await fixture();
    await publishPrewarmRequest(home, request);
    await consumeNextPrewarmRequest(home, async () => 0);
    await rm(join(queueRoot, "results"), { recursive: true, force: true });
    await symlink(join(queueRoot, ".."), join(queueRoot, "results"));

    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "unknown" });
  });

  it("serves the request that arrived first, not the one whose identity sorts first", async () => {
    const { home, request, queueRoot } = await fixture();
    const arrivedFirst = { ...request, identity: HASH_LATE_IDENTITY };
    await publishPrewarmRequest(home, arrivedFirst);
    await publishPrewarmRequest(home, request);
    await stamp(join(queueRoot, `${basenameOf(arrivedFirst)}.json`), 1000);
    await stamp(join(queueRoot, `${basenameOf(request)}.json`), 2000);

    await expect(claimedIdentity(home)).resolves.toBe(HASH_LATE_IDENTITY);
  });

  it("keeps a recovered claim ahead of a pending request that arrived earlier", async () => {
    const { home, request, queueRoot } = await fixture();
    const recovered = { ...request, identity: HASH_LATE_IDENTITY };
    await publishPrewarmRequest(home, recovered);
    await publishPrewarmRequest(home, request);
    const runningPath = join(queueRoot, `${basenameOf(recovered)}.running`);
    await rename(join(queueRoot, `${basenameOf(recovered)}.json`), runningPath);
    await stamp(join(queueRoot, `${basenameOf(request)}.json`), 1000);
    await stamp(runningPath, 2000);

    await expect(claimedIdentity(home)).resolves.toBe(HASH_LATE_IDENTITY);
  });

  /* Arrival order is the write mtime surviving link() at publish and rename() at claim; a refactor
     to a copy at either end reorders the queue with nothing else failing. */
  it("carries the arrival timestamp through the claim", async () => {
    const { home, request, queueRoot, basename } = await fixture();
    await publishPrewarmRequest(home, request);
    const published = (await lstat(join(queueRoot, `${basename}.json`))).mtimeMs;

    let claimed = 0;
    await consumeNextPrewarmRequest(home, async () => {
      claimed = (await lstat(join(queueRoot, `${basename}.running`))).mtimeMs;
      return 0;
    });

    expect(claimed).toBe(published);
  });

  it("orders two ordinary publishes by the timestamps they really carry", async () => {
    const { home, request } = await fixture();
    await publishPrewarmRequest(home, { ...request, identity: HASH_LATE_IDENTITY });
    await publishPrewarmRequest(home, request);

    await expect(claimedIdentity(home)).resolves.toBe(HASH_LATE_IDENTITY);
  });

  it("reports how far back the queue a request sits and how long it has waited", async () => {
    const { home, request, queueRoot } = await fixture();
    const ahead = { ...request, identity: HASH_LATE_IDENTITY };
    const behind = { ...request, identity: "89abcdef0123456789abcdef" };
    for (const queued of [ahead, behind, request]) await publishPrewarmRequest(home, queued);
    await stamp(join(queueRoot, `${basenameOf(ahead)}.json`), 1000);
    await stamp(join(queueRoot, `${basenameOf(request)}.json`), 2000);
    await stamp(join(queueRoot, `${basenameOf(behind)}.json`), 3000);

    const status = await inspectPrewarmRequest(home, request);

    expect(status).toMatchObject({ state: "queued", queue: { position: 1, depth: 3 } });
    expect(Math.abs((status.queue?.waitedMs ?? 0) - (Date.now() - 2_000_000))).toBeLessThan(5_000);
  });

  /* Position counts dispatch entries, so a recovered claim is ahead of every pending request even
     when it arrived later — telling a waiting consumer it is next while a claim runs is the one
     answer an operator would act on wrongly. */
  it("counts a recovered claim ahead of every pending request", async () => {
    const { home, request, queueRoot } = await fixture();
    const claimed = { ...request, identity: HASH_LATE_IDENTITY };
    const pending = { ...request, identity: "89abcdef0123456789abcdef" };
    for (const queued of [claimed, request, pending]) await publishPrewarmRequest(home, queued);
    await rename(join(queueRoot, `${basenameOf(claimed)}.json`), join(queueRoot, `${basenameOf(claimed)}.running`));
    await stamp(join(queueRoot, `${basenameOf(claimed)}.running`), 3000);
    await stamp(join(queueRoot, `${basenameOf(request)}.json`), 1000);
    await stamp(join(queueRoot, `${basenameOf(pending)}.json`), 2000);

    await expect(inspectPrewarmRequest(home, claimed)).resolves.toMatchObject({
      state: "running",
      queue: { position: 0, depth: 3 },
    });
    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({
      state: "queued",
      queue: { position: 1, depth: 3 },
    });
  });

  /* `ownedEntries` accepts symlinks and `entryKind` does not, so deriving the state from the queue
     listing would report a symlinked entry as queued and let publish coalesce onto it instead of
     refusing it. */
  it.each([["symlink"], ["directory"]])("keeps a %s queue entry unsafe rather than queued", async (kind) => {
    const { home, request, queueRoot, basename } = await fixture();
    await mkdir(queueRoot, { recursive: true });
    const entry = join(queueRoot, `${basename}.json`);
    if (kind === "symlink") await symlink(join(queueRoot, "elsewhere"), entry);
    else await mkdir(entry);

    await expect(inspectPrewarmRequest(home, request)).resolves.toMatchObject({ state: "unknown" });
    await expect(publishPrewarmRequest(home, request)).rejects.toThrow("prewarm queue entry is unsafe");
  });

  /* An over-full queue costs the numbers, never the answer. */
  it("still answers when the queue is too deep to order", async () => {
    const { home, request, queueRoot } = await fixture();
    await publishPrewarmRequest(home, request);
    await Promise.all(
      Array.from({ length: 1_024 }, (_unused, index) =>
        writeFile(join(queueRoot, `filler-profile-${index.toString(16).padStart(24, "0")}.json`), "{}", {
          mode: 0o600,
        }),
      ),
    );

    const status = await inspectPrewarmRequest(home, request);

    expect(status.state).toBe("queued");
    expect(status.queue).toBeUndefined();
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
