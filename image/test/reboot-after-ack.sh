#!/usr/bin/env bash
# Negative QMP acceptance scenario for a previously built image.
set -euo pipefail
export LC_ALL=C
[[ $# -eq 1 ]] || { echo 'usage: reboot-after-ack.sh <img>' >&2; exit 2; }
image=$1
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for firmware in bios uefi; do
    if output=$(AIS_TEST_ARGS='ais.smoke=1 ais.reboot=1' \
        bash "$here/run-qemu.sh" "$image" "$firmware" 2>&1); then
        echo "reboot-test: $firmware incorrectly passed clean shutdown" >&2
        exit 1
    fi
    if [[ $output != *'"reason": "guest-reset"'* ]]; then
        printf 'reboot-test: %s failed without guest-reset evidence\n%s\n' "$firmware" "$output" >&2
        exit 1
    fi
    printf 'reboot-test: %s rejected guest-reset after poweroff acknowledgement\n' "$firmware"
done
