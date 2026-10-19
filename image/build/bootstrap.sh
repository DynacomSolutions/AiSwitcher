#!/usr/bin/env bash
# Extract the pinned Arch bootstrap tarball into <root> and point pacman at
# the dated archive. Needs root (ownership in the tarball). No container runtime.
# Usage: bootstrap.sh <root> [download-dir]
set -euo pipefail

root=${1:?usage: bootstrap.sh <root> [download-dir]}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../pins.env
. "$here/../pins.env"
dl=${2:-$(dirname "$root")}

mkdir -p "$dl" "$root"
tarball="$dl/$ARCH_BOOTSTRAP_FILE"
if [ ! -f "$tarball" ]; then
  curl --fail --silent --show-error --location --retry 3 --max-time 600 -o "$tarball" "$ARCH_BOOTSTRAP_URL"
fi
# Verify before extraction; a mismatch deletes the download and fails.
if ! echo "$ARCH_BOOTSTRAP_SHA256  $tarball" | sha256sum -c --quiet -; then
  rm -f "$tarball"
  echo "bootstrap: sha256 mismatch for $ARCH_BOOTSTRAP_FILE" >&2
  exit 1
fi

tar --zstd --numeric-owner -xpf "$tarball" -C "$root" --strip-components=1

echo "Server = https://archive.archlinux.org/repos/$ARCH_ARCHIVE_DATE/\$repo/os/\$arch" >"$root/etc/pacman.d/mirrorlist"
# The pacman download sandbox needs kernel features a plain chroot may lack.
sed -i '/^\[options\]/a DisableSandbox' "$root/etc/pacman.conf"
