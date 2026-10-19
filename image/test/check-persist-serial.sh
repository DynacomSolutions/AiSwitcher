#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && -f $1 ]] || { printf 'persist-serial: usage: check-persist-serial.sh <serial-log>\n' >&2; exit 2; }
for secret in SYNTHETIC_FIXTURE_ais_live_persist_passphrase SYNTHETIC_FIXTURE_ais_live_wrong_passphrase; do
    if grep -Fq -- "$secret" "$1"; then
        printf 'persist-serial: synthetic passphrase leaked to serial output\n' >&2
        exit 1
    fi
done
