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
for tool in qemu-img sfdisk jq sgdisk dd sha256sum blkid mcopy awk; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
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

gpt_identity() {
    sfdisk --json "$1" | jq -er '.partitiontable.id, .partitiontable.partitions[].uuid'
}

prepare_scenario_disk() {
    local source=$1 target=$2 mode=$3 phase=$4 esp_start fat config
    cp --reflink=auto --sparse=always -- "$source" "$target"
    esp_start=$(sfdisk --json "$target" | jq -er '.partitiontable | select(.label == "gpt" and .sectorsize == 512) | .partitions[1].start')
    fat="$target@@$((esp_start * 512))"
    for config in syslinux/syslinux.cfg boot/grub/grub.cfg; do
        local original="$target.${config//\//-}.original" patched="$target.${config//\//-}.patched"
        mcopy -i "$fat" "::$config" "$original"
        AIS_MENU_MODE=$mode AIS_MENU_ARGS="console=ttyS0,115200 ais.test=1 ais.scenario=persist ais.persist-phase=$phase" awk '
            /^[[:space:]]*(APPEND|linux)[[:space:]]/ {
                gsub(/ais.mode=(latest|pick|clean)/, "ais.mode=" ENVIRON["AIS_MENU_MODE"])
                $0 = $0 " " ENVIRON["AIS_MENU_ARGS"]
                count++
            }
            { print }
            END { if (count != 3) exit 1 }
        ' "$original" > "$patched"
        mcopy -o -i "$fat" "$patched" "::$config"
    done
}

run_ambiguity_refusal() {
    local mode=$1 prepared duplicate baseline_file log work
    prepared=$scratch/$firmware-ambiguity-$mode-prepared.img
    duplicate=$scratch/$firmware-ambiguity-$mode-clone.img
    baseline_file=$scratch/$firmware-ambiguity-$mode-baseline.sha256
    log=$scratch/$firmware-ambiguity-$mode.log
    prepare_scenario_disk "$personalised" "$prepared" "$mode" ambiguous
    if AIS_PERSIST_PHASE=ambiguous AIS_TEST_MODE=$mode \
        AIS_TEST_ARGS="ais.scenario=persist ais.persist-phase=ambiguous" \
        AIS_PERSIST_CLONE_PATH=$duplicate AIS_PERSIST_BASELINE_FILE=$baseline_file \
        AIS_QEMU_DRIVER="$here/persist.exp" AIS_QEMU_BIN=$qemu \
        "$repo/image/test/run-qemu.sh" "$prepared" "$firmware" \
        -drive "file=$duplicate,if=virtio,format=raw" >"$log" 2>&1; then
        :
    else
        cat "$log" >&2
        die "ambiguous $mode boot was not refused; log: $log"
    fi
    work=$(sed -n 's/^qemu-test: work files: //p' "$log" | tail -n 1)
    [[ -n $work && -f $work/live.img ]] || die "ambiguous $mode boot did not preserve its working image"
    [[ -f $baseline_file ]] || die "ambiguous $mode driver did not record its post-preparation baseline"
    baseline=$(<"$baseline_file")
    [[ $baseline =~ ^[0-9a-f]{64}$ ]] || die "ambiguous $mode driver recorded an invalid baseline"
    [[ $(sha256sum "$work/live.img" | cut -d ' ' -f 1) == "$baseline" ]] || die "ambiguous $mode boot disk changed after baseline"
    [[ $(sha256sum "$duplicate" | cut -d ' ' -f 1) == "$baseline" ]] || die "ambiguous $mode clone changed after baseline"
    bash "$here/check-persist-serial.sh" "$log" --ambiguity "$mode" "$baseline" "$work/live.img" "$duplicate" || die "ambiguous $mode refusal or no-write assertion failed: $log"
    printf 'persist-scenarios: phase=ambiguous mode=%s firmware=%s log=%s\n' "$mode" "$firmware" "$log"
}

qemu=${AIS_QEMU_BIN:-qemu-system-x86_64}
run_phase() {
    local phase=$1 mode=$2 input=$3 log work
    log=$scratch/$firmware-$phase.log
    local -a qemu_extra=(-drive "file=$cache_image,if=virtio,format=raw,readonly=on")
    if [[ $phase == retry || $phase == verify-pick ]]; then
        qemu_extra+=('-netdev' 'user,id=persisttest,restrict=on' '-device' 'virtio-net-pci,netdev=persisttest')
    fi
    if AIS_PERSIST_PHASE=$phase AIS_TEST_MODE=$mode \
        AIS_TEST_ARGS="ais.scenario=persist ais.persist-phase=$phase" \
        AIS_QEMU_DRIVER="$here/persist.exp" AIS_QEMU_BIN=$qemu \
        "$repo/image/test/run-qemu.sh" "$input" "$firmware" "${qemu_extra[@]}" >"$log" 2>&1; then
        :
    else
        cat "$log" >&2
        die "phase $phase failed; log: $log"
    fi
    bash "$here/check-persist-serial.sh" "$log" || die "phase $phase leaked a synthetic passphrase to serial output: $log"
    work=$(sed -n 's/^qemu-test: work files: //p' "$log" | tail -n 1)
    [[ -n $work && -f $work/live.img ]] || die "phase $phase did not preserve its working image"
    printf 'persist-scenarios: phase=%s firmware=%s log=%s\n' "$phase" "$firmware" "$log"
    printf '%s\n' "$work/live.img"
}

personalised=$scratch/$firmware-host-created.img
bash "$here/prepare-persist-drive.sh" "$image" "$personalised"
original_ids=$(gpt_identity "$image")
prepared_ids=$(gpt_identity "$personalised")
while IFS= read -r identity; do
    [[ -n $identity ]] || continue
    ! grep -Fxq -- "$identity" <<<"$prepared_ids" || die 'host preparation did not randomise every existing GPT identity'
done <<<"$original_ids"
run_ambiguity_refusal latest
run_ambiguity_refusal clean
# p4 is AISX, which shutdown legitimately updates with the final outbox.
# The ambiguity checks above compare full disk images after QEMU preparation.
declare -a original_partition_hashes=()
for partition in 0 2; do original_partition_hashes[partition]=$(partition_hash "$image" "$partition"); done
current=$(run_phase created latest "$personalised" | tail -n 1)
for partition in 0 2; do
    [[ $(partition_hash "$current" "$partition") == "${original_partition_hashes[$partition]}" ]] || die "first-boot creation modified existing partition $((partition + 1))"
done
created_ids=$(gpt_identity "$current")
[[ $created_ids == "$prepared_ids" ]] || die 'first boot changed host-assigned GPT identifiers'
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
for phase in package retry verify-package wrong-pass; do
    current=$(run_phase "$phase" latest "$current" | tail -n 1)
    [[ $(gpt_identity "$current") == "$created_ids" ]] || die "reboot phase $phase changed disk or partition GUIDs"
done

persist_start=$(sfdisk --json "$current" | jq -er '.partitiontable.partitions[4].start')
persist_size=$(sfdisk --json "$current" | jq -er '.partitiontable.partitions[4].size')
before_hash=$(partition_hash "$current" 4)
exchange_hash=$(partition_hash "$current" 3)
clean_copy=$(run_phase clean clean "$current" | tail -n 1)
after_hash=$(dd if="$clean_copy" bs=512 skip="$persist_start" count="$persist_size" iflag=fullblock status=none | sha256sum | cut -d ' ' -f 1)
[[ $before_hash == "$after_hash" ]] || die 'clean mode changed the persistence partition'
[[ $(partition_hash "$clean_copy" 3) == "$exchange_hash" ]] || die 'clean mode changed the exchange partition'
current=$(run_phase pick pick "$clean_copy" | tail -n 1)
for ((pick_round=1; pick_round<=4; pick_round++)); do
    current=$(run_phase pick pick "$current" | tail -n 1)
done
current=$(run_phase verify-pick latest "$current" | tail -n 1)
current=$(run_phase retention latest "$current" | tail -n 1)
printf 'persist-scenarios: all phases passed; final image=%s\n' "$current"
