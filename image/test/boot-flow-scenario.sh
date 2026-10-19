#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'usage: boot-flow-scenario.sh <scenario> [gateway-port] | prepare <scenario> <empty-destination> [gateway-port]' >&2
  exit 2
}

mode=plan
if [[ ${1:-} == prepare ]]; then
  mode=prepare
  (( $# >= 3 && $# <= 4 )) || usage
  scenario=$2
  destination=$3
  gateway_port=${4:-}
else
  (( $# >= 1 && $# <= 2 )) || usage
  scenario=$1
  gateway_port=${2:-}
fi
runs=1
case "$scenario" in
  online-first|online-second|online-retry|accounts|vendor|c7)
    [[ "$gateway_port" =~ ^[0-9]{1,5}$ ]] || usage
    ((10#$gateway_port > 0 && 10#$gateway_port <= 65535)) || usage
    network=user
    vendor_mode=stub
    [[ "$scenario" != online-retry ]] || vendor_mode=stub-fail-first
    kernel_args=(ais.test=1 ais.scenario=boot-flow "ais.probe=gateway:$((10#$gateway_port))" "ais.vendor=$vendor_mode")
    fixtures=(vendor-upgrade llama-cli)
    [[ "$scenario" != online-retry && "$scenario" != online-second ]] || runs=2
    ;;
  offline-model-yes|offline-model-no|offline-model-timeout)
    [[ -z "$gateway_port" ]] || usage
    network=none
    kernel_args=(ais.test=1 ais.scenario=boot-flow ais.mode=clean ais.vendor=stub)
    fixtures=(vendor-upgrade llama-cli model)
    ;;
  offline-no-model)
    [[ -z "$gateway_port" ]] || usage
    network=none
    kernel_args=(ais.test=1 ais.scenario=boot-flow ais.mode=clean ais.vendor=stub)
    fixtures=(vendor-upgrade llama-cli)
    ;;
  *) usage ;;
esac
if [[ "$mode" == prepare ]]; then
  [[ ! -e "$destination" || -d "$destination" && ! -L "$destination" ]] || {
    echo 'fixture destination must be a real directory' >&2
    exit 2
  }
  mkdir -p -- "$destination"
  [[ -z "$(/usr/bin/find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo 'fixture destination must be empty' >&2
    exit 2
  }
  source_dir=$(cd -- "$(dirname -- "$0")/fixtures/boot-flow" && pwd -P)
  mkdir -p "$destination/test-fixtures" "$destination/models"
  for fixture in "${fixtures[@]}"; do
    case "$fixture" in
      vendor-upgrade) cp -- "$source_dir/vendor-upgrade" "$destination/test-fixtures/vendor-upgrade"; chmod 0755 "$destination/test-fixtures/vendor-upgrade" ;;
      llama-cli) cp -- "$source_dir/llama-cli" "$destination/test-fixtures/llama-cli"; chmod 0755 "$destination/test-fixtures/llama-cli" ;;
      model) cp -- "$source_dir/model.gguf" "$destination/models/model.gguf"; cp -- "$source_dir/manifest.json" "$destination/models/manifest.json" ;;
      *) echo "unknown fixture '$fixture'" >&2; exit 2 ;;
    esac
  done
fi
printf 'scenario=%s\nnetwork=%s\nruns=%s\n' "$scenario" "$network" "$runs"
[[ "$mode" != prepare ]] || printf 'fixture_destination=%s\n' "$destination"
printf 'kernel_arg=%s\n' "${kernel_args[@]}"
for fixture in "${fixtures[@]}"; do printf 'fixture=%s\n' "$fixture"; done
printf 'driver=image/test/boot-flow.exp\nnetwork=%s\n' "$network"
printf 'qemu_nic=%s\n' "$network"
printf 'expected=stage:net\nexpected=stage:net-prompt\nexpected=stage:local-model-offer\nexpected=stage:vendor-cli-install\nexpected=stage:launch\n'
case "$scenario" in
  online-first|online-second|accounts|vendor|c7) printf 'vendor_status=ok\n' ;;
  online-retry) printf 'vendor_status=fail,ok\n' ;;
  *) printf 'vendor_status=skip\n' ;;
esac
if [[ "$scenario" == online-second ]]; then printf 'requires=successful-first-boot-in-same-driver-run\n'; fi
if [[ "$scenario" == online-retry ]]; then printf 'requires=first-failure-then-success-with-same-config\n'; fi
