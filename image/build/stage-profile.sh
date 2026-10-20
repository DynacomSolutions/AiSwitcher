#!/usr/bin/env bash
# Install the runtime into a copied archiso profile: the helper scripts from
# image/lib, the compiled ais binary and vendor shims, the pinned herdr
# binary and the image build time. Optionally add the test-only
# package list. Runs as the build user; mkarchiso fixes ownership later.
# Usage: stage-profile.sh <profile-dir> <stage-dir>
#   <stage-dir>/dist/{ais,claude,codex,grok,kimi,zai,ali,pi,opencode}
#   <stage-dir>/herdr
set -euo pipefail
export LC_ALL=C

die() { echo "stage-profile: $*" >&2; exit 1; }
[[ $# == 2 ]] || die 'usage: stage-profile.sh <profile-dir> <stage-dir>'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
profile=$(realpath -e -- "$1")
stage=$(realpath -e -- "$2")
# AIS_PINS_FILE lets the unit test supply its own digests.
# shellcheck source=../pins.env
. "${AIS_PINS_FILE:-$here/../pins.env}"
root=$profile/airootfs

check_digest() {
  local file=$1 want=$2 got
  [[ -f $file && ! -L $file ]] || die "missing staged file: ${file##*/}"
  got=$(sha256sum -- "$file")
  [[ ${got%% *} == "$want" ]] || die "digest mismatch: ${file##*/}"
}

lib=$root/usr/local/lib/ais-live
install -d -m 0755 "$lib"
for file in "$repo"/image/lib/*; do
  [[ -f $file ]] || continue
  install -m 0755 -- "$file" "$lib/"
done

install -d -m 0755 "$root/usr/local/bin" "$root/usr/bin" "$root/usr/lib/ais-live/shims"
for tool in ais claude codex grok kimi zai ali pi opencode; do
  [[ -f $stage/dist/$tool && -x $stage/dist/$tool ]] || die "missing compiled tool: $tool"
done
install -m 0755 "$stage/dist/ais" "$root/usr/local/bin/ais"
ln -sfn ../local/bin/ais "$root/usr/bin/ais"
for tool in claude codex grok kimi zai ali pi opencode; do
  install -m 0755 "$stage/dist/$tool" "$root/usr/lib/ais-live/shims/$tool"
done

check_digest "$stage/herdr" "$HERDR_SHA256"
chmod 0755 "$stage/herdr"
"$repo/image/lib/install-herdr" "$stage/herdr" "$HERDR_SHA256" "$root"

# The inbox clock check compares against this marker (seconds since the epoch
# of the pinned archive day keeps the build reproducible).
sde=$(date -ud "${ARCH_ARCHIVE_DATE//\//-}" +%s)
install -d -m 0755 "$root/etc/ais"
date -ud "@$sde" +%Y-%m-%dT%H:%M:%SZ >"$root/etc/ais/image-build-time"

# mkarchiso resets file modes to 0644 unless profiledef.sh lists them, so
# record every executable file of the overlay (staged or checked in).
while IFS= read -r file; do
  printf 'file_permissions+=(["/%s"]="0:0:755")\n' "${file#"$root"/}" >>"$profile/profiledef.sh"
done < <(find "$root" -type f -perm /111 | LC_ALL=C sort)

# Test packages only on request: the shipped base stays free of build tools.
if [[ ${AIS_IMAGE_TEST_PACKAGES:-0} == 1 ]]; then
  grep -Ev '^[[:space:]]*(#|$)' "$repo/image/test/packages.test" >>"$profile/packages.x86_64"
fi
echo "stage-profile: staged $profile"
