#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

die() { printf 'persist-cache: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die 'usage: prepare-persist-cache.sh <new-output-directory>'
out=$(realpath -m -- "$1")
[[ ! -e "$out" && ! -L "$out" ]] || die 'output already exists'
for tool in bsdtar zstd repo-add mke2fs sha256sum; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
downloads=${AIS_PERSIST_DOWNLOADS_DIR:-}
[[ -n $downloads && -d $downloads ]] || die 'set AIS_PERSIST_DOWNLOADS_DIR to the authorised downloads directory'
# Pinned Arch Linux Archive package (2026/10/01). The SHA-256 pin is checked
# here; the guest pacman transaction verifies the detached Arch package
# signature with its trusted keyring before installing this harmless fixture.
package_name='tree-2.2.1-1-x86_64.pkg.tar.zst'
package_sha256=043cb98b8c386d2dc4db397238775fb8e8c2e34a37530c3d34e38154ea3900cf
source_package=$downloads/$package_name
source_signature=$source_package.sig
[[ -f $source_package && -f $source_signature ]] || die "missing pinned package or signature: $package_name"
printf '%s  %s\n' "$package_sha256" "$source_package" | sha256sum -c --quiet - || die 'pinned package checksum mismatch'
mkdir -p -- "$out"
tree=$out/tree
mkdir -p "$tree/repo"
cp -- "$source_package" "$source_signature" "$tree/repo/"
repo-add "$tree/repo/ais-test.db.tar.gz" "$tree/repo/$package_name" >/dev/null
truncate -s 64M "$out/cache.img"
mke2fs -q -t ext4 -F -L AIS_TEST_CACHE -m 0 -d "$tree" "$out/cache.img"
printf 'persist-cache: image=%s\n' "$out/cache.img"
