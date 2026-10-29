#!/usr/bin/env bash
# upstream-security-scan.sh — ROADMAP 0.12 / ADR 0001.
#
# Fetches upstream/main and LISTS commits since the frozen SHA that look security-relevant, as
# cherry-pick candidates under the ADR 0001 allow-list. It never applies, merges or checks out
# anything: the only write is `git fetch` (skipped with UPSTREAM_SCAN_NO_FETCH=1).
#
# A commit is a candidate when ANY of:
#   - its message matches security|CVE|vuln|fix.*crash|data loss (case-insensitive)
#   - it changes dependency lines in a package.json
#   - it touches `electron`, or preload / IPC / sandbox paths
#
# Overrides (used by the test): FROZEN_SHA, UPSTREAM_REMOTE (default upstream), UPSTREAM_BRANCH (main).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
remote="${UPSTREAM_REMOTE:-upstream}"
branch="${UPSTREAM_BRANCH:-main}"
frozen="${FROZEN_SHA:-$(sed -n 's/.*Frozen upstream SHA:\*\* `\([0-9a-f]\{40\}\)`.*/\1/p' docs/decisions/0001-upstream-strategy.md | head -1)}"
[ -n "$frozen" ] || { echo "upstream-security-scan: no frozen SHA (ADR 0001 / FROZEN_SHA)" >&2; exit 2; }

if [ "${UPSTREAM_SCAN_NO_FETCH:-0}" != "1" ]; then
  echo "fetching $remote/$branch (read-only fetch; nothing is applied)..."
  git fetch --quiet "$remote" "$branch"
fi
ref="$remote/$branch"
git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || { echo "upstream-security-scan: $ref not found" >&2; exit 2; }
git cat-file -e "$frozen^{commit}" 2>/dev/null || { echo "upstream-security-scan: frozen SHA $frozen not in repo" >&2; exit 2; }

total=$(git rev-list --count "$frozen..$ref")
echo "frozen SHA : $frozen"
echo "upstream   : $ref ($(git rev-parse --short "$ref"))"
echo "commits since freeze: $total"
echo

msg_re='security|CVE|vuln|fix.*crash|data loss'
path_re='(^|/)(preload|ipc|sandbox)[^/]*(/|$)|(^|/)[^/]*(preload|sandbox)[^/]*\.(ts|js|mjs|cjs)$|electron'
cand=0
for sha in $(git rev-list --reverse "$frozen..$ref"); do
  reasons=""
  if git log -1 --format='%s%n%b' "$sha" | grep -qiE "$msg_re"; then reasons="$reasons message"; fi
  if git diff-tree --no-commit-id --name-only -r "$sha" | grep -qiE "$path_re"; then reasons="$reasons path"; fi
  if git diff-tree --no-commit-id --name-only -r "$sha" | grep -qE '(^|/)package\.json$'; then
    if git show --format= -U0 "$sha" -- '*package.json' \
      | grep -E '^[+-][[:space:]]*"[^"]+":[[:space:]]*"[~^<>=]*[0-9]' \
      | grep -vE '"(version|engines|node)"' | grep -q .; then
      reasons="$reasons deps"
    fi
  fi
  if [ -n "$reasons" ]; then
    cand=$((cand + 1))
    printf '%s  %s  %s\n    why:%s\n' "$(git rev-parse --short "$sha")" "$(git log -1 --format=%cs "$sha")" \
      "$(git log -1 --format=%s "$sha" | cut -c1-100)" "$reasons"
  fi
done
echo
echo "cherry-pick candidates: $cand of $total (review against the ADR 0001 allow-list; none applied)"
