#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_base="${AIS_TOKSCALE_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tokscale-ais-build}"
source_url="https://github.com/junhoyeo/tokscale/archive/refs/tags/v4.20.0.tar.gz"
source_sha256="73376cdde65268d18de5d319d8cad416d3370101201284f50d573430058dc533"
output="${1:-${AIS_TOKSCALE_SHARED_BIN:-$HOME/.ais/cache/usage/native-tokscale/tokscale}}"

if [[ "$output" != /* ]]; then
  printf 'output path must be absolute: %s\n' "$output" >&2
  exit 2
fi
command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 2; }
command -v sha256sum >/dev/null || { printf 'sha256sum is required\n' >&2; exit 2; }
command -v cargo >/dev/null || { printf 'cargo is required\n' >&2; exit 2; }

if [[ "$build_base" != /* ]]; then
  printf 'build directory must be absolute: %s\n' "$build_base" >&2
  exit 2
fi
target_dir="${CARGO_TARGET_DIR:-}"
if [[ -n "$target_dir" && "$target_dir" != /* ]]; then
  printf 'CARGO_TARGET_DIR must be absolute: %s\n' "$target_dir" >&2
  exit 2
fi
mkdir -p "$build_base"
build_root="$build_base/tokscale-v4.20.0-$$"
if [[ -e "$build_root" || -L "$build_root" ]]; then
  printf 'build scratch path already exists: %s\n' "$build_root" >&2
  exit 1
fi
mkdir "$build_root"
cleanup() {
  [[ -d "$build_root" && ! -L "$build_root" ]] || return 0
  rm -r -- "${build_base:?}/tokscale-v4.20.0-$$"
}
trap cleanup EXIT

archive="$build_root/tokscale-v4.20.0.tar.gz"
source_dir="$build_root/source"
curl --fail --location --silent --show-error "$source_url" --output "$archive"
printf '%s  %s\n' "$source_sha256" "$archive" | sha256sum --check --status || {
  printf 'Tokscale v4.20.0 source checksum mismatch\n' >&2
  exit 1
}
mkdir "$source_dir"
tar -xzf "$archive" --strip-components=1 -C "$source_dir"
cmp -- "$repo_root/vendor/tokscale/LICENSE" "$source_dir/LICENSE"
patch --directory="$source_dir" --strip=1 --input="$repo_root/vendor/tokscale/patches/v4.20.0-ais.patch"

(cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_shared_snapshot)
(cd "$source_dir" && cargo test --locked --package tokscale-cli --bin tokscale ais_shared_overlay)
(cd "$source_dir" && cargo test --locked --package tokscale-cli --test cli_tests ais_native_export_from_json_model_report_uses_report_parser_vector)
(cd "$source_dir" && cargo build --locked --release --package tokscale-cli --bin tokscale)

if [[ -z "$target_dir" ]]; then
  target_dir="$source_dir/target"
fi
mkdir -p "$(dirname "$output")"
staged="$output.ais-new-$$"
cp "$target_dir/release/tokscale" "$staged"
chmod 0755 "$staged"
mv -f -- "$staged" "$output"
printf 'Installed AIS-patched Tokscale v4.20.0 at %s\n' "$output"
