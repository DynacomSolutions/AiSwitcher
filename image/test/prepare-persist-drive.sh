#!/usr/bin/env bash
# Apply sub-project C's creation contract to a disposable QEMU image.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: prepare-persist-drive.sh source.img destination.img' >&2; exit 2; }
source_image=$1
target=$2
[[ -f $source_image && ! -e $target && ! -L $target ]] || { echo 'Source must exist and destination must be new.' >&2; exit 1; }
[[ $(stat -Lc %s "$source_image") -lt $((4 * 1024 * 1024 * 1024)) ]] || { echo 'Test source must be smaller than 4 GiB.' >&2; exit 1; }
for tool in sgdisk sfdisk jq mcopy fallocate; do
    command -v "$tool" >/dev/null || { echo "Required host preparation tool is missing: $tool" >&2; exit 1; }
done
[[ $(sfdisk --json "$source_image" | jq -er '.partitiontable.partitions | length') == 4 ]] || exit 1
cp --sparse=always -- "$source_image" "$target"
truncate -s 4G "$target"
sgdisk -e -n 5:0:0 -t 5:8309 -c 5:AISPERSIST -G "$target" >/dev/null
table=$(sfdisk --json "$target")
base=$(jq -er '.partitiontable.partitions[2].uuid | ascii_downcase' <<<"$table")
exchange=$(jq -er '.partitiontable.partitions[3].uuid | ascii_downcase' <<<"$table")
drive=$(jq -er '.partitiontable.partitions[4].uuid | ascii_downcase' <<<"$table")
start=$(jq -er '.partitiontable.partitions[4].start' <<<"$table")
size=$(jq -er '.partitiontable.partitions[4].size' <<<"$table")
sector=$(jq -er '.partitiontable.sectorsize' <<<"$table")
# Punching a hole gives zero reads, including over the template's old backup
# GPT. This helper operates on regular test files, never on a physical device.
fallocate --punch-hole --keep-size --offset "$((start * sector))" --length "$((size * sector))" "$target"
esp=$(jq -er '.partitiontable.partitions[1].start' <<<"$table")
fat="$target@@$((esp * sector))"
for config in syslinux/syslinux.cfg boot/grub/grub.cfg; do
    original=$target.${config//\//-}.original
    patched=$target.${config//\//-}.patched
    mcopy -i "$fat" "::$config" "$original"
    awk -v base="$base" -v exchange="$exchange" -v drive="$drive" '
        /^[[:space:]]*(APPEND|linux)[[:space:]]/ {
            if (gsub(/archisodevice=\/dev\/disk\/by-partuuid\/HOST_APP_REQUIRED/, "archisodevice=/dev/disk/by-partuuid/" base) != 1) exit 1
            if (gsub(/ais[.]base=HOST_APP_REQUIRED/, "ais.base=" base) != 1) exit 1
            if (gsub(/ais[.]exchange=HOST_APP_REQUIRED/, "ais.exchange=" exchange) != 1) exit 1
            if (gsub(/ais[.]drive=HOST_APP_REQUIRED/, "ais.drive=" drive) != 1) exit 1
            if ($0 !~ /(^|[[:space:]])copytoram=n([[:space:]]|$)/) exit 1
            count++
        }
        {print}
        END {if(count != 3) exit 1}
    ' "$original" >"$patched"
    mcopy -o -i "$fat" "$patched" "::$config"
done
printf 'persist-drive: prepared ais.base=%s ais.exchange=%s ais.drive=%s\n' "$base" "$exchange" "$drive"
