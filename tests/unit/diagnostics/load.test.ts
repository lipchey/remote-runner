import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifestText } from "../../../src/config/load-manifest.js";
import {
  HOST_LOAD_CAPTURE_BYTES,
  formatHostLoad,
  parseLoadWindow,
  readHostLoad,
} from "../../../src/diagnostics/load.js";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../../src/ssh/client.js";
import { validManifest } from "../config/manifest-fixture.js";

const from = Date.parse("2026-10-07T10:00:00Z");
const to = from + 3_600_000;
const key = Buffer.from("host-load-test-key");
const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
const profile = loadManifestText(validManifest.replace("SHA256:trusted", fingerprint)).profiles[0]!;

function report() {
  return {
    v: 1,
    window: { from, to },
    host: {
      ncpu: 24,
      busy_cores_mean: 2,
      busy_pct: 8.333,
      psi: { cpu_some_pct: 1, cpu_full_pct: 0, io_some_pct: 2, io_full_pct: 0, mem_some_pct: 3, mem_full_pct: 0 },
    },
    groups: [
      {
        source: "ci",
        labels: { runner: "popos-1", busy: true },
        members: 1,
        mean_cores: 2,
        share: 1,
        peak_cores: 3,
        max_stall_pct: 4,
      },
      {
        source: "ci-idle-load",
        labels: { runner: "popos-1" },
        members: 1,
        mean_cores: 0.5,
        share: 0.25,
        peak_cores: null,
        max_stall_pct: 5,
      },
      {
        source: "ci",
        labels: { runner: "popos-2", busy: true },
        members: 1,
        mean_cores: 0.1,
        share: 0.05,
        peak_cores: 1,
        max_stall_pct: 0,
      },
      {
        source: "ssh",
        labels: { runner: "popos-1" },
        members: 1,
        mean_cores: 0.1,
        share: 0.05,
        peak_cores: 1,
        max_stall_pct: 0,
      },
    ],
    cgroups: [
      {
        key: "boot:42",
        path: "user.slice/gh-runner-1.service",
        source: "ci",
        labels: { runner: "popos-1", busy: true },
        mean_cores: 2,
        peak_cores: 3,
        stall_pct: 4,
      },
    ],
    unattributed: { mean_cores: -0.7, share: -0.35 },
    coverage: {
      window_ms: to - from,
      covered_ms: to - from - 20_000,
      samples: 359,
      missing_readings: 1,
      gaps: [{ from, to: from + 20_000 }],
      clock_discontinuities: [{ t: from, wall_ms: 11_000, mono_ms: 10_000 }],
      boots: ["boot"],
    },
  };
}

function result(stdout: string, extra: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    stdout: Buffer.from(stdout),
    stderr: new Uint8Array(),
    exitCode: 0,
    spawned: true,
    outputTruncated: false,
    ...extra,
  };
}

async function fixture(
  body: (
    home: string,
    requests: BoundedProcessRequest[],
    processes: { run(request: BoundedProcessRequest): Promise<BoundedProcessResult> },
  ) => Promise<void>,
  response = result(JSON.stringify(report())),
) {
  const home = await mkdtemp(join(tmpdir(), "remote-runner-load-"));
  const requests: BoundedProcessRequest[] = [];
  const processes = {
    async run(request: BoundedProcessRequest) {
      requests.push(request);
      if (request.command === "ssh-keyscan") return result(`pop-os ssh-ed25519 ${key.toString("base64")}\n`);
      if (request.command === "ssh") return response;
      throw new Error(`unexpected process: ${request.command}`);
    },
  };
  try {
    await body(home, requests, processes);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("host load", () => {
  it("checks the host pin before a bounded report query without bootstrap", async () => {
    await fixture(async (home, requests, processes) => {
      const answer = await readHostLoad(profile, { from, to }, { home, processes });
      expect(answer).toEqual(report());
      expect(requests.map(({ command }) => command)).toEqual(["ssh-keyscan", "ssh"]);
      expect(requests[1]!.maxOutputBytes).toBe(HOST_LOAD_CAPTURE_BYTES);
      expect(requests[1]!.args.at(-1)).toContain("host-load-sampler.py");
      expect(requests[1]!.args.at(-1)).toContain(`${from} ${to}`);
      expect(requests[1]!.args).toContain("StrictHostKeyChecking=yes");
    });
  });

  it("fails a host pin mismatch before the report query", async () => {
    await fixture(async (home, requests, processes) => {
      await expect(
        readHostLoad(
          { ...profile, remote: { ...profile.remote, hostKeySha256: "SHA256:wrong" } },
          { from, to },
          { home, processes },
        ),
      ).rejects.toThrow(/host.key|fingerprint/iu);
      expect(requests.map(({ command }) => command)).toEqual(["ssh-keyscan"]);
    });
  });

  it.each([
    ["truncated", result("{}", { outputTruncated: true })],
    ["oversized stdout", result("x".repeat(HOST_LOAD_CAPTURE_BYTES + 1))],
    ["oversized stderr", result("{}", { stderr: new Uint8Array(HOST_LOAD_CAPTURE_BYTES + 1) })],
  ])("honours the report output limit for %s", async (_name, response) => {
    await fixture(async (home, _requests, processes) => {
      await expect(readHostLoad(profile, { from, to }, { home, processes })).rejects.toThrow(/output limit/u);
    }, response);
  });

  it("uses the exact GitHub job window and marks only that runner's CI rows", async () => {
    await fixture(async (home, requests, processes) => {
      const ghRequests: BoundedProcessRequest[] = [];
      const job = { runner_name: "popos-1", started_at: "2026-10-07T10:00:00Z", completed_at: "2026-10-07T11:00:00Z" };
      const gh = {
        async run(request: BoundedProcessRequest) {
          ghRequests.push(request);
          return result(JSON.stringify(job));
        },
      };
      const answer = await readHostLoad(profile, { githubJob: "owner/repo/123" }, { home, processes, gh });
      expect(ghRequests[0]).toMatchObject({
        command: "gh",
        args: ["api", "repos/owner/repo/actions/jobs/123"],
        maxOutputBytes: HOST_LOAD_CAPTURE_BYTES,
      });
      expect(answer.window).toEqual({ from, to });
      expect(answer.job).toEqual({ ref: "owner/repo/123", ...job });
      expect(answer.groups.map(({ marked }) => marked)).toEqual([true, true, undefined, undefined]);
      expect(answer.cgroups[0]!.marked).toBe(true);
      expect(requests[1]!.args.at(-1)).toContain(`${from} ${to}`);
    });
  });

  it("names --from/--to when gh is missing", async () => {
    await fixture(async (home, requests, processes) => {
      const gh = {
        async run() {
          return result("", { spawned: false, spawnErrorCode: "ENOENT", exitCode: 127 });
        },
      };
      await expect(readHostLoad(profile, { githubJob: "owner/repo/123" }, { home, processes, gh })).rejects.toThrow(
        /gh.*--from.*--to/u,
      );
      expect(requests.map(({ command }) => command)).not.toContain("ssh");
    });
  });

  it("names --from/--to for an unfinished GitHub job", async () => {
    await fixture(async (home, requests, processes) => {
      const gh = {
        async run() {
          return result(
            JSON.stringify({ runner_name: "popos-1", started_at: "2026-10-07T10:00:00Z", completed_at: null }),
          );
        },
      };
      await expect(readHostLoad(profile, { githubJob: "owner/repo/123" }, { home, processes, gh })).rejects.toThrow(
        /completed_at.*--from.*--to/u,
      );
      expect(requests.map(({ command }) => command)).not.toContain("ssh");
    });
  });

  it("enforces the 24-hour cap before SSH and accepts exactly 24 hours", async () => {
    expect(parseLoadWindow("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z")).toEqual({
      from: Date.parse("2026-10-07T00:00:00Z"),
      to: Date.parse("2026-10-08T00:00:00Z"),
    });
    await fixture(async (home, requests, processes) => {
      await expect(readHostLoad(profile, { from, to: from + 86_400_001 }, { home, processes })).rejects.toThrow(
        /24 h/u,
      );
      expect(requests).toEqual([]);
    });
  });

  it("enforces the 24-hour cap on GitHub job windows", async () => {
    await fixture(async (home, requests, processes) => {
      const gh = {
        async run() {
          return result(
            JSON.stringify({
              runner_name: "popos-1",
              started_at: "2026-10-07T00:00:00Z",
              completed_at: "2026-10-08T00:00:01Z",
            }),
          );
        },
      };
      await expect(readHostLoad(profile, { githubJob: "owner/repo/123" }, { home, processes, gh })).rejects.toThrow(
        /24 h/u,
      );
      expect(requests.map(({ command }) => command)).not.toContain("ssh");
    });
  });

  it.each([
    ["not JSON", "not JSON"],
    ["unsupported version", JSON.stringify({ ...report(), v: 2 })],
    ["missing host fields", JSON.stringify({ ...report(), host: {} })],
    ["malformed cgroup", JSON.stringify({ ...report(), cgroups: [{}] })],
  ])("rejects malformed or unsupported report JSON: %s", async (_name, response) => {
    await fixture(async (home, _requests, processes) => {
      await expect(readHostLoad(profile, { from, to }, { home, processes })).rejects.toThrow(
        /invalid host load report.*v1/u,
      );
    }, result(response));
  });

  it("formats signed unattributed load, host PSI, coverage and optional cgroups", async () => {
    await fixture(async (home, _requests, processes) => {
      const answer = await readHostLoad(profile, { from, to }, { home, processes });
      const summary = formatHostLoad(answer, false);
      expect(summary).toContain("MAX STALL");
      const header = summary.split("\n").find((line) => line.startsWith("SOURCE"))!;
      const row = summary.split("\n").find((line) => line.startsWith("ci "))!;
      expect(row.indexOf("2.000")).toBe(header.indexOf("MEAN CORES"));
      expect(summary).toContain("-0.700");
      expect(summary).toContain("CPU some/full");
      expect(summary).toContain("IO some/full");
      expect(summary).toContain("Memory some/full");
      expect(summary).toContain("Gaps:");
      expect(summary).toContain("Clock discontinuities:");
      expect(summary).not.toContain("boot:42");
      expect(formatHostLoad(answer, true)).toContain("boot:42");
    });
  });
});
it("accepts reports larger than 256 KiB within the 8 MiB capture limit", async () => {
  const response = result(JSON.stringify({ ...report(), padding: "x".repeat(256 * 1024) }));
  await fixture(async (home, requests, processes) => {
    await expect(readHostLoad(profile, { from, to }, { home, processes })).resolves.toMatchObject(report());
    expect(requests[1]!.maxOutputBytes).toBe(8 * 1024 * 1024);
  }, response);
});

it.each(["./repo/123", ".../repo/123", "owner/./123", "owner/.../123"])(
  "rejects dots-only GitHub path segments before any process call: %s",
  async (githubJob) => {
    await fixture(async (home, requests, processes) => {
      await expect(readHostLoad(profile, { githubJob }, { home, processes })).rejects.toThrow(/invalid --github-job/u);
      expect(requests).toEqual([]);
    });
  },
);
