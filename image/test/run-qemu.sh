#!/usr/bin/env bash
# Boot a disposable raw image copy. Extra arguments are passed to QEMU.
# AIS_QEMU_DRIVER selects another expect scenario; AIS_TEST_ARGS supplies its
# kernel parameters. The default driver only verifies boot and clean shutdown.
set -euo pipefail
export LC_ALL=C
die() { echo "qemu-test: $*" >&2; exit 1; }
[[ $# -ge 2 ]] || die 'usage: run-qemu.sh <img> <bios|uefi> [extra qemu args]'
image=$(realpath -e -- "$1")
firmware=$2
shift 2
[[ -f $image ]] || die 'image must be a regular file'
case $firmware in bios|uefi) ;; *) die 'firmware must be bios or uefi' ;; esac
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d "${AIS_QEMU_WORK_ROOT:-$(dirname "$image")}/qemu-$firmware.XXXXXX")
copy=$work/live.img
cp --reflink=auto --sparse=always -- "$image" "$copy"
printf 'qemu-test: work files: %s\n' "$work"

esp_start=$(sfdisk --json "$copy" | jq -er '.partitiontable | select(.label == "gpt" and .sectorsize == 512) | .partitions[1] | select(.name == "AISBOOT" and (.type | ascii_upcase) == "C12A7328-F81F-11D2-BA4B-00A0C93EC93B") | .start')
fat="$copy@@$((esp_start * 512))"
test_args=${AIS_TEST_ARGS:-ais.smoke=1}
mode=${AIS_TEST_MODE:-clean}
case $mode in latest|pick|clean) ;; *) die 'invalid test boot mode' ;; esac
[[ $test_args != *$'\n'* && $test_args != *$'\r'* ]] || die 'kernel parameters must be one line'
# Configs are text files on the ESP, never patched in the original image.
for config in syslinux/syslinux.cfg boot/grub/grub.cfg; do
    mcopy -i "$fat" "::$config" "$work/menu.original"
    AIS_MENU_ARGS="console=ttyS0,115200 ais.test=1 $test_args" AIS_MENU_MODE="$mode" awk '
        /^[[:space:]]*(APPEND|linux)[[:space:]]/ {
            gsub(/ais.mode=(latest|pick|clean)/, "ais.mode=" ENVIRON["AIS_MENU_MODE"])
            $0 = $0 " " ENVIRON["AIS_MENU_ARGS"]
            count++
        }
        { print }
        END { if (count != 3) exit 1 }
    ' "$work/menu.original" > "$work/menu.patched"
    mcopy -o -i "$fat" "$work/menu.patched" "::$config"
done

accel=tcg
cpu=max
boot_timeout=600
if [[ -r /dev/kvm && -w /dev/kvm ]]; then accel=kvm; cpu=host; boot_timeout=180; fi
qemu=${AIS_QEMU_BIN:-qemu-system-x86_64}
args=(-machine "q35,accel=$accel" -cpu "$cpu" -m 2048 -smp 2 -no-reboot
    -nographic -monitor none -serial stdio -nic none
    -drive "file=${copy//,/,,},if=virtio,format=raw")
if [[ $firmware == uefi ]]; then
    code=${AIS_OVMF_CODE:-}
    vars=${AIS_OVMF_VARS:-}
    if [[ -n $code && -z $vars || -z $code && -n $vars ]]; then
        die 'set both AIS_OVMF_CODE and AIS_OVMF_VARS'
    fi
    if [[ -z $code ]]; then
        for pair in /usr/share/OVMF/OVMF_CODE_4M.fd:/usr/share/OVMF/OVMF_VARS_4M.fd \
            /usr/share/edk2/x64/OVMF_CODE.4m.fd:/usr/share/edk2/x64/OVMF_VARS.4m.fd \
            /usr/share/OVMF/OVMF_CODE.fd:/usr/share/OVMF/OVMF_VARS.fd; do
            if [[ -f ${pair%:*} && -f ${pair#*:} ]]; then code=${pair%:*}; vars=${pair#*:}; break; fi
        done
    fi
    [[ -f $code && -f $vars ]] || die 'OVMF firmware pair not found'
    cp -- "$vars" "$work/OVMF_VARS.fd"
    args+=(-drive "if=pflash,format=raw,readonly=on,file=${code//,/,,}"
        -drive "if=pflash,format=raw,file=${work//,/,,}/OVMF_VARS.fd")
fi
printf 'qemu-test: firmware=%s accelerator=%s timeout=%s\n' "$firmware" "$accel" "$boot_timeout"
# Preserve driver status through tee. Scenarios may inspect the copy afterwards.
export AIS_QEMU_IMAGE_COPY=$copy AIS_QEMU_RUN_DIR=$work
expect "${AIS_QEMU_DRIVER:-$here/boot.exp}" "$boot_timeout" "$qemu" "${args[@]}" "$@" 2>&1 | tee "$work/serial.log"
