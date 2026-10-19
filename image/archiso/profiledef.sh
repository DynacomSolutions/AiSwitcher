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
file_permissions=()
