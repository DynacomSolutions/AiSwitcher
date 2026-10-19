#!/usr/bin/env bash
# Run one QEMU scenario on a raw image through run-qemu.sh. Prepares the test
# media (and scratch disks, probe listener) beside the image copy.
# Usage: run-scenario.sh <img> <bios|uefi> boot-flow <case>
#        run-scenario.sh <img> <bios|uefi> guard [probe]
#        run-scenario.sh <img> <bios|uefi> exchange <basic|auth>
set -euo pipefail
export LC_ALL=C
die() { echo "run-scenario: $*" >&2; exit 1; }
[[ $# -ge 3 ]] || die 'usage: run-scenario.sh <img> <bios|uefi> <boot-flow|guard|exchange> [arg]'
image=$(realpath -e -- "$1")
firmware=$2
scenario=$3
arg=${4:-}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "${AIS_QEMU_WORK_ROOT:-$(dirname "$image")}/scenario-$scenario.XXXXXX")
media=$work/media.img
# shellcheck disable=SC2054  # QEMU option values contain commas
extra=(-device ich9-ahci,id=ahci -drive "file=${media//,/,,},if=none,id=aismedia,format=raw" -device ide-hd,drive=aismedia,bus=ahci.0)
http_pid=
cleanup() { if [[ -n $http_pid ]]; then kill "$http_pid" 2>/dev/null || true; wait "$http_pid" 2>/dev/null || true; fi; }
trap cleanup EXIT

case $scenario in
  boot-flow)
    [[ -n $arg ]] || die 'boot-flow needs a case'
    port=
    case $arg in online-*|accounts|vendor|c7) port=$((20000 + RANDOM % 20000)) ;; esac
    plan=$("$here/boot-flow-scenario.sh" "$arg" ${port:+"$port"})
    kernel_args=$(sed -n 's/^kernel_arg=//p' <<<"$plan" | tr '\n' ' ')
    network=$(sed -n 's/^network=//p' <<<"$plan" | head -n 1)
    "$here/make-test-media.sh" "$media" boot-flow "$arg" ${port:+"$port"} >/dev/null
    if [[ $network == user ]]; then
      mkdir "$work/www"
      python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/www" >"$work/http.log" 2>&1 &
      http_pid=$!
      extra+=(-nic user)
    fi
    export AIS_QEMU_DRIVER=$here/boot-flow.exp AIS_QEMU_BOOT_FLOW_SCENARIO=$arg
    export AIS_TEST_ARGS="$kernel_args"
    ;;
  guard)
    "$here/make-test-media.sh" "$media" guard >/dev/null
    for disk in vdb vdc; do truncate -s 64M "$work/$disk.img"; extra+=(-drive "file=${work//,/,,}/$disk.img,if=virtio,format=raw"); done
    extra+=(-m 3072)
    export AIS_QEMU_DRIVER=$here/guard-driver.exp
    export AIS_TEST_ARGS="ais.guard_timeout=30 cow_spacesize=1G${arg:+ ais.guard-probe=1}"
    ;;
  exchange)
    group=${arg:-basic}
    "$here/make-test-media.sh" "$media" exchange >/dev/null
    [[ $group != auth ]] || extra+=(-rtc base=2000-01-01T00:00:00)
    export AIS_QEMU_DRIVER=$here/exchange-driver.exp AIS_EXCHANGE_GROUP=$group
    export AIS_TEST_ARGS="ais.exchange=$group"
    ;;
  *) die 'unknown scenario' ;;
esac
export AIS_QEMU_WORK_ROOT=$work
echo "run-scenario: work files: $work"
"$here/run-qemu.sh" "$image" "$firmware" "${extra[@]}"
