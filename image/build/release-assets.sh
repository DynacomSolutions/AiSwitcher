#!/usr/bin/env bash
set -euo pipefail
set +x
[[ $# == 2 ]] || { echo 'usage: release-assets.sh <img> <outdir>' >&2; exit 2; }
img=$(realpath -e -- "$1")
outdir=$2
[[ -f $img ]] || { echo 'image must be a regular file' >&2; exit 1; }
mkdir -p -- "$outdir"
outdir=$(realpath -e -- "$outdir")
image_bytes=$(stat -c %s "$img")
bash "$(dirname "${BASH_SOURCE[0]}")/assert-image-size.sh" "$image_bytes"
install -m 0644 -- "$img" "$outdir/ais-live.img"
printf '%s  ais-live.img\n' "$(sha256sum "$outdir/ais-live.img" | cut -d ' ' -f 1)" > "$outdir/SHA256SUMS"
if [[ -n ${MINISIGN_SECRET_KEY:-} ]]; then
    command -v minisign >/dev/null || { echo 'minisign is required when signing is enabled' >&2; exit 1; }
    [[ -n ${RUNNER_TEMP:-} && -d $RUNNER_TEMP ]] || { echo 'RUNNER_TEMP must be set to a directory when signing is enabled' >&2; exit 1; }
    key_file=$(mktemp "$RUNNER_TEMP/minisign-key.XXXXXX")
    trap 'rm -f -- "$key_file"' EXIT
    chmod 600 "$key_file"
    printf '%s\n' "$MINISIGN_SECRET_KEY" > "$key_file"
    printf '%s\n' "${MINISIGN_PASSWORD:-}" | minisign -S -s "$key_file" -x "$outdir/SHA256SUMS.minisig" -m "$outdir/SHA256SUMS"
    minisign -Vm "$outdir/SHA256SUMS" -p image/release/minisign.pub >/dev/null
fi
