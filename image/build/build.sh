#!/usr/bin/env bash
# Build the live ISO with mkarchiso inside a bootstrapped Arch root entered
# with chroot. Needs root. Output: out/archiso.iso and out/build-info.json.
# Usage: build.sh [workdir]   (default .build)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source=../pins.env
. "$here/../pins.env"
work=${1:-$repo/.build}
root=$work/root
out=$repo/out

log() { printf 'BUILD-STAGE: %s\n' "$*"; df -k --output=used,avail / | tail -n 1 | sed 's/^/BUILD-DF: used_kib,avail_kib= /'; }

mounted=()
cleanup() {
  local m
  for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do
    m=${mounted[$i]}
    umount -l "$m" || true
  done
}
trap cleanup EXIT

mnt() { mount "$@"; mounted+=("${@: -1}"); }

log start
"$here/bootstrap.sh" "$root" "$work/dl"
log bootstrap-done

mnt --bind "$root" "$root"
mnt -t proc proc "$root/proc"
mnt --rbind /sys "$root/sys"
mount --make-rslave "$root/sys"
mnt --rbind /dev "$root/dev"
mount --make-rslave "$root/dev"
mnt -t tmpfs tmpfs "$root/run"
mnt -t tmpfs tmpfs "$root/tmp"
cat /etc/resolv.conf >"$root/etc/resolv.conf"

in_root() { chroot "$root" /usr/bin/env -i HOME=/root TERM=dumb PATH=/usr/local/sbin:/usr/local/bin:/usr/bin LANG=C SOURCE_DATE_EPOCH="$sde" "$@"; }
sde=$(date -ud "${ARCH_ARCHIVE_DATE//\//-}" +%s)

in_root pacman-key --init
in_root pacman-key --populate archlinux
in_root pacman -Syu --noconfirm archiso grub
log archiso-installed

rm -rf "$root/build"
mkdir -p "$root/build/out"
cp -a "$repo/image/archiso" "$root/build/profile"
# AIS_STAGE_DIR holds the compiled ais tools and herdr (see stage-profile.sh).
[ -n "${AIS_STAGE_DIR:-}" ] || { echo "build: AIS_STAGE_DIR is required" >&2; exit 1; }
"$here/stage-profile.sh" "$root/build/profile" "$AIS_STAGE_DIR"
in_root mkarchiso -v -w /build/work -o /build/out /build/profile
log mkarchiso-done

mkdir -p "$out"
iso=$(find "$root/build/out" -maxdepth 1 -name '*.iso' | head -n 1)
[ -n "$iso" ] || { echo "build: mkarchiso produced no ISO" >&2; exit 1; }
cp "$iso" "$out/archiso.iso"

profile_hash=$(cd "$root/build/profile" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)
jq -n --arg baseId "${ARCH_ARCHIVE_DATE//\//-}+$profile_hash" \
  --rawfile pkgs "$root/build/work/iso/arch/pkglist.x86_64.txt" \
  '{ "base-id": $baseId, packages: ($pkgs | split("\n") | map(select(length > 0))) }' >"$out/build-info.json"
log finished
ls -l "$out"
