import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import {
  COLD_BOOTSTRAP_MS,
  corpusJson,
  formatCorpus,
  readCorpus,
  summarizeCorpus,
  type CorpusOptions,
  type CorpusProvenance,
  type CorpusRead,
  type CorpusRecord,
  type CorpusRuntime,
  type CorpusSummary,
} from "../../../src/diagnostics/corpus.js";

const ROOT = "/corpus";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/corpus", import.meta.url));

const fixtureRuntime: CorpusRuntime = {
  listDirectories: async (path) =>
    (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
  readLog: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

async function readFixture(options?: CorpusOptions): Promise<{ read: CorpusRead; summary: CorpusSummary }> {
  const read = await readCorpus(fixtureRuntime, FIXTURE_ROOT);
  const summary = summarizeCorpus(read.records, options);
  return { read, summary };
}

/* Returns children in reverse order deliberately: a fake that sorted would let an unsorted merge
   pass, since the real runtime sorts too. */
function corpusRuntime(
  logs: Readonly<Record<string, string>>,
  emptyDirectories: readonly string[] = [],
): CorpusRuntime {
  const directories = new Set<string>();
  const addAncestors = (path: string): void => {
    const parts = path.split("/");
    for (let index = 2; index <= parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  };
  for (const path of Object.keys(logs)) addAncestors(path.slice(0, path.lastIndexOf("/")));
  for (const path of emptyDirectories) addAncestors(path);
  return {
    listDirectories: (path) =>
      Promise.resolve(
        [...directories]
          .filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes("/"))
          .map((entry) => entry.slice(path.length + 1))
          .sort()
          .reverse(),
      ),
    readLog: (path) => Promise.resolve(logs[path]),
  };
}

function finish(at: string, extra: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    event: "run-finish",
    at,
    status: 0,
    provider: "remote",
    durationMs: 1000,
    consumer: "ariadne",
    profile: "verify-full",
    identity: "a",
    ...extra,
  };
}

/* A finish that never reached a provider omits the field; an explicit undefined would test a record
   the runner never writes. */
function undispatchedFinish(at: string, extra: Partial<CorpusRecord> = {}): CorpusRecord {
  const { provider: _provider, ...record } = finish(at, extra);
  return record;
}

function provenance(extra: Partial<CorpusProvenance> = {}): CorpusProvenance {
  return { source: ROOT, files: 1, unparsed: 0, runner: "remote-runner 9.9.9 (app deadbeef)", ...extra };
}

function render(summary: CorpusSummary, extra: Partial<CorpusProvenance> = {}): string {
  return formatCorpus({ provenance: provenance(extra), summary });
}

test("only a finish that reached the remote provider counts as a dispatch", () => {
  const summary = summarizeCorpus([
    { ...finish("2026-08-01T00:00:00Z"), identity: "a" },
    { ...undispatchedFinish("2026-08-01T00:01:00Z", { status: 2 }), identity: "b" },
  ]);
  expect(summary.dispatched).toEqual({ total: 1, status: { "0": 1 } });
  expect(summary.undispatched).toBe(1);
});

test("a first-ever dispatch is excluded from the returning-cold count even when its bootstrap is cold", () => {
  const summary = summarizeCorpus([
    { ...finish("2026-08-01T00:00:00Z", { phases: { bootstrap: 12_000 } }), identity: "fresh" },
  ]);
  expect(summary.bootstrap.cold).toBe(1);
  expect(summary.bootstrap.returning).toBe(0);
  expect(summary.bootstrap.returningCold).toBe(0);
});

test("a returning identity paying a cold bootstrap is counted as returning-cold", () => {
  const summary = summarizeCorpus([
    { ...finish("2026-08-01T00:00:00Z", { phases: { bootstrap: 11_000 } }), identity: "x" },
    { ...finish("2026-08-02T00:00:00Z", { phases: { bootstrap: 2000 } }), identity: "x" },
    { ...finish("2026-08-03T00:00:00Z", { phases: { bootstrap: 9000 } }), identity: "x" },
  ]);
  expect(summary.bootstrap.returning).toBe(2);
  expect(summary.bootstrap.returningCold).toBe(1);
});

test("an earlier dispatch outside the window still makes the identity a returning one", () => {
  const records = [
    { ...finish("2026-08-01T00:00:00Z", { phases: { bootstrap: 2000 } }), identity: "x" },
    { ...finish("2026-08-10T00:00:00Z", { phases: { bootstrap: 9000 } }), identity: "x" },
  ];
  const summary = summarizeCorpus(records, { since: "2026-08-05" });
  expect(summary.bootstrap.measured).toBe(1);
  expect(summary.bootstrap.returning).toBe(1);
  expect(summary.bootstrap.returningCold).toBe(1);
});

test("the median of an even sample is the midpoint of the two middles, not the upper one", () => {
  const summary = summarizeCorpus(
    [2000, 3000, 4000, 9000].map((bootstrap, index) => ({
      ...finish(`2026-08-0${index + 1}T00:00:00Z`, { phases: { bootstrap } }),
      identity: `id${index}`,
    })),
  );
  expect(summary.bootstrap.medianMs).toBe(3500);
  expect(summary.bootstrap.measuredMs).toEqual([2000, 3000, 4000, 9000]);
});

/* The runner emits these while a run waits, and the same run can still finish green, so a reader who
   takes this line for a failure count is wrong. */
test("a deferred run is reported as a wait, not as an outcome", () => {
  const lines = render(
    summarizeCorpus([
      { ...finish("2026-08-01T00:00:00Z"), event: "run-unavailable", reason: "lock" },
      finish("2026-08-01T00:01:00Z"),
    ]),
  );
  expect(lines).toMatch(/deferred {3}lock=1 — waits, not outcomes/u);
  expect(lines).not.toMatch(/failures/u);
});

test("run-unavailable is tallied by reason and never mixed into the dispatch statuses", () => {
  const summary = summarizeCorpus([
    { ...finish("2026-08-01T00:00:00Z"), event: "run-unavailable", reason: "lock", identity: "a" },
    { ...finish("2026-08-01T00:01:00Z"), event: "run-unavailable", reason: "lock", identity: "b" },
    { ...finish("2026-08-01T00:02:00Z"), event: "run-unavailable", reason: "transport", identity: "c" },
  ]);
  expect(summary.deferred).toEqual({ lock: 2, transport: 1 });
  expect(summary.dispatched.total).toBe(0);
});

test("readCorpus walks consumer/profile/identity and skips a directory with no log", async () => {
  const read = await readCorpus(
    corpusRuntime(
      {
        [`${ROOT}/ariadne/verify-full/aaa/runner.log`]: `${JSON.stringify(finish("2026-08-02T00:00:00Z"))}\n`,
        [`${ROOT}/ariadne/verify-full/bbb/runner.log`]: `${JSON.stringify(finish("2026-08-01T00:00:00Z"))}\n`,
      },
      [`${ROOT}/ariadne/telegram-live/ccc`],
    ),
    ROOT,
  );
  expect(read.records.map((record) => record.identity)).toEqual(["bbb", "aaa"]);
  expect(read.records[0]?.consumer).toBe("ariadne");
  expect(read.records[0]?.profile).toBe("verify-full");
  expect(read.files).toBe(2);
});

/* The runner rotates at a size cap, so history moves out of `runner.log` without warning: reading
   only the live file silently shrinks every historical count the day the first log rotates. */
test("rotated logs are read oldest-first alongside the live one", async () => {
  const directory = `${ROOT}/ariadne/verify-full/aaa`;
  const read = await readCorpus(
    corpusRuntime({
      [`${directory}/runner.log.2`]: `${JSON.stringify(finish("2026-08-01T00:00:00Z"))}\n`,
      [`${directory}/runner.log.1`]: `${JSON.stringify(finish("2026-08-02T00:00:00Z"))}\n`,
      [`${directory}/runner.log`]: `${JSON.stringify(finish("2026-08-03T00:00:00Z"))}\n`,
    }),
    ROOT,
  );
  expect(read.records.map((record) => record.at)).toEqual([
    "2026-08-01T00:00:00Z",
    "2026-08-02T00:00:00Z",
    "2026-08-03T00:00:00Z",
  ]);
});

test("an unreadable corpus directory is not reported as an empty one", async () => {
  const runtime: CorpusRuntime = {
    listDirectories: (path) =>
      path === ROOT
        ? Promise.resolve(["ariadne"])
        : Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), { code: "EACCES" })),
    readLog: () => Promise.resolve(undefined),
  };
  await expect(readCorpus(runtime, ROOT)).rejects.toThrow(/EACCES/u);
});

test("a partial trailing line loses that record and keeps the rest of the identity", async () => {
  const read = await readCorpus(
    corpusRuntime({
      [`${ROOT}/ariadne/verify-full/aaa/runner.log`]: `${JSON.stringify(finish("2026-08-01T00:00:00Z"))}\n{"event":"run-fin`,
    }),
    ROOT,
  );
  expect(read.records).toHaveLength(1);
  expect(read.unparsed).toBe(1);
});

/* A record that parses but carries no `at`/`event` is what upstream format drift looks like from
   here, and nothing else in this repo would announce it. */
test("a record missing the fields every reading depends on is counted, not silently dropped", async () => {
  const read = await readCorpus(
    corpusRuntime({
      [`${ROOT}/ariadne/verify-full/aaa/runner.log`]: [
        JSON.stringify(finish("2026-08-01T00:00:00Z")),
        JSON.stringify({ timestamp: "2026-08-02T00:00:00Z", kind: "run-finish" }),
        "{not json",
        "",
      ].join("\n"),
    }),
    ROOT,
  );
  expect(read.records).toHaveLength(1);
  expect(read.unparsed).toBe(2);
  expect(read.files).toBe(1);
});

test("the report leads with the provenance every figure below it depends on", () => {
  const lines = render(summarizeCorpus([finish("2026-08-01T00:00:00Z")]), { unparsed: 1 });
  expect(lines).toMatch(/source {5}\/corpus/u);
  expect(lines).toMatch(/read {7}1 log files, 1 unparseable records, runner remote-runner 9\.9\.9/u);
});

test("an absent corpus reports where it was expected instead of failing", () => {
  expect(render(summarizeCorpus([]), { files: 0 })).toMatch(/no remote-runner log corpus at \/corpus/u);
});

/* Total format drift makes every record unreadable, which is exactly when the absent-corpus message
   would hide the drift counters that exist to announce it. */
test("logs that exist but yield nothing readable are reported, not called an absent corpus", () => {
  const lines = render(summarizeCorpus([]), { unparsed: 2 });
  expect(lines).not.toMatch(/no remote-runner log corpus/u);
  expect(lines).toMatch(/read {7}1 log files, 2 unparseable records/u);
});

/* A finish that never reached the remote provider built no workspace. Counting one as an identity's
   first dispatch makes that identity's real first — cold by construction — look like a reclaim. */
test("a finish that never reached a provider does not stand as the identity's first dispatch", () => {
  const summary = summarizeCorpus([
    { ...undispatchedFinish("2026-08-01T00:00:00Z", { status: 2 }), identity: "x" },
    { ...finish("2026-08-02T00:00:00Z", { phases: { bootstrap: 11_000 } }), identity: "x" },
  ]);
  expect(summary.bootstrap.returning).toBe(0);
  expect(summary.bootstrap.returningCold).toBe(0);
});

test("a record cannot re-file itself into a lane the directory did not put it in", async () => {
  const read = await readCorpus(
    corpusRuntime({
      [`${ROOT}/ariadne/verify-full/aaa/runner.log`]: `${JSON.stringify(
        finish("2026-08-01T00:00:00Z", { profile: "telegram-live", identity: "spoofed", consumer: "other" }),
      )}\n`,
    }),
    ROOT,
  );
  const [record] = read.records;
  expect(record?.profile).toBe("verify-full");
  expect(record?.identity).toBe("aaa");
  expect(record?.consumer).toBe("ariadne");
});

/* Cut inside a two-byte sequence, so the line really carries a replacement character: a fatal decode
   would throw the whole file away, and an ASCII prefix would not exercise that at all. */
test("a record truncated mid-multibyte character costs that record alone", async () => {
  const serialized = Buffer.from(JSON.stringify(finish("2026-08-02T00:00:00Z", { reason: "черга" })), "utf8");
  const cut = serialized.subarray(0, serialized.indexOf(0xd1) + 1);
  const read = await readCorpus(
    corpusRuntime({
      [`${ROOT}/ariadne/verify-full/aaa/runner.log`]: `${JSON.stringify(finish("2026-08-01T00:00:00Z"))}\n${new TextDecoder().decode(cut)}`,
    }),
    ROOT,
  );
  expect(read.records.map((record) => record.at)).toEqual(["2026-08-01T00:00:00Z"]);
  expect(read.unparsed).toBe(1);
});

test("a non-regular file where a log was expected is skipped, not counted as read", async () => {
  const directory = `${ROOT}/ariadne/verify-full/aaa`;
  const runtime = corpusRuntime({
    [`${directory}/runner.log.1`]: `${JSON.stringify(finish("2026-08-01T00:00:00Z"))}\n`,
    [`${directory}/runner.log`]: "",
  });
  const read = await readCorpus(
    {
      ...runtime,
      readLog: (path) => (path.endsWith("/runner.log") ? Promise.resolve(undefined) : runtime.readLog(path)),
    },
    ROOT,
  );
  expect(read.files).toBe(1);
  expect(read.records).toHaveLength(1);
});

/* `schemaVersion` guards the envelope's shape; only this pin guards its meaning. A commit that
   changes what an absent `provider` implies, or which finishes count as dispatched, reds here and
   has to bump the version deliberately. */
test("the envelope pins what every field of a real corpus means", async () => {
  const { read, summary } = await readFixture();
  const envelope: unknown = JSON.parse(
    JSON.stringify(
      corpusJson({ ...provenance(), source: FIXTURE_ROOT, files: read.files, unparsed: read.unparsed }, summary),
    ),
  );
  expect(envelope).toEqual({
    schemaVersion: 1,
    source: FIXTURE_ROOT,
    files: 4,
    unparsed: 0,
    runner: "remote-runner 9.9.9 (app deadbeef)",
    since: "",
    records: 8,
    identities: 3,
    profiles: ["ariadne/verify-full", "telegram/live"],
    span: { from: "2026-08-01T00:00:00Z", to: "2026-08-04T01:00:00Z" },
    dispatched: { total: 4, status: { "0": 3, "1": 1 } },
    undispatched: 2,
    deferred: { lock: 1, transport: 1 },
    bootstrap: {
      measured: 3,
      of: 4,
      coldThresholdMs: 5000,
      cold: 2,
      medianMs: 9000,
      maxMs: 12_000,
      returning: 2,
      returningCold: 1,
      measuredMs: [2000, 9000, 12_000],
    },
    failures: [
      {
        at: "2026-08-03T00:00:00Z",
        consumer: "ariadne",
        profile: "verify-full",
        identity: "aaa",
        runId: "r4",
        status: 1,
        durationMs: 48_000,
      },
    ],
  });
});

test("a non-default cold threshold moves the counts it defines and ships back with them", async () => {
  const { summary } = await readFixture({ coldThresholdMs: 10_000 });
  expect(summary.bootstrap.coldThresholdMs).toBe(10_000);
  expect(summary.bootstrap.cold).toBe(1);
  expect(summary.bootstrap.returningCold).toBe(0);
  expect(summary.bootstrap.measuredMs).toEqual([2000, 9000, 12_000]);
});

/* The text render is where the absent corpus turns into prose; a JSON consumer parses this field by
   field and must never be handed a sentence. */
test("an absent corpus still yields a parseable envelope with a null span", () => {
  const envelope: unknown = JSON.parse(JSON.stringify(corpusJson(provenance({ files: 0 }), summarizeCorpus([]))));
  expect(envelope).toMatchObject({
    schemaVersion: 1,
    files: 0,
    records: 0,
    span: null,
    dispatched: { total: 0, status: {} },
    failures: [],
  });
});

test("the failure list is capped and says how many it withheld", () => {
  const records = Array.from({ length: 4 }, (_, index) => ({
    ...finish(`2026-08-0${index + 1}T00:00:00Z`, { status: 1 }),
    identity: `id${index}`,
  }));
  const lines = formatCorpus({ provenance: provenance(), summary: summarizeCorpus(records) }, { failureLimit: 2 });
  expect(lines).toMatch(/failures {3}4 non-zero/u);
  expect(lines).toMatch(/\.\.\. 2 withheld/u);
});

/* The cap exists so a terminal stays readable; a consumer reading the envelope has to get every
   failure or its own tallies silently stop at 15. */
test("the JSON failure list is complete where the text render caps it", () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    ...finish(`2026-08-01T00:${String(index).padStart(2, "0")}:00Z`, { status: 1 }),
    identity: `id${index}`,
  }));
  const summary = summarizeCorpus(records);
  const lines = formatCorpus({ provenance: provenance(), summary });
  expect(lines.split("\n").filter((line) => line.startsWith("  2026-"))).toHaveLength(15);
  expect(lines).toMatch(/\.\.\. 5 withheld/u);
  expect(corpusJson(provenance(), summary).failures).toHaveLength(20);
});

test("a window with no per-phase records reports that instead of dividing by nothing", () => {
  const summary = summarizeCorpus([finish("2026-08-01T00:00:00Z")]);
  expect(summary.bootstrap.measured).toBe(0);
  expect(summary.bootstrap.medianMs).toBeNull();
  expect(summary.bootstrap.maxMs).toBeNull();
  expect(summary.bootstrap.coldThresholdMs).toBe(COLD_BOOTSTRAP_MS);
  expect(render(summary)).toMatch(/bootstrap {2}no per-phase records in this window/u);
});
