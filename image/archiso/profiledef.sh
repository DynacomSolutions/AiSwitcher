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
  ["/usr/local/lib/ais-live/ais-live-pkglist"]="0:0:755"
  ["/usr/local/lib/ais-live/resolve-boot-partition"]="0:0:755"
  ["/etc/systemd/system/ais-live-key-lifetime.service"]="0:0:644"
  ["/etc/systemd/system/ais-live-exchange.service"]="0:0:644"
  ["/usr/local/lib/ais-live/persist-test"]="0:0:755"
  ["/etc/initcpio/hooks/ais_persist"]="0:0:755"
  ["/etc/initcpio/install/ais_persist"]="0:0:755"
)

# Embed a stable base id for package persistence upgrades.
profile_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive_date=$(date -u --date="@${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be pinned}" +%Y-%m-%d)

# The initramfs needs the numeric agent owner before the live system boots.
# Generate it from the profile's real account database and fail if the required
# account definitions are missing.
bash "$profile_dir/persist-contracts.sh" agent-ids \
  "$profile_dir/airootfs/etc/passwd" \
  "$profile_dir/airootfs/etc/group" \
  "$profile_dir/airootfs/etc/ais-live/agent-ids" || exit 1

# Enable the exchange service in the copied build profile. The legacy mount
# unit is removed because device discovery and mount ordering belong to this
# service now.
systemd_dir="$profile_dir/airootfs/etc/systemd/system"
rm -f -- "$systemd_dir/local-fs.target.wants/mnt-aisx.mount"
[[ -f "$systemd_dir/ais-live-exchange.service" ]] || exit 1
mkdir -p -- "$systemd_dir/multi-user.target.wants"
ln -sfn -- ../ais-live-exchange.service "$systemd_dir/multi-user.target.wants/ais-live-exchange.service"

base_hash=$(cd "$profile_dir" && find . -type f ! -path './airootfs/etc/ais-live/base-id' ! -path './airootfs/etc/ais-live/base-packages' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
mkdir -p "$profile_dir/airootfs/etc/ais-live"
printf '%s\n' "$archive_date+$base_hash" >"$profile_dir/airootfs/etc/ais-live/base-id"
