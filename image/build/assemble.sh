#!/usr/bin/env bash
# Assemble a raw GPT image without loop devices or mounts. The source can be
# an ISO or an extracted ISO tree (also used by the synthetic fixture test).
# Work files are kept beside the output for inspection. Existing outputs are
# refused, including device nodes and symlinks.
set -euo pipefail
export LC_ALL=C

die() { echo "assemble: $*" >&2; exit 1; }
[[ $# == 2 ]] || die 'usage: assemble.sh <iso-or-tree> <out.img>'
[[ ! -e $2 && ! -L $2 ]] || die 'output already exists'
source_path=$(realpath -e -- "$1")
out=$(realpath -m -- "$2")
[[ -f $source_path || -d $source_path ]] || die 'source must be a regular ISO or directory'
[[ ! -e $out && ! -L $out ]] || die 'output already exists'
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for tool in sfdisk jq mkfs.fat mcopy mke2fs mkfs.exfat syslinux grub-mkstandalone dd; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
done

pick_file() {
    local path
    for path in "$@"; do
        if [[ -f $path ]]; then printf '%s\n' "$path"; return; fi
    done
    die "missing bootloader file: ${1##*/}"
}
syslinux_dir=${AIS_SYSLINUX_DIR:-/usr/lib/syslinux/bios}
gptmbr=$(pick_file "$syslinux_dir/gptmbr.bin" /usr/lib/syslinux/mbr/gptmbr.bin /usr/share/syslinux/gptmbr.bin)
modules=()
for name in ldlinux.c32 menu.c32 libutil.c32; do
    modules+=("$(pick_file "$syslinux_dir/$name" "/usr/share/syslinux/$name" /usr/lib/syslinux/modules/bios/"$name")")
done

mkdir -p -- "$(dirname "$out")"
work=$(mktemp -d "$out.work.XXXXXX")
echo "assemble: work files: $work"
if [[ -d $source_path ]]; then
    tree=$source_path
else
    tree=$work/iso
    mkdir -p "$tree"
    xorriso -osirrox on -indev "$source_path" -extract /arch "$tree/arch"
fi
kernel=$tree/arch/boot/x86_64/vmlinuz-linux
initrd=$tree/arch/boot/x86_64/initramfs-linux.img
sfs=$tree/arch/x86_64/airootfs.sfs
for path in "$kernel" "$initrd" "$sfs"; do [[ -s $path ]] || die "missing payload: ${path##*/}"; done

# Align every partition to a MiB. Reserve room for FAT metadata, bootloaders
# and ext4 metadata. The host app creates p5 when it writes the drive.
mib=$((1024 * 1024))
esp_mib=$(( ( $(stat -c %s "$kernel") + $(stat -c %s "$initrd") + mib - 1 ) / mib + 64 ))
(( esp_mib >= 128 )) || esp_mib=128
base_mib=$(( ( $(stat -c %s "$sfs") + mib - 1 ) / mib + 64 ))
esp_start=4096
esp_sectors=$((esp_mib * 2048))
base_start=$((esp_start + esp_sectors))
base_sectors=$((base_mib * 2048))
exchange_start=$((base_start + base_sectors))
exchange_sectors=$((32 * 2048))
image_sectors=$((exchange_start + exchange_sectors + 2048))
(( image_sectors * 512 < 3 * 1024 * mib )) || die 'image exceeds the 3 GiB assembly budget'
(set -o noclobber; : > "$out") || die 'cannot create output exclusively'
truncate -s "$((image_sectors * 512))" "$out"
sfdisk "$out" <<EOF
label: gpt
unit: sectors
sector-size: 512

start=2048, size=2048, type=21686148-6449-6E6F-744E-656564454649, name="BIOS"
start=$esp_start, size=$esp_sectors, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="AISBOOT", attrs="LegacyBIOSBootable"
start=$base_start, size=$base_sectors, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="AISBASE"
start=$exchange_start, size=$exchange_sectors, type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="AISX"
EOF

mkdir -p "$work/esp/arch/boot/x86_64" "$work/esp/syslinux" "$work/esp/boot/grub" "$work/esp/EFI/BOOT" "$work/base/arch/x86_64"
cp "$kernel" "$initrd" "$work/esp/arch/boot/x86_64/"
cp "$tree/arch/x86_64/"* "$work/base/arch/x86_64/"
cp "${modules[@]}" "$work/esp/syslinux/"
cp "$here/../archiso/syslinux/raw.cfg" "$work/esp/syslinux/syslinux.cfg"
cp "$here/../archiso/grub/raw.cfg" "$work/esp/boot/grub/grub.cfg"
grub_args=()
if [[ -n ${AIS_GRUB_MODULE_DIR:-} ]]; then grub_args+=(-d "$AIS_GRUB_MODULE_DIR"); fi
grub-mkstandalone "${grub_args[@]}" -O x86_64-efi --locales='' --fonts='' \
    --modules='part_gpt fat regexp configfile linux normal serial halt' \
    -o "$work/esp/EFI/BOOT/BOOTX64.EFI" "boot/grub/grub.cfg=$here/../archiso/efiboot/grub.cfg"

truncate -s "$((esp_sectors * 512))" "$work/esp.img"
# The hidden-sector value is needed by BIOS FAT boot code after relocation.
mkfs.fat -F 32 -n AISBOOT -h "$esp_start" "$work/esp.img"
mcopy -s -i "$work/esp.img" "$work/esp/"* ::/
dd if="$work/esp.img" of="$out" bs=512 seek="$esp_start" conv=notrunc,sparse status=none
# The mtools installer supports a filesystem offset in a regular image file.
syslinux --install --offset "$((esp_start * 512))" --directory /syslinux "$out"
# Preserve the disk signature and protective partition table in the MBR.
dd if="$gptmbr" of="$out" bs=440 count=1 conv=notrunc status=none

truncate -s "$((base_sectors * 512))" "$work/base.img"
mke2fs -q -t ext4 -F -O ^has_journal -L AISBASE -m 0 -d "$work/base" "$work/base.img"
dd if="$work/base.img" of="$out" bs=512 seek="$base_start" conv=notrunc,sparse status=none
truncate -s "$((exchange_sectors * 512))" "$work/exchange.img"
mkfs.exfat -L AISX "$work/exchange.img"
dd if="$work/exchange.img" of="$out" bs=512 seek="$exchange_start" conv=notrunc,sparse status=none
sfdisk --verify "$out"
printf 'assemble: image=%s bytes=%s\n' "$out" "$(stat -c %s "$out")"
