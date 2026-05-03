#!/usr/bin/env bash
# replace-snippet.sh — sync a `@ozzylabs/skills` snippet into a consumer-owned file.
#
# Usage:
#   replace-snippet.sh <target> <snippet>
#
# Behavior:
#   - If <target> exists AND contains the begin marker → replace the marker
#     block (begin..end inclusive) with the contents of <snippet>.
#   - Otherwise (file missing OR marker absent) → append <snippet> to
#     <target> (creating the file and parent directories if needed). This
#     auto-recovers from upstream tooling (e.g. commons sync) that overwrites
#     the file and strips the marker block. See ozzy-labs/skills#33.
#
# The snippet itself contains the begin/end markers, so the recovered file is
# immediately re-syncable on subsequent runs.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <target> <snippet>" >&2
  exit 2
fi

target="$1"
snippet="$2"

readonly BEGIN_MARKER='<!-- begin: @ozzylabs/skills -->'

if [[ ! -f "${snippet}" ]]; then
  echo "Error: snippet file not found: ${snippet}" >&2
  exit 1
fi

append_snippet() {
  mkdir -p "$(dirname "${target}")"
  if [[ -s "${target}" ]]; then
    # Ensure the existing file ends with exactly one newline before adding a
    # blank-line separator. Bash's $() strips trailing newlines, so an empty
    # capture means the last byte already is a newline.
    if [[ -n "$(tail -c 1 "${target}" 2>/dev/null)" ]]; then
      printf '\n' >>"${target}"
    fi
    printf '\n' >>"${target}"
  fi
  cat "${snippet}" >>"${target}"
  echo "replace-snippet: appended snippet to ${target} (marker missing or file absent)"
}

if [[ ! -f "${target}" ]] || ! grep -qF "${BEGIN_MARKER}" "${target}"; then
  append_snippet
  exit 0
fi

awk -v snippet_file="${snippet}" '
  BEGIN { in_block = 0 }
  /<!-- begin: @ozzylabs\/skills -->/ && !in_block {
    while ((getline line < snippet_file) > 0) print line
    close(snippet_file)
    in_block = 1
    next
  }
  /<!-- end: @ozzylabs\/skills -->/ && in_block {
    in_block = 0
    next
  }
  !in_block { print }
' "${target}" >"${target}.tmp"
mv "${target}.tmp" "${target}"
