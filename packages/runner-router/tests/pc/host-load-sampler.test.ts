import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("pc/host-load-sampler.py");
const day = Date.UTC(2026, 9, 7);
const session = "user.slice/user-1000.slice/session-1.scope";
const runner = "user.slice/user-1000.slice/user@1000.service/app.slice/gh-runner-1.service";
const secret = "SECRET_DO_NOT_RECORD_123456789";
let root: string;
let env: NodeJS.ProcessEnv;

function write(path: string, value: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function host(busy = 100_000_000) {
  write(join(root, "cg/cpu.stat"), `usage_usec ${busy}\n`);
  for (const metric of ["cpu", "io", "memory"]) {
    write(join(root, `cg/${metric}.pressure`), "some avg10=0 total=1000000\nfull avg10=0 total=500000\n");
  }
}

function cgroup(path: string, pids: number[], usage = 1_000_000) {
  write(join(root, "cg", path, "cgroup.procs"), pids.join("\n"));
  write(join(root, "cg", path, "cpu.stat"), `usage_usec ${usage}\n`);
  write(join(root, "cg", path, "memory.current"), "4096\n");
  write(join(root, "cg", path, "cpu.pressure"), "some avg10=0 total=100000\nfull avg10=0 total=0\n");
}

function proc(pid: number, comm: string, argv: string[], cwd: string, runId = "", start = 10) {
  write(join(root, `proc/${pid}/stat`), `${pid} (${comm}) S ${Array(18).fill("0").join(" ")} ${start} 0\n`);
  write(join(root, `proc/${pid}/cmdline`), argv.join("\0") + "\0");
  write(join(root, `proc/${pid}/environ`), `TOKEN=${secret}\0REMOTE_RUNNER_RUN_ID=${runId}\0`);
  const link = join(root, `proc/${pid}/cwd`);
  rmSync(link, { force: true });
  symlinkSync(cwd, link);
}

function workspace() {
  return join(root, "workspace/consumer/profile/clients/0123456789abcdef01234567/identity");
}

function run(args: string[], patch = "") {
  const driver = `import sys, runpy, os, time, builtins, pathlib, errno\nsys.argv = ${JSON.stringify([script, ...args])}\n${patch}\nrunpy.run_path(sys.argv[0], run_name="__main__")`;
  return spawnSync("python3", ["-c", driver], { env, encoding: "utf8", timeout: 12_000 });
}

function once(now = day, mono = 1_000_000_000, patch = "") {
  const result = run(["run", "--once", "--now", String(now), "--mono", String(mono), "--boot", "boot-a"], patch);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  return result;
}

function ticks(count: number, advance: string[]) {
  const patch = [
    "tick = 0",
    `time.time_ns = lambda: (${day} + tick * 10000) * 1000000`,
    "time.monotonic_ns = lambda: (tick + 1) * 10000000000",
    "def advance(seconds):",
    " global tick",
    " tick += 1",
    ...advance.map((line) => ` ${line}`),
    "time.sleep = advance",
  ].join("\n");
  const result = run(["run", "--count", String(count), "--interval", "0.001"], patch);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function lines(date = "2026-10-07") {
  return readFileSync(join(root, `state/${date}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function report(from: number, to: number) {
  const result = run(["report", "--from", String(from), "--to", String(to)]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function source(key: string, t: number, mono: number, type = "ssh", labels: Record<string, unknown> = {}) {
  return { v: 1, kind: "source", boot: key.split(":")[0], mono, t, key, path: session, source: type, labels };
}

function sample(t: number, mono: number, busy: number, usage: number | null, boot = "boot-a", stall = 0) {
  return {
    v: 1,
    kind: "sample",
    boot,
    t,
    mono,
    host: {
      busy_usec: busy,
      cpu_some_us: stall,
      cpu_full_us: stall / 2,
      io_some_us: stall,
      io_full_us: 0,
      mem_some_us: 0,
      mem_full_us: 0,
      load1: 1,
    },
    cg: [[`${boot}:1`, usage, 4096, stall]],
  };
}

function log(date: string, records: unknown[], zipped = false) {
  const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  write(join(root, `state/${date}.jsonl${zipped ? ".gz" : ""}`), zipped ? gzipSync(text) : text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-load-"));
  env = {
    ...process.env,
    HOME: join(root, "home"),
    HOST_LOAD_CONFIG: join(root, "sampler.env"),
    CGROUP_ROOT: join(root, "cg"),
    PROC_ROOT: join(root, "proc"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    DOCKER_CONTEXT: secret,
    DOCKER_TLS_VERIFY: secret,
    DOCKER_HOST: secret,
  };
  write(join(root, "sampler.env"), `WORKSPACE_ROOT="${join(root, "workspace")}"\nSTATE_DIR=${join(root, "state")}\n`);
  write(join(root, "proc/sys/kernel/random/boot_id"), "boot-a\n");
  write(join(root, "proc/loadavg"), "1.0 0 0 1/1 1\n");
  write(join(root, "proc/stat"), "cpu 0\ncpu0 0\ncpu1 0\n");
  host();
  write(
    join(root, "bin/docker"),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> ${JSON.stringify(join(root, "docker-calls"))}\n/usr/bin/env > ${JSON.stringify(join(root, "docker-env"))}\nprintf '/database postgres:16\\n'\n`,
  );
  chmodSync(join(root, "bin/docker"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("host-load sampler", () => {
  it("refreshes shell facts after exec with unchanged pid and starttime", () => {
    const childScope = session.replace("session-1", "session-2");
    cgroup(childScope, [4]);
    proc(4, "child", ["child"], "/outside", "run-exec");
    cgroup(session, [2]);
    proc(2, "sh", ["sh", "-ceu", secret], "/outside");
    ticks(2, [
      `pathlib.Path(${JSON.stringify(join(root, "proc/2/stat"))}).write_text('2 (node-MainThread) S ' + '0 ' * 18 + '10 0')`,
      `pathlib.Path(${JSON.stringify(join(root, "proc/2/cmdline"))}).write_bytes(b'node\\0/x/remote-launcher.mjs\\0')`,
      `pathlib.Path(${JSON.stringify(join(root, "proc/2/environ"))}).write_bytes(b'REMOTE_RUNNER_RUN_ID=run-exec\\0')`,
      `os.unlink(${JSON.stringify(join(root, "proc/2/cwd"))})`,
      `os.symlink(${JSON.stringify(workspace())}, ${JSON.stringify(join(root, "proc/2/cwd"))})`,
    ]);
    const sources = lines().filter((line) => line.kind === "source" && line.t === day + 10_000);
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.source).toBe("remote-runner");
      expect(source.labels).toEqual({
        consumer: "consumer",
        profile: "profile",
        client: "0123456789abcdef01234567",
        identity: "identity",
        runId: "run-exec",
      });
    }
    expect(JSON.stringify(lines())).not.toContain(secret);
  });

  it("shares launcher labels with run-id members in an earlier different scope", () => {
    cgroup(session, [4]);
    proc(4, "child", ["child"], "/outside", "run-cross-scope");
    const launcherScope = session.replace("session-1", "session-2");
    cgroup(launcherScope, [2]);
    proc(2, "node-MainThread", ["node", "/x/remote-launcher.mjs"], workspace(), "run-cross-scope");
    once();
    const sources = lines().filter((line) => line.kind === "source");
    expect(sources).toHaveLength(2);
    expect(sources.map((line) => line.source)).toEqual(["remote-runner", "remote-runner"]);
    for (const source of sources) {
      expect(source.labels).toEqual({
        consumer: "consumer",
        profile: "profile",
        client: "0123456789abcdef01234567",
        identity: "identity",
        runId: "run-cross-scope",
      });
    }
  });

  it("captures host readings before slow classification", () => {
    cgroup("system.slice/docker-abcdef.scope", []);
    write(
      join(root, "bin/docker"),
      `#!/usr/bin/env python3\nfrom pathlib import Path\nPath(${JSON.stringify(join(root, "cg/cpu.stat"))}).write_text('usage_usec 999999999')\nPath(${JSON.stringify(join(root, "cg/cpu.pressure"))}).write_text('some total=999999999\\nfull total=999999999\\n')\nPath(${JSON.stringify(join(root, "proc/loadavg"))}).write_text('99 0 0 1/1 1')\nprint('/database postgres:16')\n`,
    );
    once();
    expect(lines().at(-1).host).toMatchObject({ busy_usec: 100_000_000, cpu_some_us: 1_000_000, load1: 1 });
  });

  it.each(["missing", "array", "null"])("retries %s runner-name lookups next tick", (kind) => {
    const path = join(root, "home/actions-runner-1/.runner");
    if (kind !== "missing") write(path, kind === "array" ? "[]" : "null");
    cgroup(runner, []);
    ticks(2, [
      `pathlib.Path(${JSON.stringify(dirname(path))}).mkdir(parents=True, exist_ok=True)`,
      `pathlib.Path(${JSON.stringify(path)}).write_text('{"agentName":"popos-retry"}')`,
    ]);
    expect(
      lines()
        .filter((line) => line.kind === "source")
        .map((line) => line.labels.runner),
    ).toEqual(["gh-runner-1.service", "popos-retry"]);
  });

  it.each(["boot", "inode"])("refreshes runner names when the cgroup %s changes", (change) => {
    const path = join(root, "home/actions-runner-1/.runner");
    write(path, '{"agentName":"popos-before"}');
    cgroup(runner, []);
    const scope = JSON.stringify(join(root, "cg", runner));
    ticks(2, [
      `pathlib.Path(${JSON.stringify(path)}).write_text('{"agentName":"popos-after"}')`,
      ...(change === "boot"
        ? [`pathlib.Path(${JSON.stringify(join(root, "proc/sys/kernel/random/boot_id"))}).write_text('boot-b')`]
        : [
            "import shutil",
            `os.rename(${scope}, ${scope} + '.previous')`,
            `shutil.copytree(${scope} + '.previous', ${scope})`,
          ]),
    ]);
    expect(
      lines()
        .filter((line) => line.kind === "source")
        .map((line) => line.labels.runner),
    ).toEqual(["popos-before", "popos-after"]);
  });

  it("keeps the worker-exit interval in ci before classifying idle load", () => {
    write(join(root, "home/actions-runner-1/.runner"), '{"agentName":"popos-1"}');
    cgroup(runner, [1]);
    proc(1, "Runner.Worker", ["Runner.Worker"], root);
    ticks(3, [
      `pathlib.Path(${JSON.stringify(join(root, "cg", runner, "cgroup.procs"))}).write_text('')`,
      `pathlib.Path(${JSON.stringify(join(root, "cg", runner, "cpu.stat"))}).write_text('usage_usec ' + str(1000000 + tick * 3000000))`,
    ]);
    expect(
      lines()
        .filter((line) => line.kind === "source")
        .map((line) => [line.source, line.labels.busy]),
    ).toEqual([
      ["ci", true],
      ["ci", false],
      ["ci-idle-load", undefined],
    ]);
    expect(report(day, day + 10_000).groups[0]).toMatchObject({
      source: "ci",
      labels: { busy: false },
      mean_cores: 0.3,
    });
  });

  it("labels ssh with the first non-sshd member and falls back to sshd", () => {
    cgroup(session, [1, 2]);
    proc(1, "sshd", ["sshd"], "/outside");
    proc(2, "bash", ["bash"], "/outside");
    const fallback = session.replace("session-1", "session-2");
    cgroup(fallback, [3]);
    proc(3, "sshd", ["sshd"], "/outside");
    once();
    const sources = lines().filter((line) => line.kind === "source");
    expect(sources.find((line) => line.path === session).labels).toEqual({ comm: "bash" });
    expect(sources.find((line) => line.path === fallback).labels).toEqual({ comm: "sshd" });
  });

  it.each([
    ["", {}],
    ["consumer", { consumer: "consumer" }],
    ["consumer/profile", { consumer: "consumer", profile: "profile" }],
    ["consumer/profile/other/deep", { consumer: "consumer", profile: "profile" }],
    [
      "consumer/profile/clients/client/identity/deep",
      { consumer: "consumer", profile: "profile", client: "client", identity: "identity" },
    ],
  ])("classifies every workspace cwd prefix as prep: %s", (path, labels) => {
    cgroup(session, [1]);
    proc(1, "bash", ["bash", secret], join(root, "workspace", path));
    once();
    expect(lines()[0]).toMatchObject({ source: "remote-runner-prep", labels });
    expect(lines()[0].labels).toEqual(labels);
    expect(JSON.stringify(lines())).not.toContain(root);
    expect(JSON.stringify(lines())).not.toContain(secret);
  });

  it.each(["rotate", "restore"])("fsyncs the state directory before deleting the %s source", (operation) => {
    if (operation === "rotate") log("2026-10-06", [sample(day - 10_000, 0, 0, 0)]);
    else log("2026-10-07", [sample(day, 0, 0, 0)], true);
    const patch = `original_replace = os.replace\noriginal_fsync = os.fsync\noriginal_unlink = pathlib.Path.unlink\nneeds_sync = False\ndef replaced(*args):\n global needs_sync\n original_replace(*args)\n needs_sync = True\ndef synced(fd):\n global needs_sync\n import stat\n if stat.S_ISDIR(os.fstat(fd).st_mode): needs_sync = False\n original_fsync(fd)\ndef deleted(path, *args, **kwargs):\n assert not needs_sync, 'rename not durable'\n return original_unlink(path, *args, **kwargs)\nos.replace = replaced\nos.fsync = synced\npathlib.Path.unlink = deleted`;
    once(day, 1_000_000_000, patch);
  });

  it.each(["cpu_some_us", "cpu_full_us", "io_some_us", "io_full_us", "mem_some_us", "mem_full_us"])(
    "excludes null host PSI endpoints from the field denominator: %s",
    (field) => {
      const records = [0, 1, 2, 3, 4].map((index) =>
        sample(day + index * 10_000, index * 10_000_000_000, index * 10_000_000, 0),
      );
      for (const [index, record] of records.entries()) {
        Object.assign(record.host, { [field]: index === 1 ? null : index * 1_000_000 });
      }
      log("2026-10-07", records);
      const value = report(day, day + 40_000);
      expect(value.coverage.missing_readings).toBe(2);
      expect(value.coverage.covered_ms).toBe(40_000);
      expect(value.host.psi[field.replace("_us", "_pct")]).toBe(10);
      expect(value.host.psi[field === "cpu_some_us" ? "cpu_full_pct" : "cpu_some_pct"]).toBe(0);
    },
  );

  it("uses each cgroup covered elapsed for stalls while keeping means window-based", () => {
    const first = sample(day, 0, 0, 0);
    const second = sample(day + 10_000, 10_000_000_000, 20_000_000, 10_000_000, "boot-a", 2_000_000);
    const third = sample(day + 20_000, 20_000_000_000, 40_000_000, null, "boot-a", 3_000_000);
    const fourth = sample(day + 30_000, 30_000_000_000, 60_000_000, 30_000_000, "boot-a", 4_000_000);
    for (const [index, record] of [first, second, third, fourth].entries()) {
      record.cg.push(["boot-a:2", index * 5_000_000, 4096, index * 1_000_000]);
    }
    log("2026-10-07", [source("boot-a:1", day, 0), source("boot-a:2", day, 0), first, second, third, fourth]);
    const value = report(day, day + 30_000);
    expect(value.coverage.missing_readings).toBe(2);
    expect(value.cgroups.find((row: { key: string }) => row.key === "boot-a:1")).toMatchObject({
      mean_cores: 0.333,
      stall_pct: 20,
    });
    expect(value.groups[0]).toMatchObject({ mean_cores: 0.833, max_stall_pct: 20 });
  });

  it("attributes a newly created cgroup from zero counters", () => {
    const first = sample(day, 0, 0, 0);
    first.cg = [];
    log("2026-10-07", [
      first,
      source("boot-a:1", day + 10_000, 10_000_000_000),
      sample(day + 10_000, 10_000_000_000, 10_000_000, 6_000_000, "boot-a", 2_000_000),
    ]);
    const value = report(day, day + 10_000);
    expect(value.cgroups).toHaveLength(1);
    expect(value.cgroups[0]).toMatchObject({ mean_cores: 0.6, peak_cores: 0.6, stall_pct: 20 });
    expect(value.groups[0]).toMatchObject({ mean_cores: 0.6, max_stall_pct: 20 });
    expect(value.coverage.missing_readings).toBe(0);
  });

  it("records a long interval with missing host busy once as a gap", () => {
    const last = sample(day + 20_000, 20_000_000_000, 20_000_000, 0);
    Object.assign(last.host, { busy_usec: null });
    log("2026-10-07", [sample(day, 0, 0, 0), last]);
    const value = report(day, day + 20_000);
    expect(value.coverage.gaps).toEqual([{ from: day, to: day + 20_000 }]);
    expect(value.coverage.missing_readings).toBe(1);
  });

  it("classifies every source, BOM runner, argv[1] launcher, prep and root-owned EACCES member privately", () => {
    write(join(root, "home/actions-runner-1/.runner"), '\uFEFF{"agentName":"popos-1"}');
    cgroup(runner, [1]);
    proc(1, "Runner.Worker", ["Runner.Worker", secret], root);
    cgroup(session, [2, 3]);
    proc(2, "node-MainThread", ["node", "/private/remote-launcher.mjs", secret], workspace(), "run-1");
    proc(3, "sshd", ["sshd", secret], "/private/root");
    for (const [id, comm, cwd, runId] of [
      [2, "mutagen-agent", root, ""],
      [3, "bash", workspace(), ""],
      [4, "cosmic-session", root, ""],
      [5, "worker", root, "run-orphan"],
    ] as const) {
      cgroup(session.replace("session-1", `session-${id}`), [10 + id]);
      proc(10 + id, comm, [comm, secret], cwd, runId);
    }
    cgroup("system.slice/docker-abcdef.scope", []);
    cgroup("user.slice/host-load-sampler.service", []);
    const patch = `original_open = builtins.open\ndef guarded_open(path, *args, **kwargs):\n if str(path).endswith('/3/environ'): raise PermissionError(errno.EACCES, 'denied')\n return original_open(path, *args, **kwargs)\nbuiltins.open = guarded_open\noriginal_link = os.readlink\ndef guarded_link(path, *args, **kwargs):\n if str(path).endswith('/3/cwd'): raise PermissionError(errno.EACCES, 'denied')\n return original_link(path, *args, **kwargs)\nos.readlink = guarded_link`;
    const result = once(day, 1_000_000_000, patch);
    expect(result.stderr).toBe("");
    const records = lines();
    const sources = records.filter((line) => line.kind === "source");
    expect(sources.map((line) => line.source).sort()).toEqual(
      [
        "ci",
        "docker",
        "mutagen",
        "remote-runner",
        "remote-runner-orphan",
        "remote-runner-prep",
        "sampler",
        "ssh",
      ].sort(),
    );
    expect(sources.find((line) => line.source === "ci").labels).toEqual({ runner: "popos-1", busy: true });
    expect(sources.find((line) => line.source === "remote-runner").labels).toEqual({
      consumer: "consumer",
      profile: "profile",
      client: "0123456789abcdef01234567",
      identity: "identity",
      runId: "run-1",
    });
    expect(sources.find((line) => line.source === "ssh").labels).toEqual({ comm: "cosmic-session" });
    expect(sources.find((line) => line.source === "remote-runner-prep").labels.runId).toBeUndefined();
    expect(sources.find((line) => line.source === "remote-runner-orphan").labels).toEqual({ runId: "run-orphan" });
    expect(sources.find((line) => line.source === "docker").labels).toEqual({
      name: "/database",
      image: "postgres:16",
    });
    expect(records.at(-1).cg.every((reading: unknown[]) => reading[1] === 1_000_000)).toBe(true);
    expect(records.at(-1).host.busy_usec).toBe(100_000_000);
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, "docker-calls"), "utf8").split("\0").slice(0, -1)).toEqual([
      "inspect",
      "--format",
      "{{.Name}} {{.Config.Image}}",
      "abcdef",
    ]);
    const dockerEnv = readFileSync(join(root, "docker-env"), "utf8");
    expect(dockerEnv).toContain("DOCKER_HOST=unix:///var/run/docker.sock\n");
    expect(dockerEnv).not.toMatch(/^DOCKER_CONTEXT=/m);
    expect(dockerEnv).not.toMatch(/^DOCKER_TLS_VERIFY=/m);
    expect(dockerEnv).not.toContain(secret);
    const output = result.stdout + result.stderr + JSON.stringify(records) + JSON.stringify(report(day, day + 10_000));
    expect(output).not.toContain(secret);
    expect(output).not.toContain("/private");
    expect(output).not.toContain(join(root, "home"));
  });

  it("caches pid facts and docker once, then preserves chdir orphan identity across midnight", () => {
    cgroup(session, [2, 4]);
    proc(2, "node-MainThread", ["node", "/x/remote-launcher.mjs"], workspace(), "run-1");
    proc(4, "child", ["child"], "/outside", "run-1");
    cgroup("system.slice/docker-abcdef.scope", []);
    const patch = `tick = 0\nreads = {}\noriginal_open = builtins.open\ndef counted_open(path, *args, **kwargs):\n p = str(path)\n if p.endswith(('/cmdline', '/environ')):\n  reads[p] = reads.get(p, 0) + 1\n  if reads[p] > 1: raise RuntimeError('facts reread')\n return original_open(path, *args, **kwargs)\nbuiltins.open = counted_open\ntime.time_ns = lambda: (${day} - 5000 + tick * 10000) * 1000000\ntime.monotonic_ns = lambda: (tick + 1) * 10000000000\ndef advance(seconds):\n global tick\n tick += 1\n import shutil\n shutil.rmtree(${JSON.stringify(join(root, "proc/2"))})\n os.unlink(${JSON.stringify(join(root, "proc/4/cwd"))})\n os.symlink('/outside', ${JSON.stringify(join(root, "proc/4/cwd"))})\n with original_open(${JSON.stringify(join(root, "cg", session, "cgroup.procs"))}, 'w') as f: f.write('4')\ntime.sleep = advance`;
    const result = run(["run", "--count", "2", "--interval", "0.001"], patch);
    expect(result.status, result.stderr).toBe(0);
    const today = lines();
    expect(today[0].kind).toBe("source");
    const orphan = today.find((line) => line.source === "remote-runner-orphan");
    expect(orphan.labels).toEqual({
      consumer: "consumer",
      profile: "profile",
      client: "0123456789abcdef01234567",
      identity: "identity",
      runId: "run-1",
    });
    expect(today.filter((line) => line.kind === "source")).toHaveLength(2);
    expect(existsSync(join(root, "state/2026-10-06.jsonl.gz"))).toBe(true);
    expect(gunzipSync(readFileSync(join(root, "state/2026-10-06.jsonl.gz"))).toString()).toContain(
      '"source":"remote-runner"',
    );
    expect(
      readFileSync(join(root, "docker-calls"), "utf8")
        .split("\0")
        .filter((arg) => arg === "inspect"),
    ).toHaveLength(1);
  });

  it.each(["pid reused", "launcher vanished"])("drops classification facts when %s between stat reads", (race) => {
    cgroup(session, [2]);
    proc(2, "node-MainThread", ["node", "/x/remote-launcher.mjs"], workspace(), "run-1");
    const patch = `original_open = builtins.open\ndef race_open(path, *args, **kwargs):\n p = str(path)\n if p.endswith('/2/environ'):\n  ${race === "pid reused" ? `with original_open(${JSON.stringify(join(root, "proc/2/stat"))}, 'w') as f: f.write('2 (bash) S ' + '0 ' * 18 + '999 0')` : `os.unlink(${JSON.stringify(join(root, "proc/2/stat"))})`}\n return original_open(path, *args, **kwargs)\nbuiltins.open = race_open`;
    once(day, 1_000_000_000, patch);
    expect(lines()[0].source).toBe("ssh");
    expect(lines()[0].labels).toEqual({});
    expect(JSON.stringify(lines())).not.toContain("run-1");
  });

  it("records null for a cgroup counter vanished mid-read, never zero", () => {
    cgroup(session, []);
    const patch = `original_open = builtins.open\ndef gone_open(path, *args, **kwargs):\n if str(path).endswith('session-1.scope/cpu.stat'): raise FileNotFoundError(errno.ENOENT, 'gone')\n return original_open(path, *args, **kwargs)\nbuiltins.open = gone_open`;
    once(day, 1_000_000_000, patch);
    expect(lines().at(-1).cg[0].slice(1)).toEqual([null, 4096, 100000]);
  });

  it("classifies ci-idle-load above 0.2 cores and attributes at interval end", () => {
    write(join(root, "home/actions-runner-1/.runner"), '{"agentName":"popos-1"}');
    cgroup(runner, []);
    const patch = `tick = 0\ntime.time_ns = lambda: (${day} + tick * 10000) * 1000000\ntime.monotonic_ns = lambda: (tick + 1) * 10000000000\ndef advance(seconds):\n global tick\n tick += 1\n with open(${JSON.stringify(join(root, "cg", runner, "cpu.stat"))}, 'w') as f: f.write('usage_usec 4000000')\ntime.sleep = advance`;
    const result = run(["run", "--count", "2", "--interval", "0.001"], patch);
    expect(result.status, result.stderr).toBe(0);
    expect(
      lines()
        .filter((line) => line.kind === "source")
        .map((line) => line.source),
    ).toEqual(["ci", "ci-idle-load"]);
    expect(report(day, day + 10_000).groups[0]).toMatchObject({
      source: "ci-idle-load",
      labels: { runner: "popos-1" },
      mean_cores: 0.3,
    });
  });

  it("reports boot change, clock step, long-gap means and null peaks", () => {
    log("2026-10-07", [
      source("boot-a:1", day, 0),
      sample(day, 0, 0, 0),
      sample(day + 30_000, 20_000_000_000, 20_000_000, 10_000_000),
      source("boot-b:1", day + 40_000, 30_000_000_000),
      sample(day + 40_000, 30_000_000_000, 30_000_000, 1_000_000, "boot-b"),
    ]);
    const value = report(day, day + 40_000);
    expect(value.coverage).toEqual({
      window_ms: 40_000,
      covered_ms: 20_000,
      samples: 3,
      missing_readings: 0,
      gaps: [
        { from: day, to: day + 30_000 },
        { from: day + 30_000, to: day + 40_000 },
      ],
      clock_discontinuities: [{ t: day + 30_000, wall_ms: 30_000, mono_ms: 20_000 }],
      boots: ["boot-a", "boot-b"],
    });
    expect(value.host.busy_cores_mean).toBe(1);
    expect(value.groups[0]).toMatchObject({ mean_cores: 0.5, peak_cores: null });
  });

  it("uses monotonic deltas through backward and stationary wall clocks", () => {
    log("2026-10-07", [
      source("boot-a:1", day + 5000, 0),
      sample(day + 5000, 0, 0, 0),
      sample(day + 3000, 10_000_000_000, 10_000_000, 5_000_000),
      sample(day + 3000, 20_000_000_000, 20_000_000, 10_000_000),
    ]);
    const value = report(day, day + 10_000);
    expect(value.coverage.covered_ms).toBe(20_000);
    expect(value.coverage.clock_discontinuities).toEqual([
      { t: day + 3000, wall_ms: -2000, mono_ms: 10_000 },
      { t: day + 3000, wall_ms: 0, mono_ms: 10_000 },
    ]);
    expect(value.groups[0]).toMatchObject({ mean_cores: 0.5, peak_cores: 0.5 });
  });

  it("recovers interrupted gzip before rename and prunes stale temp files on startup", () => {
    log("2026-10-06", [sample(day - 10_000, 0, 0, 0)]);
    const failed = run(
      ["run", "--once", "--now", String(day)],
      `os.replace = lambda *args: (_ for _ in ()).throw(OSError('interrupted'))`,
    );
    expect(failed.status).toBe(1);
    expect(existsSync(join(root, "state/2026-10-06.jsonl"))).toBe(true);
    expect(readdirSync(join(root, "state")).some((name) => name.endsWith(".tmp"))).toBe(true);
    once();
    expect(existsSync(join(root, "state/2026-10-06.jsonl"))).toBe(false);
    expect(
      JSON.parse(
        gunzipSync(readFileSync(join(root, "state/2026-10-06.jsonl.gz")))
          .toString()
          .trim(),
      ).kind,
    ).toBe("sample");
    expect(readdirSync(join(root, "state")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("preserves archived samples when a clock step returns to the preceding UTC day", () => {
    once(day - 5000, 1_000_000_000);
    once(day + 5000, 11_000_000_000);
    once(day - 1000, 21_000_000_000);
    once(day + 10_000, 31_000_000_000);
    const archived = gunzipSync(readFileSync(join(root, "state/2026-10-06.jsonl.gz")))
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(archived.filter((line) => line.kind === "sample").map((line) => line.mono)).toEqual([
      1_000_000_000, 21_000_000_000,
    ]);
    const value = report(day - 5000, day + 10_000);
    expect(value.coverage.samples).toBe(4);
    expect(value.coverage.covered_ms).toBe(30_000);
    expect(value.coverage.clock_discontinuities).toEqual([{ t: day - 1000, wall_ms: -6000, mono_ms: 10_000 }]);
  });

  it("prunes oldest days by 30-day age and the 300 MB byte budget", () => {
    log("2026-09-06", [], true);
    log("2026-09-08", [], true);
    log("2026-10-07", [sample(day, 0, 0, 0)]);
    once();
    expect(existsSync(join(root, "state/2026-09-06.jsonl.gz"))).toBe(false);
    expect(existsSync(join(root, "state/2026-09-08.jsonl.gz"))).toBe(true);
    log("2026-10-05", [], true);
    log("2026-10-06", [], true);
    truncateSync(join(root, "state/2026-10-05.jsonl.gz"), 160_000_000);
    truncateSync(join(root, "state/2026-10-06.jsonl.gz"), 160_000_000);
    once(day + 10_000, 11_000_000_000);
    expect(existsSync(join(root, "state/2026-09-08.jsonl.gz"))).toBe(false);
    expect(existsSync(join(root, "state/2026-10-05.jsonl.gz"))).toBe(false);
    expect(existsSync(join(root, "state/2026-10-06.jsonl.gz"))).toBe(true);
    expect(
      readdirSync(join(root, "state")).reduce((sum, name) => sum + statSync(join(root, "state", name)).size, 0),
    ).toBeLessThanOrEqual(300_000_000);
  });

  it("clips a straddle across gzip/raw days, ignores partial tail and keeps negative unattributed", () => {
    log(
      "2026-10-06",
      [source("boot-a:1", day - 10_000, 0, "remote-runner", { runId: "run-1" }), sample(day - 10_000, 0, 0, 0)],
      true,
    );
    log("2026-10-07", [
      source("boot-a:1", day, 10_000_000_000, "remote-runner-orphan", { runId: "run-1" }),
      sample(day, 10_000_000_000, 10_000_000, 20_000_000, "boot-a", 1_000_000),
      sample(day + 10_000, 20_000_000_000, 20_000_000, 40_000_000, "boot-a", 2_000_000),
    ]);
    const file = join(root, "state/2026-10-07.jsonl");
    write(file, readFileSync(file, "utf8") + '{"kind":');
    const value = report(day - 5000, day + 10_000);
    expect(value).toEqual({
      v: 1,
      window: { from: day - 5000, to: day + 10_000 },
      host: {
        ncpu: 2,
        busy_cores_mean: 1,
        busy_pct: 50,
        psi: { cpu_some_pct: 10, cpu_full_pct: 5, io_some_pct: 10, io_full_pct: 0, mem_some_pct: 0, mem_full_pct: 0 },
      },
      groups: [
        {
          source: "remote-runner-orphan",
          labels: { runId: "run-1" },
          members: 1,
          mean_cores: 2,
          share: 2,
          peak_cores: 2,
          max_stall_pct: 10,
        },
      ],
      cgroups: [
        {
          key: "boot-a:1",
          path: session,
          source: "remote-runner-orphan",
          labels: { runId: "run-1" },
          mean_cores: 2,
          peak_cores: 2,
          stall_pct: 10,
        },
      ],
      unattributed: { mean_cores: -1, share: -1 },
      coverage: {
        window_ms: 15000,
        covered_ms: 15000,
        samples: 2,
        missing_readings: 0,
        gaps: [],
        clock_discontinuities: [],
        boots: ["boot-a"],
      },
    });
  });

  it("drops null intervals, uses max member stalls, sums group peaks and sorts groups", () => {
    const first = sample(day, 0, 0, 0);
    const second = sample(day + 10_000, 10_000_000_000, 40_000_000, 10_000_000, "boot-a", 1_000_000);
    const third = sample(day + 20_000, 20_000_000_000, 80_000_000, null, "boot-a", 2_000_000);
    first.cg.push(["boot-a:2", 0, 4096, 0], ["boot-a:3", 0, 4096, 0]);
    second.cg.push(["boot-a:2", 20_000_000, 4096, 2_000_000], ["boot-a:3", 5_000_000, 4096, 0]);
    third.cg.push(["boot-a:2", 40_000_000, 4096, 4_000_000], ["boot-a:3", 10_000_000, 4096, 0]);
    log("2026-10-07", [
      source("boot-a:1", day, 0),
      source("boot-a:2", day, 0),
      source("boot-a:3", day, 0, "sampler"),
      first,
      second,
      third,
    ]);
    const value = report(day, day + 20_000);
    expect(value.coverage.missing_readings).toBe(1);
    expect(value.groups[0]).toMatchObject({
      source: "ssh",
      members: 2,
      mean_cores: 2.5,
      peak_cores: 3,
      max_stall_pct: 20,
    });
    expect(value.groups[1]).toMatchObject({ source: "sampler", mean_cores: 0.5 });
  });

  it("cuts docker inspect hangs at two seconds and records only sanitized failure status", () => {
    cgroup("system.slice/docker-abcdef.scope", []);
    write(
      join(root, "bin/docker"),
      `#!/usr/bin/env python3\nimport time, sys\nprint('${secret}', flush=True)\nprint('${secret}', file=sys.stderr, flush=True)\ntime.sleep(20)\n`,
    );
    const start = Date.now();
    const result = once();
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result.stderr).toBe("docker inspect exit=none status=timeout\n");
    expect(Buffer.byteLength(result.stderr.trim())).toBeLessThanOrEqual(200);
    expect(lines()[0].labels).toEqual({});
    expect(result.stdout + result.stderr + JSON.stringify(lines())).not.toContain(secret);
  });

  it("sanitizes docker exit failures and rejects extra successful output", () => {
    cgroup("system.slice/docker-abcdef.scope", []);
    write(
      join(root, "bin/docker"),
      `#!/usr/bin/env python3\nimport sys\nprint('${secret}')\nprint('${secret}', file=sys.stderr)\nsys.exit(7)\n`,
    );
    const failed = once();
    expect(failed.stderr).toBe("docker inspect exit=7 status=failed\n");
    expect(lines()[0].labels).toEqual({});
    expect(failed.stderr + JSON.stringify(lines())).not.toContain(secret);
    write(join(root, "bin/docker"), `#!/usr/bin/env python3\nprint('/database postgres:16 ${secret}')\n`);
    const extra = once(day + 10_000, 11_000_000_000);
    expect(extra.stderr).toBe("docker inspect exit=0 status=invalid-output\n");
    expect(JSON.stringify(lines())).not.toContain(secret);
  });

  it("skips ENOSPC samples and logs at most once per hour without private errors", () => {
    const patch = `tick = 0\ntime.time_ns = lambda: (${day} + tick * 10000) * 1000000\ntime.monotonic_ns = lambda: (tick + 1) * 10000000000\ndef advance(seconds):\n global tick\n tick += 1\ntime.sleep = advance\nos.write = lambda *args: (_ for _ in ()).throw(OSError(errno.ENOSPC, '${secret}'))`;
    const result = run(["run", "--count", "3", "--interval", "0.001"], patch);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("host-load sampler: storage full; sample skipped\n");
    expect(readFileSync(join(root, "state/2026-10-07.jsonl"), "utf8")).toBe("");
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it("skips rotation ENOSPC and retries next tick without repeating the warning", () => {
    log("2026-10-06", [sample(day - 10_000, 0, 0, 0)]);
    const patch = `original_open = builtins.open\ndef full_open(path, *args, **kwargs):\n if str(path).endswith('.gz.tmp'): raise OSError(errno.ENOSPC, '${secret}')\n return original_open(path, *args, **kwargs)\nbuiltins.open = full_open`;
    const result = run(["run", "--count", "2", "--interval", "0.001", "--now", String(day)], patch);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("host-load sampler: storage full; sample skipped\n");
    expect(existsSync(join(root, "state/2026-10-06.jsonl"))).toBe(true);
    expect(existsSync(join(root, "state/2026-10-07.jsonl"))).toBe(false);
  });

  it("repairs partial append on restart and rolls back short ENOSPC writes", () => {
    log("2026-10-07", [sample(day, 0, 0, 0)]);
    const file = join(root, "state/2026-10-07.jsonl");
    const before = readFileSync(file, "utf8");
    write(file, before + '{"partial":');
    const patch = `original_write = os.write\ndef short_write(fd, payload):\n return original_write(fd, payload[:10])\nos.write = short_write`;
    const result = once(day + 10_000, 10_000_000_000, patch);
    expect(result.stderr).toBe("host-load sampler: storage full; sample skipped\n");
    expect(readFileSync(file, "utf8")).toBe(before);
    once(day + 20_000, 20_000_000_000);
    expect(lines().map((line) => line.kind)).toEqual(["sample", "sample"]);
    expect(report(day, day + 20_000).coverage.samples).toBe(2);
  });

  it("shares default HOME config/state and rejects invalid report windows with exit two", () => {
    delete env.HOST_LOAD_CONFIG;
    write(join(root, "home/.config/host-load/sampler.env"), `WORKSPACE_ROOT=${join(root, "workspace")}\n`);
    once();
    expect(existsSync(join(root, "home/.local/state/host-load/2026-10-07.jsonl"))).toBe(true);
    expect(report(day, day + 10_000).v).toBe(1);
    for (const to of [day, day - 1, day + 86_400_001]) {
      const result = run(["report", "--from", String(day), "--to", String(to)]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    }
    const result = run(["report", "--from", secret, "--to", String(day)]);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain(secret);
  });
});
