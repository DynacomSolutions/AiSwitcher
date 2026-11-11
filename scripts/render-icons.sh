#!/usr/bin/env bash
# Render every app icon from the one source: apps/host/src-tauri/icons/icon.svg
# (the WebUI top-bar logo in apps/web/src/components/layout/app-shell.tsx:
# dark --primary tile, rounded-lg, lucide ArrowLeftRight in --primary-foreground;
# apps/web/index.html inlines this same SVG as the favicon).
# Writes favicon.png (editor/T3 project icon) and the Tauri host icons.
# Needs rsvg-convert, ImageMagick (magick) and python3.
set -euo pipefail
cd "$(dirname "$0")/.."
src=apps/host/src-tauri/icons/icon.svg
out=apps/host/src-tauri/icons
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for n in 16 32 48 64 128 256 512 1024; do rsvg-convert -w "$n" -h "$n" "$src" -o "$tmp/$n.png"; done
cp "$tmp/256.png" favicon.png
cp "$tmp/512.png" "$out/icon.png"
magick "$tmp"/{16,32,48,64,128,256}.png "$out/icon.ico"
python3 - "$tmp" "$out/icon.icns" <<'PY'
import struct, sys
tmp, dest = sys.argv[1], sys.argv[2]
body = b""
for kind, n in [(b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)]:
    data = open(f"{tmp}/{n}.png", "rb").read()
    body += kind + struct.pack(">I", len(data) + 8) + data
open(dest, "wb").write(b"icns" + struct.pack(">I", len(body) + 8) + body)
PY
