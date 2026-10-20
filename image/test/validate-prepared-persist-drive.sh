#!/usr/bin/env bash
# Validate an image already assigned host GPT identities before a QEMU reboot.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: validate-prepared-persist-drive.sh image work-dir' >&2; exit 2; }
image=$1
work=$2
[[ -f $image && -d $work ]] || { echo 'Prepared image and work directory must exist.' >&2; exit 1; }
for tool in sfdisk jq mcopy awk; do
    command -v "$tool" >/dev/null || { echo "Required prepared-image validation tool is missing: $tool" >&2; exit 1; }
done
[[ $(stat -Lc %s "$image") == 4294967296 ]] || { echo 'Prepared test image must be exactly 4 GiB.' >&2; exit 1; }
table=$(sfdisk --json "$image")
jq -e '
  .partitiontable
  | select(.label == "gpt" and .sectorsize == 512 and (.partitions | length) == 5)
  | .partitions as $p
  | ([ .id, $p[].uuid ] | map(ascii_downcase) as $ids | ($ids | all(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and all(. != "00000000-0000-0000-0000-000000000000") and (unique | length == 6)))
    and ($p[0].name == "BIOS" and ($p[0].type | ascii_upcase) == "21686148-6449-6E6F-744E-656564454649")
    and ($p[1].name == "AISBOOT" and ($p[1].type | ascii_upcase) == "C12A7328-F81F-11D2-BA4B-00A0C93EC93B")
    and ($p[2].name == "AISBASE" and ($p[2].type | ascii_upcase) == "0FC63DAF-8483-4772-8E79-3D69D8477DE4")
    and ($p[3].name == "AISX" and ($p[3].type | ascii_upcase) == "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7")
    and ($p[4].name == "AISPERSIST")
    and (($p[4].type | ascii_upcase) == "CA7D7CCB-63ED-4C53-861C-1742536059CC" or ($p[4].type | ascii_upcase) == "8309")
' <<<"$table" >/dev/null || { echo 'Prepared image does not have five unique host-assigned GPT partitions including AISPERSIST.' >&2; exit 1; }
base=$(jq -er '.partitiontable.partitions[2].uuid | ascii_downcase' <<<"$table")
exchange=$(jq -er '.partitiontable.partitions[3].uuid | ascii_downcase' <<<"$table")
drive=$(jq -er '.partitiontable.partitions[4].uuid | ascii_downcase' <<<"$table")
esp=$(jq -er '.partitiontable.partitions[1].start' <<<"$table")
fat="$image@@$((esp * 512))"
for config in syslinux/syslinux.cfg boot/grub/grub.cfg; do
    extracted="$work/$(basename "${config//\//-}").prepared"
    mcopy -i "$fat" "::$config" "$extracted"
    AIS_BASE=$base AIS_EXCHANGE=$exchange AIS_DRIVE=$drive awk '
      /^[[:space:]]*(APPEND|linux)[[:space:]]/ {
        delete counts
        delete required
        for (i = 1; i <= NF; i++) counts[$i]++
        mode_count = 0
        expected_mode = ""
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^ais[.]mode=/) {
            mode_count++
            expected_mode = substr($i, 10)
          }
        }
        if (mode_count != 1 || expected_mode !~ /^(latest|pick|clean)$/) exit 1
        required["archisobasedir=arch"] = 1
        required["archisodevice=/dev/disk/by-partuuid/" ENVIRON["AIS_BASE"]] = 1
        required["ais.base=" ENVIRON["AIS_BASE"]] = 1
        required["ais.exchange=" ENVIRON["AIS_EXCHANGE"]] = 1
        required["ais.drive=" ENVIRON["AIS_DRIVE"]] = 1
        required["copytoram=n"] = 1
        required["ais.mode=" expected_mode] = 1
        for (token in required) if (counts[token] != 1) exit 1
        for (token in counts) {
          if (token ~ /^(archiso|ais[.]base=|ais[.]exchange=|ais[.]drive=|ais[.]mode=|copytoram|cow_|img_|dm_snap_prefix)/ && !(token in required)) exit 1
          if (token ~ /^ais[.]mode=/ && token != "ais.mode=" expected_mode) exit 1
        }
        count++
      }
      END { if (count != 3) exit 1 }
    ' "$extracted" || { echo "$config does not match the prepared GPT identities and copytoram contract." >&2; exit 1; }
done
printf 'persist-drive: verified already-prepared ais.base=%s ais.exchange=%s ais.drive=%s\n' "$base" "$exchange" "$drive"
