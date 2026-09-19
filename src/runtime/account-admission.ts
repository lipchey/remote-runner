export const ACCOUNT_BUSY_MARKER = "RR_ACCOUNT_BUSY\n";
export const ACCOUNT_ADMISSION_WAIT_MS = 5 * 60 * 1000;
export const ACCOUNT_ADMISSION_POLL_MS = 1000;

/* Insert after the identity flock, before exec: descriptor 8 then belongs to the same launcher
   lifetime as descriptor 9. Different profiles and generated roots share this account's slots. */
export function buildAccountAdmissionShell({
  waitMs = ACCOUNT_ADMISSION_WAIT_MS,
  pollMs = ACCOUNT_ADMISSION_POLL_MS,
}: {
  readonly waitMs?: number;
  readonly pollMs?: number;
} = {}): string {
  for (const value of [waitMs, pollMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("admission timing must be a positive safe integer");
  }
  const pollSeconds = Math.min(waitMs, pollMs) / 1000;
  return `
rr_account_cap_file="$HOME/.config/remote-runner/concurrency"
rr_account_cap=''
if [ -f "$rr_account_cap_file" ] && [ -r "$rr_account_cap_file" ]; then
  rr_account_cap=$(cat -- "$rr_account_cap_file" 2>/dev/null) || rr_account_cap=''
fi
case "$rr_account_cap" in ''|*[!0-9]*) rr_account_cap='' ;; esac
# At most nine decimal digits keeps shell integer comparisons portable; invalid means uncapped.
if [ -n "$rr_account_cap" ] && [ "\${#rr_account_cap}" -le 9 ] && [ "$rr_account_cap" -gt 0 ]; then
  rr_account_slots="$HOME/.local/state/remote-runner/slots"
  umask 077
  mkdir -p -- "$rr_account_slots"
  rr_account_parent=$(awk '/^PPid:/ { print $2 }' "/proc/$$/status") || exit 255
  rr_account_owned() {
    [ "$rr_account_parent" -gt 1 ] &&
      [ "$(awk '/^PPid:/ { print $2 }' "/proc/$$/status")" = "$rr_account_parent" ]
  }
  rr_account_now() { awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime; }
  rr_account_deadline=$(( $(rr_account_now) + ${waitMs} ))
  rr_account_check() {
    rr_account_owned || exit 255
    if [ "$(rr_account_now)" -ge "$rr_account_deadline" ]; then
      printf '%s\\n' '${ACCOUNT_BUSY_MARKER.trimEnd()}' >&2
      exit 75
    fi
  }
  rr_account_admitted=0
  # ponytail: slot scramble, not FIFO; add a real queue only if starvation is observed.
  while :; do
    rr_account_slot=1
    while [ "$rr_account_slot" -le "$rr_account_cap" ]; do
      rr_account_check
      exec 8>"$rr_account_slots/$rr_account_slot"
      if flock -n 8; then
        rr_account_check
        rr_account_admitted=1
        break
      fi
      exec 8>&-
      rr_account_slot=$((rr_account_slot + 1))
    done
    [ "$rr_account_admitted" -eq 1 ] && break
    sleep ${pollSeconds}
  done
fi
`;
}
