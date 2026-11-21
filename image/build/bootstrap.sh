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
tarball_ok() { [ -f "$tarball" ] && echo "$ARCH_BOOTSTRAP_SHA256  $tarball" | sha256sum -c --quiet -; }

# Try each host in turn, three rounds. A host that is slow to connect fails in
# 20 seconds, not minutes. Every download is checked against the pinned sha256
# before extraction, so a bad or tampered copy is deleted and the next host runs.
if ! tarball_ok 2>/dev/null; then
  rm -f "$tarball"
  for round in 1 2 3; do
    for url in $ARCH_BOOTSTRAP_URLS; do
      echo "bootstrap: round $round, fetching $url" >&2
      if curl --fail --silent --show-error --location --connect-timeout 20 --max-time 600 \
        -o "$tarball" "$url" && tarball_ok; then
        break 2
      fi
      rm -f "$tarball"
    done
    if [ "$round" -lt 3 ]; then sleep $((round * 15)); fi
  done
fi
if ! tarball_ok; then
  rm -f "$tarball"
  echo "bootstrap: no host gave $ARCH_BOOTSTRAP_FILE with the pinned sha256" >&2
  exit 1
fi

tar --zstd --numeric-owner -xpf "$tarball" -C "$root" --strip-components=1

# One Server line per archive host: pacman tries the next line when a host fails.
: >"$root/etc/pacman.d/mirrorlist"
for host in $ARCH_ARCHIVE_HOSTS; do
  echo "Server = https://$host/repos/$ARCH_ARCHIVE_DATE/\$repo/os/\$arch" >>"$root/etc/pacman.d/mirrorlist"
done
# The pacman download sandbox needs kernel features a plain chroot may lack.
sed -i '/^\[options\]/a DisableSandbox' "$root/etc/pacman.conf"
