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


case ${1:-} in
  agent-ids)
    [[ $# == 4 ]] || die 'usage: persist-contracts.sh agent-ids <passwd> <group> <output>'
    mkdir -p -- "$(dirname -- "$4")"
    agent_ids "$2" "$3" "$4"
    ;;
  *) die 'usage: persist-contracts.sh agent-ids <passwd> <group> <output>' ;;
esac
