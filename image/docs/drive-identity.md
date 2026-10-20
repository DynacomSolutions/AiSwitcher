# Host app drive identity contract

The released image is a template with GPT partitions 1 to 4. Every boot menu
entry ships `ais.drive=HOST_APP_REQUIRED`. Writing it with another tool boots
with temporary persistence in RAM and a message to use the AIS host app.

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
4. On the ESP, replace the placeholder in every kernel entry in
   `boot/grub/grub.cfg` and `syslinux/syslinux.cfg` with
   `ais.drive=<partition-5-PARTUUID>`, in canonical lower-case UUID form.
   Each kernel command line must contain exactly one `ais.drive` argument,
   including latest, pick and clean modes. Read back the GPT and both menus
   and verify they agree before reporting success.

The initramfs never repairs or writes GPT metadata. It accepts the named
partition only when its PARTUUID is unique among attached partitions, it is
partition 5, and its parent disk also contains the mounted base partition 3.
Missing, placeholder, invalid, ambiguous or mismatched identity uses tmpfs.
There is no label, ESP UUID or whole-disk fallback.

First boot formats only a partition without a LUKS header whose first 16 MiB
read entirely as zero. It checks identity again after the passphrase prompt,
and checks PARTUUID and LUKS state after formatting. Existing LUKS is opened
without reformatting. Non-zero unrecognised contents are refused. Interrupted
creation is never repaired by rewriting the partition table or reformatting
an existing LUKS container.

Clean mode uses temporary storage and leaves persistence and exchange
unmounted. The runtime exchange service also refuses writable access on
ephemeral boots. Copying a personalised drive duplicates its identity; use the
host creation flow for each drive, rather than cloning a personalised image.
