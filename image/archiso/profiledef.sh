#!/usr/bin/env bash
# shellcheck disable=SC2034
# Derived from the archiso "baseline" profile, not "releng": disk and rescue
# tools are installed on demand, not preinstalled.

iso_name="ais-live"
iso_label="AIS_LIVE"
iso_publisher="ais live image"
iso_application="ais live image"
iso_version="$(date --date="@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y.%m.%d)"
install_dir="arch"
bootmodes=('bios.syslinux'
           'uefi.grub')
pacman_conf="pacman.conf"
airootfs_image_type="squashfs"
airootfs_image_tool_options=('-comp' 'xz' '-Xbcj' 'x86' '-b' '1M' '-Xdict-size' '1M')
bootstrap_tarball_compression=('zstd' '-c' '-T0' '--auto-threads=logical' '--long' '-19')
file_permissions=(
  ["/usr/local/lib/ais-live/ais-live-persist"]="0:0:755"
  ["/usr/local/lib/ais-live/ais-live-snapshot"]="0:0:755"
  ["/usr/local/lib/ais-live/ais-live-prune"]="0:0:755"
  ["/usr/local/lib/ais-live/persist-test"]="0:0:755"
  ["/etc/initcpio/hooks/ais_persist"]="0:0:755"
  ["/etc/initcpio/install/ais_persist"]="0:0:755"
)

# Embed a stable base id for package persistence upgrades.
profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive_date=$(date -u --date="@${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be pinned}" +%Y-%m-%d)
base_hash=$(cd "$profile_dir" && find . -type f ! -path './airootfs/etc/ais-live/base-id' ! -path './airootfs/etc/ais-live/base-packages' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
mkdir -p "$profile_dir/airootfs/etc/ais-live"
printf '%s\n' "$archive_date+$base_hash" >"$profile_dir/airootfs/etc/ais-live/base-id"
