#!/usr/bin/env bash
# Fail unless an `xorriso -report_el_torito as_mkisofs` report holds both a
# BIOS record (-b) and an EFI record (an -e entry with a non-empty image).
# Usage: assert-eltorito.sh <report>
set -euo pipefail
report=${1:?usage: assert-eltorito.sh <report>}
bios=0 efi=0
grep -Eq '^-b ' "$report" && bios=1
grep -Eq "^-e +('[^']+'|[^' ]+)" "$report" && efi=1
echo "assert-eltorito: bios=$bios efi=$efi"
[ "$bios" = 1 ] && [ "$efi" = 1 ]
