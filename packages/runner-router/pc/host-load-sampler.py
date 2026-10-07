#!/usr/bin/env python3
import argparse
import datetime as dt
import errno
import gzip
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time


DAY_MS = 86_400_000
BUDGET = 300_000_000
PSI_FIELDS = ("cpu_some_us", "cpu_full_us", "io_some_us", "io_full_us", "mem_some_us", "mem_full_us")
DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$")


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "host-load sampler: invalid arguments\n")


def config():
    home = Path(os.environ["HOME"])
    path = Path(os.environ.get("HOST_LOAD_CONFIG", home / ".config/host-load/sampler.env"))
    values = {}
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            words = shlex.split(line, comments=True)
            if not words:
                continue
            if len(words) != 1 or "=" not in words[0]:
                raise ValueError("configuration")
            key, value = words[0].split("=", 1)
            if key not in ("WORKSPACE_ROOT", "STATE_DIR"):
                raise ValueError("configuration")
            values[key] = value
    workspace = Path(values["WORKSPACE_ROOT"]).expanduser()
    if not workspace.is_absolute():
        raise ValueError("configuration")
    workspace = workspace.resolve()
    state = Path(values.get("STATE_DIR", str(home / ".local/state/host-load"))).expanduser()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    return (
        workspace, state, Path(os.environ.get("CGROUP_ROOT", "/sys/fs/cgroup")),
        Path(os.environ.get("PROC_ROOT", "/proc")), home,
    )


def text(path):
    with open(path, encoding="utf-8", errors="replace") as stream:
        return stream.read()


def counter(path, field=None):
    try:
        value = text(path)
        if field is None:
            return int(value.strip())
        return next(int(line.split()[1]) for line in value.splitlines() if line.split()[0] == field)
    except (OSError, ValueError, StopIteration, IndexError):
        return None


def pressure(path):
    result = {"some": None, "full": None}
    try:
        for line in text(path).splitlines():
            parts = line.split()
            if parts and parts[0] in result:
                result[parts[0]] = next(int(part[6:]) for part in parts[1:] if part.startswith("total="))
    except (OSError, ValueError, StopIteration):
        pass
    return result


def utc_day(t):
    return dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date()


def repair_tail(path):
    if not path.exists():
        return
    with open(path, "r+b") as stream:
        end = stream.seek(0, os.SEEK_END)
        while end:
            start = max(0, end - 8192)
            stream.seek(start)
            chunk = stream.read(end - start)
            newline = chunk.rfind(b"\n")
            if newline >= 0:
                stream.truncate(start + newline + 1)
                return
            end = start
        stream.truncate(0)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def maintain(state, today):
    for path in state.glob("*.jsonl*.tmp"):
        path.unlink(missing_ok=True)
    raw_today = state / f"{today}.jsonl"
    archived_today = Path(str(raw_today) + ".gz")
    if archived_today.exists() and not raw_today.exists():
        temporary = Path(str(raw_today) + ".tmp")
        with gzip.open(archived_today, "rb") as archived, open(temporary, "wb") as raw:
            shutil.copyfileobj(archived, raw)
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(temporary, raw_today)
        sync_directory(state)
        archived_today.unlink()
    for path in sorted(state.glob("*.jsonl")):
        if not DAY_FILE.fullmatch(path.name) or path.stem == str(today):
            continue
        repair_tail(path)
        target = Path(str(path) + ".gz")
        temporary = Path(str(target) + ".tmp")
        with open(path, "rb") as raw, open(temporary, "wb") as compressed:
            with gzip.GzipFile(fileobj=compressed, mode="wb", mtime=0) as output:
                shutil.copyfileobj(raw, output)
            compressed.flush()
            os.fsync(compressed.fileno())
        os.replace(temporary, target)
        sync_directory(state)
        path.unlink()
    prune(state, today)


def prune(state, today):
    days = {}
    for path in sorted(state.iterdir()):
        match = DAY_FILE.fullmatch(path.name)
        if not match:
            continue
        days.setdefault(match[1], []).append((path, path.stat().st_size))
    for date in list(days):
        if dt.date.fromisoformat(date) < today - dt.timedelta(days=29):
            for path, _ in days.pop(date):
                path.unlink()
    total = sum(size for files in days.values() for _, size in files)
    for files in days.values():
        if total <= BUDGET:
            break
        for path, size in files:
            path.unlink()
            total -= size


def process_stat(path):
    value = text(path)
    end = value.rindex(")")
    return value[value.index("(") + 1:end], int(value[end + 2:].split()[19])


class Sampler:
    def __init__(self, settings):
        self.workspace, self.state, self.cgroup, self.proc, self.home = settings
        self.processes = {}
        self.containers = {}
        self.runners = {}
        self.run_labels = {}
        self.sources = {}
        self.previous = {}
        self.day = None
        self.full_warning = None

    def path_labels(self, cwd):
        try:
            parts = Path(cwd).resolve().relative_to(self.workspace).parts
            labels = dict(zip(("consumer", "profile"), parts[:2]))
            if len(parts) >= 5 and parts[2] == "clients":
                labels.update(zip(("client", "identity"), parts[3:5]))
            return True, labels
        except (OSError, ValueError):
            return False, {}

    def facts(self, pid, live):
        directory = self.proc / str(pid)
        try:
            comm, start = process_stat(directory / "stat")
            key = (pid, start, comm)
            live.add(key)
            if key in self.processes:
                return self.processes[key]
            try:
                with open(directory / "cmdline", "rb") as stream:
                    argv = stream.read().split(b"\0")
                launcher = len(argv) > 1 and argv[1].endswith(b"remote-launcher.mjs")
            except OSError:
                launcher = False
            try:
                with open(directory / "environ", "rb") as stream:
                    run_id = next((
                        item[21:].decode("utf-8", errors="replace")
                        for item in stream.read().split(b"\0")
                        if item.startswith(b"REMOTE_RUNNER_RUN_ID=")
                    ), "")
            except OSError:
                run_id = ""
            try:
                under_workspace, labels = self.path_labels(os.readlink(directory / "cwd"))
            except OSError:
                under_workspace, labels = False, {}
            if process_stat(directory / "stat") != (comm, start):
                return None
            result = {"comm": comm, "launcher": launcher, "runId": run_id, "labels": labels, "under_workspace": under_workspace}
            self.processes[key] = result
            return result
        except (OSError, ValueError, IndexError):
            return None

    def docker(self, identity):
        if identity in self.containers:
            return self.containers[identity]
        labels = {}
        code, status = None, "unavailable"
        try:
            result = subprocess.run(
                ["docker", "inspect", "--format", "{{.Name}} {{.Config.Image}}", identity],
                env={"PATH": os.environ.get("PATH", os.defpath), "DOCKER_HOST": "unix:///var/run/docker.sock"},
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=False,
            )
            code = result.returncode
            parts = result.stdout.decode("utf-8", errors="replace").split()
            if code == 0 and len(parts) == 2:
                labels = {"name": parts[0], "image": parts[1]}
            else:
                status = "failed" if code else "invalid-output"
        except subprocess.TimeoutExpired:
            status = "timeout"
        except OSError:
            pass
        if not labels:
            message = f"docker inspect exit={code if code is not None else 'none'} status={status}"
            print(message.encode()[:200].decode(), file=sys.stderr)
        self.containers[identity] = labels
        return labels

    def classify(self, path, members, usage, mono, key, launchers):
        name = path.name
        if name == "host-load-sampler.service":
            return "sampler", {}
        match = re.fullmatch(r"docker-(.+)\.scope", name)
        if match:
            return "docker", self.docker(match[1])
        match = re.fullmatch(r"gh-runner-(\d+)\.service", name)
        if match:
            number = match[1]
            runner = self.runners.get(key, name)
            if key not in self.runners:
                try:
                    with open(self.home / f"actions-runner-{number}" / ".runner", encoding="utf-8-sig") as stream:
                        value = json.load(stream)["agentName"]
                    if isinstance(value, str):
                        runner = self.runners[key] = value
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            busy = any(member["comm"] == "Runner.Worker" for member in members)
            previous = self.previous.get(key)
            if (
                not busy and previous and not previous[2] and usage is not None and previous[0] is not None
                and mono > previous[1] and (usage - previous[0]) * 1000 / (mono - previous[1]) > 0.2
            ):
                return "ci-idle-load", {"runner": runner}
            return "ci", {"runner": runner, "busy": busy}
        if any(member["comm"] == "mutagen-agent" for member in members):
            return "mutagen", {}
        launcher = next((member for member in members if member["launcher"]), None)
        run_id = (launcher["runId"] if launcher else "") or next((member["runId"] for member in members if member["runId"]), "")
        if launcher:
            labels = dict(launcher["labels"])
            if run_id:
                labels["runId"] = run_id
            return "remote-runner", labels
        if run_id:
            labels = dict(self.run_labels.get(run_id, {}))
            labels["runId"] = run_id
            return ("remote-runner" if run_id in launchers else "remote-runner-orphan"), labels
        labels = next((member["labels"] for member in members if member["under_workspace"]), None)
        if labels is not None:
            return "remote-runner-prep", dict(labels)
        member = next((member for member in members if member["comm"] != "sshd"), members[0] if members else None)
        return "ssh", {"comm": member["comm"]} if member else {}

    def tick(self, t, mono, boot):
        try:
            self.sample(t, mono, boot)
        except OSError as error:
            if error.errno != errno.ENOSPC:
                raise
            if self.full_warning is None or mono - self.full_warning >= 3_600_000_000_000:
                print("host-load sampler: storage full; sample skipped", file=sys.stderr)
                self.full_warning = mono

    def sample(self, t, mono, boot):
        today = utc_day(t)
        if self.day != today:
            maintain(self.state, today)
            repair_tail(self.state / f"{today}.jsonl")
            self.day = today
            self.sources = {}
        live = set()
        groups = []
        for directory, children, _ in os.walk(self.cgroup):
            path = Path(directory)
            if not (
                re.fullmatch(r"(?:gh-runner-.+\.service|session-.+\.scope|docker-.+\.scope)", path.name)
                or path.name == "host-load-sampler.service"
            ):
                continue
            children[:] = []
            try:
                key = f"{boot}:{path.stat().st_ino}"
            except OSError:
                continue
            try:
                pids = sorted(int(pid) for pid in text(path / "cgroup.procs").split())
            except (OSError, ValueError):
                pids = []
            members = [fact for pid in pids if (fact := self.facts(pid, live)) is not None]
            readings = [key, counter(path / "cpu.stat", "usage_usec"), counter(path / "memory.current"), pressure(path / "cpu.pressure")["some"]]
            groups.append((path, members, readings))
        host = {"busy_usec": counter(self.cgroup / "cpu.stat", "usage_usec")}
        for metric, prefix in (("cpu", "cpu"), ("io", "io"), ("memory", "mem")):
            for kind, value in pressure(self.cgroup / f"{metric}.pressure").items():
                host[f"{prefix}_{kind}_us"] = value
        try:
            host["load1"] = float(text(self.proc / "loadavg").split()[0])
        except (OSError, ValueError, IndexError):
            host["load1"] = None
        self.processes = {key: value for key, value in self.processes.items() if key in live}
        launchers = {
            member["runId"] for _, members, _ in groups for member in members
            if member["launcher"] and member["runId"]
        }
        # Traversal order must not hide a live launcher in another scope.
        for _, members, _ in groups:
            for member in members:
                if member["launcher"] and member["runId"]:
                    self.run_labels[member["runId"]] = {**member["labels"], "runId": member["runId"]}
        header = {"v": 1, "boot": boot, "mono": mono, "t": t}
        sources = {}
        records = []
        for path, members, reading in groups:
            key, usage, _, _ = reading
            source, labels = self.classify(path, members, usage, mono, key, launchers)
            identity = {"key": key, "path": str(path.relative_to(self.cgroup)), "source": source, "labels": labels}
            sources[key] = identity
            if self.sources.get(key) != identity:
                records.append({**header, "kind": "source", **identity})
        records.append({**header, "kind": "sample", "host": host, "cg": [reading for _, _, reading in groups]})
        filename = self.state / f"{today}.jsonl"
        fd = os.open(filename, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        size = os.fstat(fd).st_size
        try:
            try:
                for record in records:
                    payload = (json.dumps(record, separators=(",", ":")) + "\n").encode()
                    if os.write(fd, payload) != len(payload):
                        raise OSError(errno.ENOSPC, "short write")
            except OSError:
                os.ftruncate(fd, size)
                raise
        finally:
            os.close(fd)
        self.sources = sources
        prune(self.state, today)
        if not filename.exists():
            self.sources = {}
        self.previous = {
            reading[0]: (reading[1], mono, any(member["comm"] == "Runner.Worker" for member in members))
            for _, members, reading in groups
        }


def read_samples(state, start, end):
    identities = {}
    samples = []
    date = utc_day(start) - dt.timedelta(days=1)
    while date <= utc_day(end):
        raw = state / f"{date}.jsonl"
        try:
            stream = open(raw, "rb")
        except FileNotFoundError:
            try:
                stream = gzip.open(str(raw) + ".gz", "rb")
            except FileNotFoundError:
                date += dt.timedelta(days=1)
                continue
        with stream:
            pending = None
            for line in stream:
                if pending is not None:
                    raise ValueError("invalid log")
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    pending = line
                    continue
                if record["v"] != 1:
                    raise ValueError("version")
                if record["kind"] == "source":
                    identities[record["key"]] = {key: record[key] for key in ("key", "path", "source", "labels")}
                elif record["kind"] == "sample":
                    samples.append((record, {item[0]: identities[item[0]] for item in record["cg"] if item[0] in identities}))
        date += dt.timedelta(days=1)
    # Wall-clock steps can interleave one boot's samples across day files.
    boots = {boot: index for index, boot in enumerate(dict.fromkeys(sample[0]["boot"] for sample in samples))}
    samples.sort(key=lambda sample: (boots[sample[0]["boot"]], sample[0]["mono"]))
    return samples


def report(settings, start, end):
    _, state, _, proc, _ = settings
    try:
        ncpu = sum(bool(re.match(r"cpu\d+\s", line)) for line in text(proc / "stat").splitlines()) or os.cpu_count() or 1
    except OSError:
        ncpu = os.cpu_count() or 1
    samples = read_samples(state, start, end)
    coverage = {
        "window_ms": end - start, "covered_ms": 0, "samples": 0, "missing_readings": 0,
        "gaps": [], "clock_discontinuities": [], "boots": [],
    }
    elapsed = 0.0
    busy = 0.0
    psi = {field: 0.0 for field in PSI_FIELDS}
    psi_elapsed = {field: 0.0 for field in PSI_FIELDS}
    rows, groups = {}, {}
    cursor = start

    def gap(a, b):
        if b > a:
            coverage["gaps"].append({"from": a, "to": b})

    for index, (current, identities) in enumerate(samples):
        t = current["t"]
        if start <= t <= end:
            coverage["samples"] += 1
            if current["boot"] not in coverage["boots"]:
                coverage["boots"].append(current["boot"])
        if index == 0 or not start <= t <= end:
            continue
        previous = samples[index - 1][0]
        wall_ms = t - previous["t"]
        mono_ms = (current["mono"] - previous["mono"]) / 1_000_000
        left = max(start, previous["t"])
        if current["boot"] != previous["boot"] or mono_ms <= 0:
            gap(cursor, t)
            cursor = max(cursor, t)
            if current["boot"] == previous["boot"] and abs(wall_ms - mono_ms) > 1000:
                coverage["clock_discontinuities"].append({"t": t, "wall_ms": wall_ms, "mono_ms": mono_ms})
            continue
        fraction = (t - left) / wall_ms if previous["t"] < start and wall_ms > 0 else 1.0
        duration = mono_ms * 1000 * fraction
        if not fraction:
            continue
        gap(cursor, min(left, t))
        if mono_ms > 15_000:
            gap(left, t)
        cursor = max(cursor, t)
        if abs(wall_ms - mono_ms) > 1000:
            coverage["clock_discontinuities"].append({"t": t, "wall_ms": wall_ms, "mono_ms": mono_ms})
        if previous["boot"] not in coverage["boots"]:
            coverage["boots"].insert(0, previous["boot"])
        before_host, after_host = previous["host"], current["host"]
        for field in PSI_FIELDS:
            if before_host[field] is None or after_host[field] is None:
                coverage["missing_readings"] += 1
                continue
            psi[field] += max(0, after_host[field] - before_host[field]) * fraction
            psi_elapsed[field] += duration
        if (
            before_host["busy_usec"] is None or after_host["busy_usec"] is None
            or after_host["busy_usec"] < before_host["busy_usec"]
        ):
            coverage["missing_readings"] += 1
            if mono_ms <= 15_000:
                gap(left, t)
            continue
        elapsed += duration
        busy += (after_host["busy_usec"] - before_host["busy_usec"]) * fraction
        before_cg = {reading[0]: reading[1:] for reading in previous["cg"]}
        interval_groups = {}
        for key, usage, memory, stall in current["cg"]:
            old = before_cg.get(key, (0, memory, 0))
            if None in (usage, memory, stall, *old) or usage < old[0] or stall < old[2]:
                coverage["missing_readings"] += 1
                continue
            if key not in identities:
                continue
            identity = identities[key]
            group_key = (identity["source"], json.dumps(identity["labels"], sort_keys=True))
            row_key = (key, *group_key)
            row = rows.setdefault(row_key, {**identity, "cpu": 0.0, "stall": 0.0, "elapsed": 0.0, "peak": None})
            cpu = (usage - old[0]) * fraction
            row["cpu"] += cpu
            row["stall"] += (stall - old[2]) * fraction
            row["elapsed"] += duration
            if mono_ms <= 15_000:
                row["peak"] = max(row["peak"] or 0, cpu / duration)
            group = groups.setdefault(group_key, {
                "source": identity["source"], "labels": identity["labels"], "members": set(),
                "cpu": 0.0, "peak": None, "rows": set(),
            })
            group["cpu"] += cpu
            group["members"].add(key)
            group["rows"].add(row_key)
            interval_groups[group_key] = interval_groups.get(group_key, 0) + cpu
        if mono_ms <= 15_000:
            for group_key, cpu in interval_groups.items():
                groups[group_key]["peak"] = max(groups[group_key]["peak"] or 0, cpu / duration)
    gap(cursor, end)
    coverage["covered_ms"] = elapsed / 1000

    def ratio(numerator, denominator):
        return numerator / denominator if denominator else 0.0

    def percent(numerator, denominator):
        return min(100.0, max(0.0, ratio(numerator * 100, denominator)))

    cgroups = [{
        **{key: row[key] for key in ("key", "path", "source", "labels")},
        "mean_cores": ratio(row["cpu"], elapsed), "peak_cores": row["peak"],
        "stall_pct": percent(row["stall"], row["elapsed"]),
    } for row in rows.values()]
    result_groups = [{
        "source": group["source"], "labels": group["labels"], "members": len(group["members"]),
        "mean_cores": ratio(group["cpu"], elapsed), "share": ratio(group["cpu"], busy),
        "peak_cores": group["peak"],
        "max_stall_pct": max(percent(rows[key]["stall"], rows[key]["elapsed"]) for key in group["rows"]),
    } for group in groups.values()]
    result_groups.sort(key=lambda group: -group["mean_cores"])
    remainder = busy - sum(row["cpu"] for row in rows.values())
    result = {
        "v": 1, "window": {"from": start, "to": end},
        "host": {
            "ncpu": ncpu, "busy_cores_mean": ratio(busy, elapsed),
            "busy_pct": min(100.0, ratio(busy * 100, elapsed * ncpu)),
            "psi": {field.replace("_us", "_pct"): percent(value, psi_elapsed[field]) for field, value in psi.items()},
        },
        "groups": result_groups, "cgroups": cgroups,
        "unattributed": {"mean_cores": ratio(remainder, elapsed), "share": ratio(remainder, busy)},
        "coverage": coverage,
    }

    def rounded(value):
        if isinstance(value, float):
            return round(value, 3)
        if isinstance(value, list):
            return [rounded(item) for item in value]
        if isinstance(value, dict):
            return {key: rounded(item) for key, item in value.items()}
        return value

    return rounded(result)


def main():
    parser = Arguments()
    subcommands = parser.add_subparsers(dest="command", required=True, parser_class=Arguments)
    run = subcommands.add_parser("run")
    run.add_argument("--once", action="store_true")
    run.add_argument("--now", type=int)
    run.add_argument("--mono", type=int)
    run.add_argument("--boot")
    run.add_argument("--count", type=int)
    run.add_argument("--interval", type=float, default=10)
    query = subcommands.add_parser("report")
    query.add_argument("--from", dest="start", required=True, type=int)
    query.add_argument("--to", dest="end", required=True, type=int)
    args = parser.parse_args()
    if args.command == "report" and (args.end <= args.start or args.end - args.start > DAY_MS):
        parser.error("window")
    if args.command == "run" and (args.interval <= 0 or args.count is not None and args.count <= 0):
        parser.error("interval")
    try:
        settings = config()
        if args.command == "report":
            print(json.dumps(report(settings, args.start, args.end), separators=(",", ":")))
            return 0
        sampler = Sampler(settings)
        count = 0
        while True:
            t = args.now if args.now is not None else time.time_ns() // 1_000_000
            mono = args.mono if args.mono is not None else time.monotonic_ns()
            boot = args.boot if args.boot is not None else text(sampler.proc / "sys/kernel/random/boot_id").strip()
            sampler.tick(t, mono, boot)
            count += 1
            if args.once or args.count is not None and count >= args.count:
                return 0
            time.sleep(args.interval)
    except Exception:
        # Exception messages can contain inspected paths or subprocess output.
        print("host-load sampler: operation failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
