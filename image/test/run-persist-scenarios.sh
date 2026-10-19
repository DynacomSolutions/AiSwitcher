#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

die() { printf 'persist-scenarios: %s\n' "$*" >&2; exit 1; }
[[ $# == 2 ]] || die 'usage: run-persist-scenarios.sh <image> <bios|uefi>'
image=$(realpath -e -- "$1")
firmware=$2
[[ $firmware == bios || $firmware == uefi ]] || die 'firmware must be bios or uefi'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(dirname "$(dirname "$here")")
scratch=${AIS_PERSIST_SCRATCH:-}
[[ -n $scratch && -d $scratch && -w $scratch ]] || die 'set AIS_PERSIST_SCRATCH to a writable scratch directory'
for tool in qemu-img sfdisk jq sgdisk dd sha256sum blkid; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
cache_dir=$scratch/cache-fixture
downloads=${AIS_PERSIST_DOWNLOADS_DIR:-}
cache_image=$(AIS_PERSIST_DOWNLOADS_DIR=$downloads "$here/prepare-persist-cache.sh" "$cache_dir" | sed -n 's/^persist-cache: image=//p')
[[ -f $cache_image ]] || die 'cache image was not created'

partition_hash() {
    local disk=$1 index=$2 table sector start size
    table=$(sfdisk --json "$disk")
    sector=$(jq -er '.partitiontable.sectorsize' <<<"$table")
    start=$(jq -er ".partitiontable.partitions[$index].start" <<<"$table")
    size=$(jq -er ".partitiontable.partitions[$index].size" <<<"$table")
    dd if="$disk" bs="$sector" skip="$start" count="$size" iflag=fullblock status=none | sha256sum | cut -d ' ' -f 1
}

qemu=${AIS_QEMU_BIN:-qemu-system-x86_64}
run_phase() {
    local phase=$1 mode=$2 input=$3 grow=${4:-} duplicate=${5:-} log work duplicate_hash
    log=$scratch/$firmware-$phase.log
    local -a qemu_extra=()
    if [[ $phase != clean ]]; then qemu_extra+=(-drive "file=$cache_image,if=virtio,format=raw,readonly=on"); fi
    if [[ $phase == retry || $phase == verify-pick ]]; then
        qemu_extra+=('-netdev' 'user,id=persisttest,restrict=on' '-device' 'virtio-net-pci,netdev=persisttest')
    fi
    if [[ -n $duplicate ]]; then
        duplicate_hash=$(sha256sum "$duplicate" | cut -d ' ' -f 1)
        qemu_extra+=(-drive "file=$duplicate,if=virtio,format=raw")
    fi
    if AIS_PERSIST_PHASE=$phase AIS_PERSIST_GROW=$grow AIS_TEST_MODE=$mode \
        AIS_TEST_ARGS="ais.scenario=persist ais.persist-phase=$phase" \
        AIS_QEMU_DRIVER="$here/persist.exp" AIS_QEMU_BIN=$qemu \
        "$repo/image/test/run-qemu.sh" "$input" "$firmware" "${qemu_extra[@]}" >"$log" 2>&1; then
        :
    else
        cat "$log" >&2
        die "phase $phase failed; log: $log"
    fi
    bash "$here/check-persist-serial.sh" "$log" || die "phase $phase leaked a synthetic passphrase to serial output: $log"
    if [[ -n $duplicate ]]; then
        [[ $(sha256sum "$duplicate" | cut -d ' ' -f 1) == "$duplicate_hash" ]] || die "phase $phase modified duplicate-label disk: $duplicate"
    fi
    work=$(sed -n 's/^qemu-test: work files: //p' "$log" | tail -n 1)
    [[ -n $work && -f $work/live.img ]] || die "phase $phase did not preserve its working image"
    printf 'persist-scenarios: phase=%s firmware=%s log=%s\n' "$phase" "$firmware" "$log"
    printf '%s\n' "$work/live.img"
}

duplicate_disk=$scratch/duplicate-ais-labels.img
cp --reflink=auto -- "$image" "$duplicate_disk"
sgdisk -G "$duplicate_disk" >/dev/null
duplicate_table=$(sfdisk --json "$duplicate_disk")
duplicate_sector=$(jq -er '.partitiontable.sectorsize' <<<"$duplicate_table")
for entry in 'AISBOOT:2' 'AISBASE:3' 'AISX:4'; do
    label=${entry%%:*}
    index=$((${entry##*:} - 1))
    start=$(jq -er ".partitiontable.partitions[$index].start" <<<"$duplicate_table")
    size=$(jq -er ".partitiontable.partitions[$index].size" <<<"$duplicate_table")
    found=$(blkid -p -o value -s LABEL -O "$((start * duplicate_sector))" -S "$((size * duplicate_sector))" "$duplicate_disk") || die "cannot read filesystem label $label from duplicate disk"
    [[ $found == "$label" ]] || die "duplicate disk partition $index has filesystem label $found, expected $label"
done
printf '%s' 'SYNTHETIC_FIXTURE_duplicate_AIS_labels_sentinel' | dd of="$duplicate_disk" bs=1 seek=$((64 * duplicate_sector)) conv=notrunc status=none
for label in AISBOOT AISBASE AISX; do
    jq -e --arg label "$label" '[.partitiontable.partitions[].name] | index($label) != null' <<<"$duplicate_table" >/dev/null || die "duplicate-label disk lacks partition label $label"
done
duplicate_hash=$(sha256sum "$duplicate_disk" | cut -d ' ' -f 1)
# p4 is AISX, which shutdown legitimately updates with the final outbox.
# QEMU rewrites the ESP menu between boots, and shutdown writes AISX. The
# creation hook's independent sfdisk harness covers all existing p1-p4 bytes.
declare -a original_partition_hashes=()
for partition in 0 2; do original_partition_hashes[partition]=$(partition_hash "$image" "$partition"); done
current=$(run_phase created latest "$image" 4G "$duplicate_disk" | tail -n 1)
[[ $(sha256sum "$duplicate_disk" | cut -d ' ' -f 1) == "$duplicate_hash" ]] || die 'first-boot creation modified duplicate-label sentinel disk'
for partition in 0 2; do
    [[ $(partition_hash "$current" "$partition") == "${original_partition_hashes[$partition]}" ]] || die "first-boot creation modified existing partition $((partition + 1))"
done
[[ $(stat -c %s "$current") -eq 4294967296 ]] || die 'grown test disk is not exactly 4 GiB'
table=$(sfdisk --json "$current")
sectorsize=$(jq -er '.partitiontable.sectorsize' <<<"$table")
sectors=$(( $(stat -c %s "$current") / sectorsize ))
lastlba=$(jq -er '.partitiontable.lastlba' <<<"$table")
persist_start=$(jq -er '.partitiontable.partitions[4].start' <<<"$table")
persist_size=$(jq -er '.partitiontable.partitions[4].size' <<<"$table")
persist_end=$((persist_start + persist_size - 1))
(( sectors == 8388608 && lastlba == sectors - 34 && persist_end <= lastlba && lastlba - persist_end <= 2048 )) || die 'p5 does not reach the final usable GPT alignment range'
gpt_log=$scratch/gpt-verify.log
sgdisk -v "$current" >"$gpt_log" 2>&1 || die "GPT verification failed: $gpt_log"
grep -q 'No problems found' "$gpt_log" || die "backup GPT was not relocated cleanly: $gpt_log"
current=$(run_phase package latest "$current" | tail -n 1)
current=$(run_phase retry latest "$current" | tail -n 1)
current=$(run_phase verify-package latest "$current" | tail -n 1)
current=$(run_phase wrong-pass latest "$current" | tail -n 1)

persist_start=$(sfdisk --json "$current" | jq -er '.partitiontable.partitions[4].start')
persist_size=$(sfdisk --json "$current" | jq -er '.partitiontable.partitions[4].size')
before_hash=$(dd if="$current" bs=512 skip="$persist_start" count="$persist_size" iflag=fullblock status=none | sha256sum | cut -d ' ' -f 1)
clean_copy=$(run_phase clean clean "$current" '' "$duplicate_disk" | tail -n 1)
after_hash=$(dd if="$clean_copy" bs=512 skip="$persist_start" count="$persist_size" iflag=fullblock status=none | sha256sum | cut -d ' ' -f 1)
[[ $before_hash == "$after_hash" ]] || die 'clean mode changed the persistence partition'
current=$(run_phase pick pick "$clean_copy" | tail -n 1)
for ((pick_round=1; pick_round<=4; pick_round++)); do
    current=$(run_phase pick pick "$current" | tail -n 1)
done
current=$(run_phase verify-pick latest "$current" | tail -n 1)
current=$(run_phase retention latest "$current" | tail -n 1)
printf 'persist-scenarios: all phases passed; final image=%s\n' "$current"
