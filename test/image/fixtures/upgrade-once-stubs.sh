#!/bin/bash
set -euo pipefail
# shellcheck disable=SC1090
source "$1"
state=$2
counter=$3
failure=$4
upgrade_stub() {
  if [[ "$failure" == concurrent ]]; then
    # shellcheck disable=SC2016 # This script must expand positional arguments in the child shell.
    /usr/bin/flock "$counter.lock" /bin/bash -c '
      count=0
      [[ ! -f "$1" ]] || read -r count < "$1"
      count=$((count + 1))
      printf "%s\n" "$count" > "$1"
      /usr/bin/sleep 0.25
    ' _ "$counter"
    return
  fi
  local count=0
  [[ ! -f "$counter" ]] || read -r count < "$counter"
  count=$((count + 1))
  printf '%s\n' "$count" > "$counter"
  [[ "$failure" != true || "$count" -ne 1 ]]
}
ais_upgrade_once "$state" upgrade_stub || true
ais_upgrade_once "$state" upgrade_stub
[[ -f "$counter" ]]
cat "$counter"
