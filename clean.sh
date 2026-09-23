#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"
readonly REPO_ROOT="$SCRIPT_DIR"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--dry-run]\n' "$(basename "$0")" >&2
  exit 2
fi

readonly FIND_EXPR=(
  -type d
  \(
    -name node_modules
    -o -name .turbo
    -o -name .next
    -o -name out
    -o -name build
    -o -name dist
    -o -name coverage
    -o -name test-results
    -o -name playwright-report
    -o -name blob-report
    -o -path '*/playwright/.cache'
    -o -name chrome83-dist
  \)
  -prune
  -print0
)

removed=0
while IFS= read -r -d '' path; do
  relative_path="${path#"$REPO_ROOT/"}"
  if [[ "$DRY_RUN" == true ]]; then
    printf '[dry-run] %s\n' "$relative_path"
  else
    rm -rf -- "$path"
    printf 'removed %s\n' "$relative_path"
  fi
  ((removed += 1))
done < <(find "$REPO_ROOT" -path "$REPO_ROOT/.git" -prune -o "${FIND_EXPR[@]}")

if [[ "$DRY_RUN" == true ]]; then
  printf 'would remove %d directories\n' "$removed"
else
  printf 'removed %d directories\n' "$removed"
fi
