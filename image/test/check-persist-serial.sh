#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 || $# == 6 ]] || { printf 'persist-serial: usage: check-persist-serial.sh <serial-log> [--ambiguity <latest|clean> <baseline-sha256> <boot-disk> <clone-disk>]\n' >&2; exit 2; }
[[ -f $1 ]] || { printf 'persist-serial: serial log is missing\n' >&2; exit 2; }
for secret in SYNTHETIC_FIXTURE_ais_live_persist_passphrase SYNTHETIC_FIXTURE_ais_live_wrong_passphrase; do
    if grep -Fq -- "$secret" "$1"; then
        printf 'persist-serial: synthetic passphrase leaked to serial output\n' >&2
        exit 1
    fi
done
if [[ $# == 6 ]]; then
    [[ $2 == --ambiguity && ( $3 == latest || $3 == clean ) ]] || { printf 'persist-serial: invalid ambiguity assertion\n' >&2; exit 2; }
    marker="AIS-LIVE: stage=boot-identity status=refused reason=ambiguous-base mode=$3"
    tr -d '\r' <"$1" | grep -Fqx -- "$marker" || { printf 'persist-serial: expected ambiguity refusal marker is missing\n' >&2; exit 1; }
    if tr -d '\r' <"$1" | grep -Eq 'AIS-LIVE: stage=persist status=ok|AIS-LIVE: stage=first-boot-create status=ok'; then
        printf 'persist-serial: ambiguous boot continued into persistence setup\n' >&2
        exit 1
    fi
    expected=$4
    shift 4
    for disk in "$@"; do
        [[ -f $disk ]] || { printf 'persist-serial: ambiguity disk is missing\n' >&2; exit 1; }
        actual=$(sha256sum "$disk" | cut -d ' ' -f 1)
        [[ $actual == "$expected" ]] || { printf 'persist-serial: ambiguous boot modified a disk image\n' >&2; exit 1; }
    done
fi
