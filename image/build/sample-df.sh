#!/usr/bin/env bash
# Append "<epoch> <used_kib> <avail_kib>" for / to a file. With --once, take
# one sample and return, so callers get synchronous first and last samples.
# Otherwise sample every <seconds> until killed.
# Usage: sample-df.sh [--once] <file> [seconds]
set -euo pipefail
once=0
if [ "${1:-}" = "--once" ]; then once=1; shift; fi
file=${1:?usage: sample-df.sh [--once] <file> [seconds]}
every=${2:-5}
while true; do
  timestamp=$(date +%s)
  sample=$(df -k --output=used,avail / | tail -n 1)
  if [[ ! "$timestamp" =~ ^[0-9]+$ || ! "$sample" =~ ^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]*$ ]]; then
    printf 'sample-df: invalid df sample\n' >&2
    exit 1
  fi
  printf '%s %s\n' "$timestamp" "$sample" >>"$file"
  [ "$once" = 1 ] && exit 0
  sleep "$every"
done
