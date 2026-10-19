#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'persist-contracts: %s\n' "$*" >&2
  exit 1
}

agent_ids() {
  local passwd_file=$1 group_file=$2 output=$3
  [[ -r $passwd_file ]] || die "missing account definitions: $passwd_file"
  [[ -r $group_file ]] || die "missing group definitions: $group_file"

  if ! awk -F: '
    $1 == "agent" {
      if (++found != 1 || NF != 7 || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/) bad=1
      uid=$3
      gid=$4
    }
    END {
      if (bad || found != 1 || uid !~ /^[1-9][0-9]*$/ || gid !~ /^[1-9][0-9]*$/) exit 2
      printf "uid=%s\ngid=%s\n", uid, gid
    }
  ' "$passwd_file" >"$output.tmp"; then
    rm -f -- "$output.tmp"
    die 'agent account must exist exactly once with numeric UID and primary GID'
  fi

  local gid
  gid=$(sed -n 's/^gid=//p' "$output.tmp")
  awk -F: -v gid="$gid" '
    $3 == gid { found++ }
    END { if (found != 1) exit 1 }
  ' "$group_file" || {
    rm -f -- "$output.tmp"
    die 'agent primary GID must resolve to exactly one group'
  }

  mv -- "$output.tmp" "$output"
}

gpt_layout() {
  local image=$1 output=$2 dump=$3
  [[ -f $image ]] || die "missing assembled disk image: $image"
  command -v sfdisk >/dev/null || die 'missing tool: sfdisk'
  command -v jq >/dev/null || die 'missing tool: jq'
  sfdisk --json "$image" >"$dump"

  jq -e '
    .partitiontable as $t |
    if ($t.label == "gpt" and $t.unit == "sectors" and $t.sectorsize == 512
      and $t.firstlba == 2048 and ($t.partitions | length) == 4
      and ($t.id | type == "string" and test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"))
      and ($t.partitions[0].name == "BIOS" and $t.partitions[0].type == "21686148-6449-6E6F-744E-656564454649")
      and ($t.partitions[1].name == "AISBOOT" and $t.partitions[1].type == "C12A7328-F81F-11D2-BA4B-00A0C93EC93B" and $t.partitions[1].attrs == "LegacyBIOSBootable")
      and ($t.partitions[2].name == "AISBASE" and $t.partitions[2].type == "0FC63DAF-8483-4772-8E79-3D69D8477DE4")
      and ($t.partitions[3].name == "AISX" and $t.partitions[3].type == "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7")
      and all($t.partitions[]; (.start | type == "number" and . > 0) and (.size | type == "number" and . > 0)
        and (.uuid | type == "string" and test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"))))
    then true
    else error("invalid assembled GPT layout") end
  ' "$dump" >/dev/null || {
    rm -f -- "$output.tmp"
    die 'assembled image does not match the four-partition persist contract'
  }

  jq -r '
    .partitiontable as $t |
    "AIS-GPT-LAYOUT\t1",
    ("disk-guid\t" + ($t.id | ascii_downcase)),
    ($t.partitions | to_entries[] |
      "part\t\(.key + 1)\t\(.value.start)\t\(.value.size)\t\(.value.type | ascii_downcase)\t\(.value.uuid | ascii_downcase)\t\(.value.name)\t\(.value.attrs // "-")")
  ' "$dump" >"$output.tmp"

  awk -F '\t' '
    NR==1 && $0!="AIS-GPT-LAYOUT\t1" { exit 1 }
    NR==2 {
      if ($1!="disk-guid" || $2!~/^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/) exit 1
      disk_guid=$2
    }
    NR>=3 && NR<=6 {
      expected=NR-2
      if (NF!=8 || $1!="part" || $2!=expected || $3!~/^[1-9][0-9]*$/ || length($3)>15 || $4!~/^[1-9][0-9]*$/ || length($4)>15 || $5!~/^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/ || $6!~/^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/ || $7=="" || $6==disk_guid || uuid[$5]++ || uuid[$6]++) exit 1
      if (expected==1 && ($7!="BIOS" || $8!="-")) exit 1
      if (expected==2 && ($7!="AISBOOT" || $8!="LegacyBIOSBootable")) exit 1
      if (expected==3 && ($7!="AISBASE" || $8!="-")) exit 1
      if (expected==4 && ($7!="AISX" || $8!="-")) exit 1
    }
    END { if (NR!=6) exit 1 }
  ' "$output.tmp" || {
    rm -f -- "$output.tmp"
    die 'assembled image partition metadata is incomplete or unexpected'
  }
  mv -- "$output.tmp" "$output"
}

case ${1:-} in
  agent-ids)
    [[ $# == 4 ]] || die 'usage: persist-contracts.sh agent-ids <passwd> <group> <output>'
    mkdir -p -- "$(dirname -- "$4")"
    agent_ids "$2" "$3" "$4"
    ;;
  gpt-layout)
    [[ $# == 4 ]] || die 'usage: persist-contracts.sh gpt-layout <image> <output> <dump>'
    mkdir -p -- "$(dirname -- "$3")" "$(dirname -- "$4")"
    gpt_layout "$2" "$3" "$4"
    ;;
  *) die 'usage: persist-contracts.sh {agent-ids|gpt-layout} ...' ;;
esac
