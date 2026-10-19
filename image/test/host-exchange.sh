#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly EXPECT_BIN=${AIS_EXPECT_BIN:-expect}

usage() {
  printf '%s\n' \
    'usage: host-exchange.sh fixture <inbox|auth|crafted|tamper> <mounted-exchange-root>' \
    '       host-exchange.sh verify-outbox <encrypted-file> <last-inbox-seq>' \
    '       host-exchange.sh exfat-readback <partition-device> <expected-bundle-name>' \
    '       host-exchange.sh wait-case <serial-channel> <case-name> [timeout-seconds]' >&2
}

case ${1:-} in
  fixture|verify-outbox|exfat-readback)
    exec "$SCRIPT_DIR/exchange-host.sh" "$@"
    ;;
  wait-case)
    (($# == 3 || $# == 4)) || { usage; exit 64; }
    command -v "$EXPECT_BIN" >/dev/null 2>&1 || { printf '%s\n' 'Expect is required for wait-case' >&2; exit 69; }
    exec "$EXPECT_BIN" "$SCRIPT_DIR/host-exchange.exp" "$@"
    ;;
  *)
    usage
    exit 64
    ;;
esac
