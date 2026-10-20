#!/usr/bin/env bash
# Build the small FAT test disk (label AISTEST) that a test boot stages through
# ais-live-test-media. No root and no mounts: mtools only.
# Usage: make-test-media.sh <out.img> <boot-flow|guard|exchange> [boot-flow case] [probe port]
set -euo pipefail
export LC_ALL=C
die() { echo "make-test-media: $*" >&2; exit 1; }
[[ $# -ge 2 ]] || die 'usage: make-test-media.sh <out.img> <scenario> [case] [port]'
out=$1 scenario=$2 case_name=${3:-} port=${4:-}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ ! -e $out ]] || die 'output already exists'
work=$(mktemp -d "$out.work.XXXXXX")
mkdir -p "$work/scripts" "$work/exchange"

# Fixtures the staging service insists on under ais.test=1.
fixture_source() { mkdir -p "$work/exchange/test-fixtures"; cp -- "$here/fixtures/boot-flow/vendor-upgrade" "$here/fixtures/boot-flow/llama-cli" "$work/exchange/test-fixtures/"; }

case $scenario in
  boot-flow)
    [[ -n $case_name ]] || die 'boot-flow needs a case'
    cp -- "$here/boot-flow-agent-checks" "$here/boot-flow-live-checks" "$work/scripts/"
    prepared=$work/prepared
    "$here/boot-flow-scenario.sh" prepare "$case_name" "$prepared" ${port:+"$port"} >/dev/null
    cp -r -- "$prepared/." "$work/exchange/"
    ;;
  guard)
    fixture_source
    cp -- "$here/guard-fixtures.sh" "$here/guard-scenarios.sh" "$here/paru-shim" "$work/scripts/"
    mkdir -p "$work/scripts/fixtures"
    cp -r -- "$here/fixtures/guard-repo" "$here/fixtures/guard-aur" "$work/scripts/fixtures/"
    cp -- "$here/guard-orchestrator" "$work/scripts/orchestrator"
    ;;
  exchange)
    [[ $case_name == basic || $case_name == auth ]] || die 'exchange needs the basic or auth group'
    fixture_source
    cp -- "$here/exchange-scenarios.sh" "$here/exchange-host.sh" "$here/exchange-fixtures.mjs" "$here/exchange-highest-outbox.mjs" "$here/exchange-capability-probe" "$work/scripts/"
    cp -- "$here/exchange-orchestrator" "$work/scripts/orchestrator"
    printf '%s\n' "$case_name" >"$work/scripts/exchange-group"
    printf '%s' SYNTHETIC_FIXTURE_exchange_passphrase >"$work/passphrase"
    : >"$work/gen-inbox"
    : >"$work/persist-tmpfs"
    date +%s >"$work/scripts/now"
    ;;
  *) die 'unknown scenario' ;;
esac

truncate -s 32M "$out"
mkfs.fat -n AISTEST "$out" >/dev/null
for item in "$work"/*; do
  [[ -e $item ]] || continue
  [[ ${item##*/} == prepared ]] && continue
  mcopy -s -i "$out" "$item" ::/
done
rm -rf -- "$work"
echo "make-test-media: $out ($scenario${case_name:+ $case_name})"
