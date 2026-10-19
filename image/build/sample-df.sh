#!/usr/bin/env bash
# Append "<epoch> <used_kib> <avail_kib>" for / every <seconds> until killed.
# Usage: sample-df.sh <file> [seconds]
set -euo pipefail
file=${1:?usage: sample-df.sh <file> [seconds]}
every=${2:-5}
while true; do
  printf '%s %s\n' "$(date +%s)" "$(df -k --output=used,avail / | tail -n 1)" >>"$file"
  sleep "$every"
done
