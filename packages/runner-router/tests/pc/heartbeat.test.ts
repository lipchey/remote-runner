import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Report = {
  v: number;
  counter: number;
  sentAt: number;
  githubProbe: boolean;
  runners: { name: string; unit: string; listener: boolean }[];
};

let root: string;
const script = resolve("pc/heartbeat.sh");
const map = "gh-runner-1:popos-1 gh-runner-2:popos-2 gh-runner-3:popos-3";

function write(path: string, value: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}

function configure(runners = map) {
  write(
    join(root, "heartbeat.env"),
    `ROUTER_URL=https://router.example\nHEARTBEAT_SECRET=fixture-heartbeat-secret\nRUNNERS='${runners}'\n`,
  );
}

function run() {
  return spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      TEST_DIR: root,
      HEARTBEAT_ENV: join(root, "heartbeat.env"),
      CGROUP_ROOT: join(root, "cgroup"),
      PROC_ROOT: join(root, "proc"),
      COUNTER_FILE: join(root, "state/counter"),
    },
  });
}

function args(kind: string) {
  return readFileSync(join(root, `${kind}.args`), "utf8")
    .split("\0")
    .slice(0, -1);
}

function report(): Report {
  const post = args("post");
  return JSON.parse(post[post.indexOf("--data") + 1] ?? "") as Report;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-heartbeat-"));
  configure();
  for (let n = 1; n <= 3; n++) {
    write(join(root, `gh-runner-${n}.state`), "active\n");
    write(join(root, `gh-runner-${n}.group`), `/gh-runner-${n}\n`);
    write(join(root, `cgroup/gh-runner-${n}/cgroup.procs`), `${n}1\n${n}2\n${n}3\n`);
    write(join(root, `proc/${n}1/comm`), "run.sh\n");
    write(join(root, `proc/${n}2/comm`), "run-helper.sh\n");
    write(join(root, `proc/${n}3/comm`), "Runner.Listener\n");
  }
  write(
    join(root, "bin/systemctl"),
    `#!/bin/bash
printf '%s\\0' "$@" >> "$TEST_DIR/systemctl.args"
unit=\${!#}
case "$*" in
  *ActiveState*)
    [ ! -f "$TEST_DIR/$unit.fail" ] || exit 1
    cat "$TEST_DIR/$unit.state" ;;
  *ControlGroup*) cat "$TEST_DIR/$unit.group" ;;
  *) exit 1 ;;
esac
`,
  );
  write(
    join(root, "bin/curl"),
    `#!/bin/bash
kind=probe
for arg in "$@"; do
  [ "$arg" != POST ] || kind=post
done
printf '%s\\0' "$@" > "$TEST_DIR/$kind.args"
printf '%s\\n' "$kind" >> "$TEST_DIR/curl.calls"
if [ "$kind" = probe ]; then
  [ ! -f "$TEST_DIR/probe.hang" ] || exec /bin/sleep 6
  [ ! -f "$TEST_DIR/probe.fail" ]
else
  cat > "$TEST_DIR/post.config"
  [ ! -f "$TEST_DIR/post.fail" ] || exit 7
  if [ -f "$TEST_DIR/post.status" ]; then
    cat "$TEST_DIR/post.status"
  else
    printf 204
  fi
fi
`,
  );
  chmodSync(join(root, "bin/systemctl"), 0o755);
  chmodSync(join(root, "bin/curl"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("PC heartbeat", () => {
  it("sends the exact healthy wire shape and bounded curl options", () => {
    const lowerBound = Math.floor(Date.now() / 1000) * 1000;
    expect(run().status).toBe(0);
    const body = report();
    expect(body).toEqual({
      v: 1,
      counter: body.sentAt,
      sentAt: body.sentAt,
      githubProbe: true,
      runners: [1, 2, 3].map((n) => ({ name: `popos-${n}`, unit: "active", listener: true })),
    });
    expect(body.sentAt).toBeGreaterThanOrEqual(lowerBound);
    expect(body.sentAt % 1000).toBe(0);
    expect(args("probe")).toEqual([
      "-sS",
      "-o",
      "/dev/null",
      "-m",
      "2",
      "--retry",
      "1",
      "--retry-max-time",
      "4",
      "https://broker.actions.githubusercontent.com/",
    ]);
    const post = args("post");
    expect(post.join("\0")).not.toContain("fixture-heartbeat-secret");
    expect(post.slice(post.indexOf("--config"), post.indexOf("--config") + 2)).toEqual(["--config", "-"]);
    expect(readFileSync(join(root, "post.config"), "utf8")).toContain(
      'header = "Authorization: Bearer fixture-heartbeat-secret"',
    );
    expect(post).toContain("content-type: application/json");
    expect(post.slice(post.indexOf("-m"), post.indexOf("-m") + 2)).toEqual(["-m", "3"]);
    expect(post).not.toContain("--retry");
    expect(post.at(-1)).toBe("https://router.example/heartbeat");
    expect(readFileSync(join(root, "curl.calls"), "utf8")).toBe("probe\npost\n");
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "state/counter")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "systemctl.args"), "utf8").split("\0").slice(0, -1)).toEqual(
      [1, 2, 3].flatMap((n) => [
        "--user",
        "show",
        "-p",
        "ActiveState",
        "--value",
        `gh-runner-${n}`,
        "--user",
        "show",
        "-p",
        "ControlGroup",
        "--value",
        `gh-runner-${n}`,
      ]),
    );
  });

  it("reports one failed unit while still sending every runner", () => {
    write(join(root, "gh-runner-2.state"), "failed\n");
    expect(run().status).toBe(0);
    expect(report().runners[1]).toEqual({ name: "popos-2", unit: "failed", listener: true });
    expect(report().runners).toHaveLength(3);
  });

  it("reports a missing listener without borrowing another unit's listener", () => {
    write(join(root, "proc/23/comm"), "Runner.Worker\n");
    expect(run().status).toBe(0);
    expect(report().runners.map((r) => r.listener)).toEqual([true, false, true]);
  });

  it("reports a vanished cgroup file and still sends", () => {
    rmSync(join(root, "cgroup/gh-runner-2/cgroup.procs"));
    expect(run().status).toBe(0);
    expect(report().runners[1]?.listener).toBe(false);
  });

  it("reports a vanished process comm file and still sends", () => {
    rmSync(join(root, "proc/23/comm"));
    expect(run().status).toBe(0);
    expect(report().runners[1]?.listener).toBe(false);
  });

  it("reports an empty ControlGroup without reading the cgroup root", () => {
    write(join(root, "gh-runner-2.group"), "\n");
    write(join(root, "cgroup/cgroup.procs"), "13\n");
    expect(run().status).toBe(0);
    expect(report().runners[1]?.listener).toBe(false);
  });

  it("reports a failed GitHub probe while still posting", () => {
    write(join(root, "probe.fail"), "");
    expect(run().status).toBe(0);
    expect(report().githubProbe).toBe(false);
  });

  it("caps a hanging probe at four seconds and still posts within the service budget", () => {
    write(join(root, "probe.hang"), "");
    const start = Date.now();
    expect(run().status).toBe(0);
    expect(Date.now() - start).toBeLessThan(7000);
    expect(report().githubProbe).toBe(false);
  });

  it("persists a strictly increasing counter across two runs despite clock rollback", () => {
    const future = Math.floor(Date.now() / 1000) * 1000 + 60_000;
    write(join(root, "state/counter"), String(future));
    expect(run().status).toBe(0);
    const first = report();
    expect(first.counter).toBe(future + 1);
    expect(run().status).toBe(0);
    const second = report();
    expect(second.counter).toBe(first.counter + 1);
    expect(second.counter).toBeGreaterThanOrEqual(second.sentAt);
    expect(Number(readFileSync(join(root, "state/counter"), "utf8"))).toBe(second.counter);
  });

  it("recovers a lost counter file from the current timestamp", () => {
    expect(run().status).toBe(0);
    rmSync(join(root, "state/counter"));
    expect(run().status).toBe(0);
    expect(report().counter).toBe(report().sentAt);
  });

  it("treats an unparsable counter as zero", () => {
    write(join(root, "state/counter"), "broken\n");
    expect(run().status).toBe(0);
    expect(report().counter).toBe(report().sentAt);
  });

  it("reads a zero-prefixed counter as decimal", () => {
    const future = Math.floor(Date.now() / 1000) * 1000 + 60_000;
    write(join(root, "state/counter"), `00${future}\n`);
    expect(run().status).toBe(0);
    expect(report().counter).toBe(future + 1);
  });

  it("persists the counter before a POST transport failure", () => {
    write(join(root, "post.fail"), "");
    expect(run().status).toBe(1);
    const first = report().counter;
    expect(Number(readFileSync(join(root, "state/counter"), "utf8"))).toBe(first);
    expect(run().status).toBe(1);
    expect(report().counter).toBeGreaterThan(first);
  });

  it.each(["302", "401", "500"])("fails a non-2xx POST (%s) after persisting the counter", (status) => {
    write(join(root, "post.status"), status);
    expect(run().status).toBe(1);
    expect(Number(readFileSync(join(root, "state/counter"), "utf8"))).toBe(report().counter);
  });

  it.each(["gh-runner-1:bad_name", "gh-runner-1:popos-1:extra", "GH-runner-1:popos-1", "*:popos-1"])(
    "rejects an invalid map entry (%s) before any curl call",
    (entry) => {
      configure(`${map} ${entry}`);
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(entry);
      expect(() => args("probe")).toThrow();
      expect(() => args("post")).toThrow();
    },
  );

  it("trims ActiveState stdout", () => {
    write(join(root, "gh-runner-2.state"), " \tactive \t\n");
    expect(run().status).toBe(0);
    expect(report().runners[1]?.unit).toBe("active");
  });

  it("reports empty ActiveState as unknown", () => {
    write(join(root, "gh-runner-2.state"), " \n");
    expect(run().status).toBe(0);
    expect(report().runners[1]?.unit).toBe("unknown");
  });

  it("reports failed ActiveState commands as unknown", () => {
    write(join(root, "gh-runner-2.fail"), "");
    expect(run().status).toBe(0);
    expect(report().runners[1]?.unit).toBe("unknown");
  });

  it("reports a missing systemctl command without aborting the POST", () => {
    write(join(root, "bin/systemctl"), "#!/bin/bash\nexit 127\n");
    expect(run().status).toBe(0);
    expect(report().runners).toEqual([1, 2, 3].map((n) => ({ name: `popos-${n}`, unit: "unknown", listener: false })));
  });
});
