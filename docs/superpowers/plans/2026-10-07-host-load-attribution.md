# Host load attribution on the PC — implementation plan

Status: Gate P (Codex) done 2026-10-07, with findings folded in (§9). Code name `host-load-attribution`.

When a test times out on pop-os, nobody can say which source was loading the host.
- GitHub's jobs API shows only CI jobs. remote-runner workloads, Mutagen agents, CI service containers and orphaned processes do not appear there.
- This repo owns the capability. Ariadne's architecture rule forbids a parallel runner layer there, "включно з observability над станом раннера" (Ariadne `.claude/memory/project-architecture.md:194-197`).

## 0. Facts this plan rests on (verified 2026-10-07)

- **Host:** pop-os, Pop!_OS 24.04, kernel 7.0.11, 24 threads, 30 GiB of memory.
  - Pure cgroup v2 (`cgroup2fs`), systemd 255. PSI is on system-wide and per cgroup.
  - `/usr/bin/python3` is 3.12.3.
  - No sysstat, atop, below, node_exporter or process accounting is installed.
  - `sudo -n true` fails with "password required", so this plan needs no root.
  - `admin` is in the `docker` group and has linger on. `/home` has 60 G free.
- **Where each load source lives in the cgroup tree:**
  - CI jobs: `user.slice/user-1000.slice/user@1000.service/app.slice/gh-runner-N.service` (the user units from README "For the PC installation"). Jobs are not containerised.
  - remote-runner workloads, preparation commands and Mutagen agents: each ssh connection gets its own `user.slice/user-1000.slice/session-*.scope`. The scope name carries no identity.
  - CI service containers (postgres + wsproxy for each job): `system.slice/docker-<id>.scope`.
- **What `admin` can read over ssh (live read, 2026-10-07):**
  - `cpu.stat` (`usage_usec`), `memory.current` and `cpu.pressure` in all three kinds of cgroup.
  - `io.stat` is absent under `user.slice`: the io controller is not delegated and I/O accounting is off.
- **Process priority:** the System76 scheduler runs ssh-session processes and dockerd and its containers at nice 12. GitHub job processes run at nice 0.
- **remote-runner launch:**
  - The workload env is assembled in `src/app/pilot-services.ts:134-183`.
  - Preparation (bootstrap, artifact checks) uses `remoteWorkspaceCommandArguments` (`pilot-services.ts:186`). It `cd`s into the workspace without the launcher.
  - The workspace is `<generatedRoot>/<consumer>/<profile>/clients/<sha(clientId)[0:24]>/<identity>` (`pilot-services.ts:92-98`, `src/runtime/identity.ts:60-70`). pop-os uses `/mnt/DataAI/home/admin/.cache/remote-runner/workspaces` (Ariadne `.remote-runner.yaml:197`).
  - `runId` is laptop-only (`src/app/default-dependencies.ts:578`).
  - The launcher passes its env down to the workload (`assets/remote-launcher.mjs:170`). It SIGKILLs the workload's process group (:178). Descendants that started their own session escape that kill, and keep their cgroup and their inherited environ.
- **SSH helpers:**
  - `runSsh` caps output at a byte limit (`src/ssh/client.ts:130`) and kills ssh on overflow (`src/node/process.ts:38`).
  - Host-key pin validation is separate from `runSsh`: `NodeProfileServices.validate()` → `ensureManagedKnownHost` (`pilot-services.ts:582`).
- **Precedent:** `packages/runner-router/pc/heartbeat.sh` runs on pop-os as a oneshot every 10 s. It bounds its probe with a watchdog (:81).
  - It is installed by hand as an owner-approved step.
  - Its tests are `packages/runner-router/tests/pc/heartbeat.test.ts`, run by the package's verify; root `vitest.config.ts` covers only `tests/{unit,integration}`. They exercise the real script against `CGROUP_ROOT`/`PROC_ROOT` fixtures, with stubs on PATH.
- **Controller install:** the installed controller is an immutable application (README "Install once"), so merging does not upgrade it.
- **The need, measured in Ariadne CI** on main pushes of 2026-10-06 and 2026-09-10:
  - The whole suite ran 1.7–2.3× slower at the median file.
  - Every failure fell inside one 10–30 s spike.
  - The API showed the concurrent CI jobs; the laptop remote-runner load was invisible.

## 1. Goal and acceptance

`remote-runner load` reports which sources consumed CPU on the PC, and how CPU-starved each one was. It covers any window in the last 30 days at 10-s resolution, and states the coverage of that window explicitly.

1. **Sampler runs light and private.**
   - It runs as an `admin` user service: no root, no credentials, no network.
   - The only key it extracts from any inspected process environ is `REMOTE_RUNNER_RUN_ID`.
   - Its own CPU stays under 0.5% of one core over 1 h, measured from its own cgroup.
2. **Every observed sample is complete.** It covers every `gh-runner-*.service`, `session-*.scope` and `docker-*.scope` present at that tick, plus the host totals. Each cgroup is tagged per §3.
   - Known blind spot: a cgroup that is created and removed between two ticks, and the final interval of a removed cgroup. Both land in `unattributed`, never in a named source.
3. **Window report.**
   - **Per source group:** mean cores, share of host CPU, and peak cores over one interval of at most 15 s.
   - **Per cgroup:** CPU stall %, defined as the `cpu.pressure` some-total delta over the elapsed time.
   - **Host:** CPU busy and PSI for cpu, io and memory.
   - **Coverage:** gap list and clock discontinuities.
   - **Inconsistency:** `unattributed` (host minus the sum of tagged cgroups), printed even when negative.
   - `--json` returns the same data.
4. **Job lookup.** `--github-job <owner>/<repo>/<jobId>` takes the window and the runner name from `gh api repos/<o>/<r>/actions/jobs/<id>` and marks that runner's rows.
5. **Run identity.** A workload from a controller that includes T1 is reported under its laptop `runId`.
6. **Orphans.** A detached busy-loop carrying a runId whose launcher has exited is reported as `remote-runner-orphan` with that runId.
7. **Idle runners with load.** A runner cgroup with no `Runner.Worker` process but more than 0.2 cores is reported as `ci-idle-load`; CI orphans land there.
8. **Retention.** 30 days are kept, earlier days gzipped atomically, with a hard byte budget of 300 MB enforced by pruning the oldest day.

## 2. Shape

- **Sampler:** `packages/runner-router/pc/host-load-sampler.py`, python3 standard library only, syntax valid on both the Mac test interpreter and 3.12. It has two subcommands:
  - `run` is the sampling loop, with test knobs `--once` and `--now`.
  - `report --from <ms> --to <ms>` aggregates **on the host** and prints one summary JSON object of a few KiB. It returns no raw samples, so the ssh output limit holds.
- **Configuration:** `run` and `report` share one config loader that reads `~/.config/host-load/sampler.env`. It holds `WORKSPACE_ROOT` and `STATE_DIR` (default `~/.local/state/host-load`) and no secrets.
- **Service unit:** `packages/runner-router/pc/host-load-sampler.service`.
  - `Type=simple`, `Restart=always`, `RestartSec=30`, `Nice=10`.
  - The `STATE_DIR` mode is 0700.
  - It is a loop rather than a timer, so counters and the classification cache stay in memory.
- **Root CLI:** `remote-runner load <profile> (--from <iso> --to <iso> | --github-job <o>/<r>/<id>) [--json]`.
  - It is wired like `status`/`doctor` (`src/cli.ts:64-105`).
  - It first validates the profile's host-key pin through the `ensureManagedKnownHost` path, without bootstrap, then calls `runSsh` with an explicit output limit.
  - It formats the host's summary for display and does no counter math of its own.
- **Launcher env:** add `REMOTE_RUNNER_RUN_ID` (T1).

## 3. Sample log v1

- **Day files:** `STATE_DIR/YYYY-MM-DD.jsonl`, one per UTC day. Each file is independently decodable:
  - its first lines are a full `source` snapshot of every live cgroup;
  - later `source` lines record only changes.
- **Every sample carries:**
  - `boot` (`/proc/sys/kernel/random/boot_id`);
  - `mono` (`time.monotonic_ns()`, CLOCK_MONOTONIC on Linux);
  - `t` (epoch ms, for display and lookup only).
- **Interval math:**
  - Deltas use `mono` and are computed only within one `boot`.
  - The cgroup key is `boot:inode`.
  - An interval longer than 15 s is a gap. It counts toward means, but never toward peaks.
  - A jump between the `t` delta and the `mono` delta is reported as a clock discontinuity.
- **A missing reading** (a file that vanished mid-read, EACCES) is recorded as `null`, never as 0.

```json
{"v":1,"kind":"source","boot":"…","mono":0,"t":0,"key":"<boot>:<inode>","path":"user.slice/…/session-10572.scope",
 "source":"remote-runner","labels":{"consumer":"ariadne","profile":"verify-full-pop-os","client":"…","identity":"…","runId":"…"}}
{"v":1,"kind":"sample","boot":"…","mono":0,"t":0,
 "host":{"busy_usec":0,"cpu_some_us":0,"cpu_full_us":0,"io_some_us":0,"io_full_us":0,"mem_some_us":0,"mem_full_us":0,"load1":4.93},
 "cg":[["<key>",usage_usec,memory_current,cpu_some_total_us]]}
```

- **Host busy time:**
  - It is the sum of the `/proc/stat` fields user, nice, system, irq, softirq and steal (idle and iowait excluded), converted with `os.sysconf("SC_CLK_TCK")`.
  - T0 decides whether root `cpu.stat` is preferable and whether it agrees with `/proc/stat` within 2%.
- **Classification runs every sample.** A process is identified by pid plus `starttime` from `/proc/<pid>/stat`, read before and after cmdline/cwd/environ to drop pids that were reused mid-read. Per-process facts are cached under that identity, so each sample reads only new pids.
  - `gh-runner-N.service` → `ci` with labels `{runner}`. The runner name comes from `~/actions-runner-N/.runner`; T0 verifies the field.
    - `busy`: a `Runner.Worker` process is present.
    - `ci-idle-load`: no `Runner.Worker` and more than 0.2 cores.
  - A session scope with a `mutagen-agent` process → `mutagen`.
  - A session scope containing the launcher → `remote-runner`. The launcher is the process whose argv[1] ends in `remote-launcher.mjs`.
    - `runId` comes from the environ of the launcher or of any member process carrying it.
    - Path labels come from the launcher's cwd under `WORKSPACE_ROOT`.
  - A session scope whose member processes carry a `REMOTE_RUNNER_RUN_ID`, but where no launcher with that runId is alive → `remote-runner-orphan`. Labels are cached from the launcher sighting; the runId alone is enough.
  - A session scope with a cwd under `WORKSPACE_ROOT` but no runId → `remote-runner-prep`. This covers bootstrap and checks, and also orphans from pre-T1 controllers, which cannot be told apart from preparation.
  - Any other session scope → `ssh`, labelled with its top `comm`.
  - `docker-<id>.scope` → `docker` with labels `{name, image}`.
    - The labels come from one `docker inspect --format '{{.Name}} {{.Config.Image}}'` call per new id, run against the explicit local socket (`DOCKER_HOST=unix:///var/run/docker.sock`, no inherited context) with a 2-s deadline.
    - If inspect fails, the container is unlabelled, and the failure line is truncated to 200 bytes and stripped of anything but the exit code and status.
  - The sampler's own service → `sampler`.
- **Never written:** argv, environ values other than the run id, docker output beyond name and image, and paths outside `WORKSPACE_ROOT` apart from cgroup paths.
- **Writes and rotation:**
  - Each sample is appended as one `write` of a complete line.
  - At rollover the previous day's file is gzipped into a temp file, fsync'd, renamed to `.gz`, and only then is the raw file deleted. Startup does the same for every non-today raw file, deletes stale temp files, and prunes anything older than 30 days or over the byte budget.
  - On ENOSPC the sample is skipped, and the condition is logged once per hour to the journal.
- **Reading:** `report` reads the day files that overlap the window plus the preceding day, which supplies the last sample before `from` and the source snapshot.
  - It ignores an unparsable final line, which is a partial append in progress.
  - It opens each file once; a rename during the read only means the `.gz` is used next time.

## 4. Query semantics

- **Window:** intervals whose end lies in `[from, to]`, plus the first interval that straddles `from`, clipped proportionally. The cap is 24 h.
- **Source groups:** one row per (source, labels). Its CPU is the sum of its member cgroups, and its stall is the **maximum** member stall %, labelled as such. Summed PSI is never reported.
- **Per-cgroup rows** are shown with `--json`, or with `--detail` for stalls.
- **`--github-job`:** uses `gh` from PATH; if `gh` is missing, the command fails with an error naming `--from/--to`. There is no padding: the job's own `started_at`..`completed_at`.

## 5. Tasks

- **T0 — read-only precondition probe.** No install. Record the results in §0. The service-context checks run from a transient `systemd-run --user --wait --pipe` unit, not from ssh.
  - That context can read `cgroup.procs`, `/proc/<pid>/{stat,cmdline,cwd,environ}` and docker inspect.
  - Root `cpu.stat`: compare it with `/proc/stat` busy time.
  - Which `.runner` field holds the runner name.
  - The canonical `WORKSPACE_ROOT` (a realpath match).
  - The effective logout policy: `loginctl show-user admin`, plus `KillUserProcesses` in the logind config. Do session scopes outlive their ssh disconnect?
  - `timedatectl` NTP status.
  - The Mac's `python3 --version`.
  - Any check that stays unresolved is listed as pending in §0, never assumed.
- **T1 — runId pass-through.**
  - Thread `request.runId` into the profile services, and append `REMOTE_RUNNER_RUN_ID` in `remoteChildArguments`.
  - Add it to `RESERVED_CHILD_ENVIRONMENT` (`src/config/load-manifest.ts:16`) and to the launcher's `RUNNER_MARKERS` (`assets/remote-launcher.mjs:20`).
  - Tests: the env reaches the workload, and a manifest cannot override it.
- **T2 — sampler, in `packages/runner-router/tests/pc/host-load-sampler.test.ts`** (covered by the package's verify). The tests spawn the real script against fixtures, with a fake `docker` on PATH. Cases:
  - every §3 classification, including bootstrap → `remote-runner-prep` (not orphan), a `chdir`'d descendant that carries the runId, and the launcher disappearing between two reads;
  - pid reuse during classification;
  - a cgroup vanishing mid-read (→ `null`);
  - boot change, clock step and a gap > 15 s;
  - day independence across midnight, including when the identity was first seen a day earlier;
  - gzip interrupted before the rename, followed by recovery on startup;
  - pruning by age and by byte budget;
  - a partial last line;
  - a `report` window across a gzipped and a raw day, including straddle clipping and a negative `unattributed`;
  - a secret-looking environ value, argv and docker env in the fixtures must never appear in any output or log;
  - a docker inspect hang is cut at the deadline.
- **T3 — `remote-runner load`.**
  - Tests use Fake ssh and fake `gh` ports.
  - Cases: the pin is checked before the query and a mismatch fails; the output limit is honoured; the job's runner is marked; `gh` missing; the 24 h cap; the `--json` shape.
- **T4 — docs.**
  - README PC install: copy the files, write the env file, `daemon-reload`, `enable --now`. Also the rollback: `disable --now`, and remove the unit and binary but keep `STATE_DIR`.
  - An ops-guide entry with read-only commands, enforced by `tests/unit/operations-guide.test.ts`.
- **T5 — PR.** `pnpm verify` green. Gate C (codex-chain) is run by the Claude main loop before the commit; a Codex implementer does not self-review. One PR covering plan, code, tests and docs.
- **T6 — owner-approved rollout and live acceptance.**
  1. Upgrade the laptop controller from merged `main` (`remote-runner install` from a built checkout) and check that `remote-runner --version` shows the new identity.
  2. Install the sampler on pop-os.
  3. After 1 h, check §1.1 for the sampler's own CPU.
  4. Check §1.5: one normal `verify-full-pop-os` run appears under its runId.
  5. Check §1.6: from inside a run started by the new controller, with the runId inherited, run `setsid -f timeout 120 sh -c 'while :; do :; done' </dev/null >/dev/null 2>&1`. Do it through a one-off workspace command, which T0 checks the profile allows; otherwise, as an owner step, from a shell holding that env. Then report the window after the launcher exits.
  6. Check §1.4: `--github-job` on a real Ariadne job.
  7. Check §1.8: the 30-day budget is proven by the T2 tests. Live, one day's size is recorded as the projection.
- **T7 — Ariadne follow-up PR, after T6.**
  - `.claude/runbooks/ci-operations.md` triage: a pop-os timeout leads to `remote-runner load verify-full-pop-os --github-job …` as the first step. The bounded orphan probe and the remediation guidance stay.
  - Attach a pointer to the roadmap row "PC runner capacity" (`docs/plans/roadmap/05-planning-readiness.md:291`) as an evidence source, without changing that row's acceptance. Edge 51 governs the LOCAL lane and is not touched.

## 6. External writes

Each is a separate owner-approved step. If auto mode blocks one, hand the owner the exact command.
- The T6 controller upgrade and sampler install.
- Push and PR in this repo.
- The T7 Ariadne PR.

## 7. Out of scope (add when)

- **Per-source I/O:** needs root to delegate the io controller and to turn on I/O accounting. Add when a flake shows high io PSI while CPU is quiet.
- **Delay accounting.**
- **Alerts:** add when readings are acted on more than by hand.
- **Admission control.**
- **Naming the other runners' concurrent jobs automatically.**
- **Orphan attribution for pre-T1 controllers:** they show up as `remote-runner-prep`.

## 8. Rejected

- **`below` or `atop`:** both need root, and both record cgroup names only. `session-10572.scope` says nothing about the workload.
- **GitHub job ids read from job-process environ:** that environ also holds runtime tokens. The runner name plus the time window, joined through the API on the laptop, is enough.
- **Extending `heartbeat.sh`:** a 10-s oneshot cannot hold deltas or identity, and its job is liveness for the router.
- **Streaming raw samples to the laptop:** a day of samples far exceeds the ssh output limit, and it would duplicate the counter math. Aggregating on the host keeps one engine.

## 9. Gate P record (Codex gpt-6.1-sol xhigh, 2026-10-07)

| Finding | Verdict | Change |
|---|---|---|
| Raw stream exceeds the `runSsh` limit | VALID (`client.ts:130`, `process.ts:38`) | Host-side `report` |
| Window not reconstructible (identity on first sight only, no predecessor sample) | VALID | Self-contained day files, preceding day read, straddle clipping |
| Inode across boots; pid reuse | VALID | `boot:inode` key, starttime guard, `null` vs 0 |
| Wall-clock-only rates | VALID | `mono`, gaps, discontinuities |
| cwd-only orphan rule misfires on bootstrap | VALID (`pilot-services.ts:186`) | runId-based orphan rule, `remote-runner-prep` |
| 1-min reclassification vs 10-s attribution | VALID | Classification every sample; blind spot named in §1.2 |
| Summed PSI and unspecified host CPU | VALID | Max-member stall, field list, signed `unattributed` |
| `runSsh` does not check the pin | VALID (`pilot-services.ts:582`) | Validate first |
| docker inspect can hang or leak | VALID | Deadline, narrow format, explicit socket |
| Rotation crash safety and budget | VALID | Atomic gzip, startup recovery, byte budget |
| Service and reader config diverge | VALID | One loader |
| Wrong test location | VALID (root vitest includes) | Package tests dir |
| T0 gaps (service context, logout policy) | VALID | Added |
| T6 cannot exercise the new CLI | VALID (README immutable install) | Controller upgrade first, exact command |
| Edge 51 is the wrong consumer | VALID (`03-dependencies.md:974`) | Removed |
| Gate C vs a Codex implementer | PARTIAL | Run by the Claude main loop |

Own pass, written before reading Codex, added `ci-idle-load` (§1.7), `RestartSec` and the partial-line read. Its other items duplicated Codex's.
