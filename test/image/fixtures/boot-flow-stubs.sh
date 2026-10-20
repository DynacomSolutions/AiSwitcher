#!/bin/bash
set -euo pipefail
# shellcheck disable=SC1090,SC2034
source "$1"

calls=()
probes=0
online=false
model=false
upgrade_result=0
answer=n
mode=${2:?scenario required}

case "$mode" in
  online-first|online-second|online-retry)
    online=true
    upgrade_result=0
    ;;
  online-upgrade-fails)
    online=true
    upgrade_result=1
    ;;
  offline-yes|offline-no|offline-timeout|offline-no-model|offline-cancel-online)
    model=true
    [[ "$mode" == offline-no-model ]] && model=false
    answer=y
    [[ "$mode" == offline-no || "$mode" == offline-no-model ]] && answer=n
    [[ "$mode" == offline-timeout ]] && answer=timeout
    ;;
  *) exit 2 ;;
esac

stage() { calls+=("stage:$1:$2"); }
ais_probe() {
  probes=$((probes + 1))
  calls+=("probe:$1")
  if [[ "$mode" == offline-* && "$1" == fresh ]]; then online=false; fi
  if [[ "$mode" == offline-cancel-online && "$1" == fresh ]]; then online=true; fi
  # shellcheck disable=SC2034
  AIS_FLOW_ONLINE=$online
  # shellcheck disable=SC2034
  AIS_FLOW_MODEL=$model
}
ais_network_prompt() { calls+=(prompt); [[ "$mode" != offline-cancel-online ]]; }
ais_offer_local_model() { calls+=("offer:$answer"); [[ "$answer" == y ]]; }
ais_local_start() { calls+=(local-start); }
ais_upgrade_once() { calls+=(upgrade); return "$upgrade_result"; }
ais_launch() { calls+=(launch); printf '%s\n' "${calls[@]}"; }

ais_live_flow
