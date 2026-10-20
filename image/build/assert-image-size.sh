#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && $1 =~ ^[0-9]+$ ]] || { echo 'usage: assert-image-size.sh <bytes>' >&2; exit 2; }
(( $1 < 2 * 1024 * 1024 * 1024 )) || { echo 'image exceeds the 2 GiB release limit' >&2; exit 1; }
