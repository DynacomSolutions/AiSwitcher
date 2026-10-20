# Host app drive identity contract

The released image is a template with GPT partitions 1 to 4. Every kernel menu
entry ships `ais.base=HOST_APP_REQUIRED`, `ais.exchange=HOST_APP_REQUIRED` and
`ais.drive=HOST_APP_REQUIRED`, plus
`archisodevice=/dev/disk/by-partuuid/HOST_APP_REQUIRED` and `copytoram=n`.
An unpersonalised template stops with an emergency message before archiso
mounts any disk. The labels AISBASE and AISX are descriptive only.

Sub-project C must finish these steps on the destination drive before boot:

1. Write the image, resize exchange partition 4 as needed, relocate the backup
   GPT to the destination's end and create partition 5 in the remaining space
   (Linux LUKS type `CA7D7CCB-63ED-4C53-861C-1742536059CC`).
2. Generate an independent random disk GUID and independent random PARTUUIDs
   for **all five** partitions, on every drive creation. Preserve the partition
   order, types, boot attributes and partitions 1 to 4's contents.
3. Zero partition 5, including at least its first 16 MiB. Do not create a LUKS
   header or filesystem. Old destination contents must not survive as an
   apparently empty persistence area.
4. Mount partition 2, the FAT ESP, and patch **all three** kernel command lines
   in each of these files, including latest, pick and clean modes:

   | ESP file | Lines to patch |
   | --- | --- |
   | `/boot/grub/grub.cfg` | Each `linux /arch/boot/x86_64/vmlinuz-linux ...` line inside the `latest`, `pick` and `clean` menu entries |
   | `/syslinux/syslinux.cfg` | Each `APPEND ...` line under `LABEL latest`, `LABEL pick` and `LABEL clean` |

   Write these exact argument forms, with canonical lower-case, non-zero UUIDs
   read back from the newly randomised GPT:

   ```text
   archisobasedir=arch archisodevice=/dev/disk/by-partuuid/<partition-3-PARTUUID> copytoram=n ais.base=<partition-3-PARTUUID> ais.exchange=<partition-4-PARTUUID> ais.drive=<partition-5-PARTUUID>
   ```

   Replace each placeholder once per line. Keep `copytoram=n`, the existing
   kernel/initrd paths, `systemd.firstboot=off` and the corresponding `ais.mode`.
   Do not add quotes, escapes, duplicate arguments or label/search fallbacks.
   The embedded EFI loader and `INITRD`/`initrd` lines need no identity patch.
   Flush the ESP, read back both menus and the GPT, and verify that every entry
   contains exactly one of each required argument and agrees with the GPT
   before reporting success.

The AIS initramfs hook runs before the archiso hook. It refuses to continue,
with an emergency message and no disk mount, if `ais.base` is missing,
placeholder, invalid or ambiguous, or does not identify partition 3. The
`archisodevice` value must exactly match its PARTUUID path, `archisobasedir`
must be `arch`, and `copytoram` must be `n`, each appearing exactly once.
Every `cow_*`, `img_*`, other `archiso*` or `copytoram*` parameter, and
`dm_snap_prefix`, is refused, including `cow_device`, `cow_label`, `img_dev`,
`img_loop`, `archisolabel`, search overrides and `copytoram=y` or `auto`.
AISBASE is built as ext4 without a journal (`-O ^has_journal`) and mounted
read-only, so base mounting has no journal to replay.

The initramfs never repairs or writes GPT metadata. After the base mounts, it
accepts persistence only when `ais.drive` is unique among attached partitions,
identifies partition 5, and belongs to the same disk as the verified base.
Missing, placeholder, invalid, ambiguous or mismatched persistence identity
uses tmpfs. There is no label, partition-order or whole-disk fallback.

First boot formats only a partition without a LUKS header whose first 16 MiB
read entirely as zero. After the passphrase prompt it resolves the persistence
symlink once and opens the node on fd 8. It verifies the open descriptor's
`st_rdev` against the unique sysfs/GPT PARTUUID target, partition number 5,
base parent disk and disk sequence, plus the size against sysfs. Both the
LUKS probe and full 16 MiB zero comparison read `/proc/self/fd/8`; formatting
also uses `/proc/self/fd/8`. It checks identity and LUKS state afterwards.
Existing LUKS is opened without reformatting. Non-zero unrecognised contents
are refused. Interrupted creation never rewrites GPT or reformats existing LUKS.

The accepted residual hot-plug window between opening and formatting requires
a deliberately cloned random 128-bit PARTUUID identity; the format code records
this decision in a `shortcut:` comment.

Exchange is intentionally writable after a successful persistent boot. The
runtime resolver accepts only the unique `ais.exchange` PARTUUID identifying
partition 4 on the same disk as `ais.base`, and mounts it read-write with
root-only permissions. A missing, placeholder, duplicated, ambiguous or
mismatched value means no exchange mount. Partition order alone never selects
exchange, and writable state is confined to the verified persistence and
exchange partitions.

Clean mode uses temporary storage and leaves persistence and exchange
unmounted. The runtime exchange service also refuses writable access on
ephemeral boots. Copying a personalised drive duplicates its identity; use the
host creation flow for each drive, rather than cloning a personalised image.
