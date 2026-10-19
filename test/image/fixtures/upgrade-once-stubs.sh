#!/bin/bash
set -euo pipefail
# shellcheck disable=SC1090
source "$1"
state=$2
counter=$3
failure=$4
upgrade_stub() {
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
