#!/bin/sh
# usage: install-freshness.sh <from-rev> <to-rev>
#
# Merging upstream installs nothing: the runner every consumer resolves is the immutable tree a past
# `install` published, so a fix can sit merged in main while the machine keeps running the old build
# and nothing says so. This reports that drift at the one moment the new code arrives locally.
#
# Warn, never install: publishing a build the operator did not ask for is worse than a stale one.
# Never fail: git ignores these hooks' exit status, so a silent exit would be indistinguishable from
# a clean check — every precondition that cannot be met says so on stderr instead.
set -u

[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || exit 0
# Unreadable revs (no ORIG_HEAD, a fresh clone) make this non-zero, which checks rather than skips.
git diff --quiet "$1" "$2" -- src tsconfig.json package.json pnpm-lock.yaml 2>/dev/null && exit 0

for tool in pnpm remote-runner; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "remote-runner: install freshness unchecked — $tool is not on PATH" >&2
    exit 0
  }
done

if ! pnpm build >/dev/null; then
  echo "remote-runner: install freshness unchecked — pnpm build failed, and it clears dist first: run 'pnpm install && pnpm build'" >&2
  exit 0
fi

remote-runner install --check
# 0 current, 1 stale, 70 undeterminable — each already said so. 2 is the transitional case: the
# installed runner is old enough to reject the flag, which is itself the drift being looked for.
[ "$?" -eq 2 ] && echo "remote-runner: the installed runner predates 'install --check' — run 'pnpm verify && node dist/src/main.js install' once" >&2
exit 0
