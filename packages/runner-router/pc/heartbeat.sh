#!/usr/bin/env bash
set -u
umask 077

# shellcheck source=/dev/null
source "${HEARTBEAT_ENV:-$HOME/.config/runner-router/heartbeat.env}" || exit 1
: "${ROUTER_URL:?Missing ROUTER_URL}" "${HEARTBEAT_SECRET:?Missing HEARTBEAT_SECRET}" "${RUNNERS:?Missing RUNNERS}"

CGROUP_ROOT=${CGROUP_ROOT:-/sys/fs/cgroup}
PROC_ROOT=${PROC_ROOT:-/proc}
COUNTER_FILE=${COUNTER_FILE:-$HOME/.local/state/runner-router/counter}

IFS=$' \t\n' read -r -a entries <<< "${RUNNERS//$'\n'/ }"
for entry in "${entries[@]}"; do
  if [[ ! $entry =~ ^[a-z0-9-]+:[a-z0-9-]+$ ]]; then
    printf 'Invalid runner map entry: %s\n' "$entry" >&2
    exit 1
  fi
done

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

runners=
separator=
for entry in "${entries[@]}"; do
  unit=${entry%%:*}
  name=${entry#*:}
  state=$(systemctl --user show -p ActiveState --value "$unit" 2>/dev/null) || state=unknown
  state=$(trim "$state")
  state=${state:-unknown}
  group=$(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null) || group=
  group=$(trim "$group")
  listener=false
  if [[ -n $group && -r $CGROUP_ROOT$group/cgroup.procs ]]; then
    while IFS= read -r pid; do
      [[ $pid =~ ^[0-9]+$ ]] || continue
      comm=
      IFS= read -r comm 2>/dev/null < "$PROC_ROOT/$pid/comm" || continue
      if [[ $comm == Runner.Listener ]]; then
        listener=true
        break
      fi
    done 2>/dev/null < "$CGROUP_ROOT$group/cgroup.procs"
  fi
  state=${state//\\/\\\\}
  state=${state//\"/\\\"}
  state=${state//$'\n'/\\n}
  state=${state//$'\r'/\\r}
  state=${state//$'\t'/\\t}
  runners+=$(printf '%s{"name":"%s","unit":"%s","listener":%s}' "$separator" "$name" "$state" "$listener")
  separator=,
done

now_seconds=$(date +%s) || exit 1
[[ $now_seconds =~ ^[0-9]+$ ]] || exit 1
now_ms=$((now_seconds * 1000))
last=$(cat "$COUNTER_FILE" 2>/dev/null) || last=0
if [[ $last =~ ^[0-9]+$ ]]; then
  last=${last#"${last%%[!0]*}"}
  last=${last:-0}
  # JSON counters must remain exact in JavaScript.
  if [[ ${#last} -gt 16 ]] || ((last > 9007199254740990)); then
    last=0
  fi
else
  last=0
fi
next=$((last + 1))
((next >= now_ms)) || next=$now_ms
counter_dir=$(dirname "$COUNTER_FILE")
mkdir -p "$counter_dir" && chmod 700 "$counter_dir" || exit 1
temp=$(mktemp "$COUNTER_FILE.XXXXXX") || exit 1
trap 'rm -f "$temp"' EXIT
chmod 600 "$temp" && printf '%s\n' "$next" > "$temp" && mv -f "$temp" "$COUNTER_FILE" || exit 1

github_probe=false
curl -sS -o /dev/null -m 2 --retry 1 --retry-max-time 4 https://broker.actions.githubusercontent.com/ &
probe_pid=$!
# Curl's retry deadline does not interrupt an attempt already in progress.
(
  timer=
  trap '[[ -z $timer ]] || kill "$timer" 2>/dev/null; exit 0' TERM
  sleep 4 & timer=$!
  wait "$timer"
  kill "$probe_pid" 2>/dev/null
) >/dev/null 2>&1 &
watchdog_pid=$!
if wait "$probe_pid" 2>/dev/null; then
  github_probe=true
fi
kill "$watchdog_pid" 2>/dev/null
wait "$watchdog_pid" 2>/dev/null
body=$(printf '{"v":1,"counter":%s,"sentAt":%s,"githubProbe":%s,"runners":[%s]}' "$next" "$now_ms" "$github_probe" "$runners")
status=$(curl --config - -sS -m 3 -X POST \
  -H 'content-type: application/json' --data "$body" -o /dev/null -w '%{http_code}' \
  "$ROUTER_URL/heartbeat" <<EOF
header = "Authorization: Bearer $HEARTBEAT_SECRET"
EOF
) || exit 1
[[ $status =~ ^2[0-9][0-9]$ ]] || exit 1
