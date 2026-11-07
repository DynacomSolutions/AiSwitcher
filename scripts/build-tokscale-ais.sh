#!/usr/bin/env bash
# Build the AIS-patched Tokscale and install it with its build stamp.
# usage: build-tokscale-ais.sh [absolute output path]
# Sourcing this file defines its functions without building (tests use that).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_url="https://github.com/junhoyeo/tokscale/archive/refs/tags/v4.20.0.tar.gz"
source_sha256="73376cdde65268d18de5d319d8cad416d3370101201284f50d573430058dc533"

# Copy what the build stamp describes (this helper and the patch series) into
# the scratch tree once, before anything is built. The patches are applied
# from this copy and the stamp is written from it, so commits that land in the
# checkout during a long build can never be recorded against this binary.
snapshot_build_inputs() {
  local checkout=$1 inputs=$2
  mkdir -p -- "$inputs/scripts" "$inputs/vendor/tokscale/patches"
  cp -- "$checkout/scripts/build-tokscale-ais.sh" "$inputs/scripts/build-tokscale-ais.sh"
  cp -- "$checkout/vendor/tokscale/patches/"* "$inputs/vendor/tokscale/patches/"
}

# Apply the snapshot's patches in the order its series lists them.
apply_snapshot_patches() {
  local inputs=$1 source_dir=$2 patch_name
  while IFS= read -r -u 3 patch_name; do
    [[ -n "$patch_name" ]] || continue
    patch --directory="$source_dir" --strip=1 --input="$inputs/vendor/tokscale/patches/$patch_name" </dev/null
  done 3< "$inputs/vendor/tokscale/patches/series"
}

# Install a built binary and stamp it. The stamp records the hash of the file
# this build staged, never whatever sits at the output afterwards, so a binary
# another build swapped in fails the stamp check. The lock serialises the
# replace-and-stamp step of concurrent builds; the old stamp goes first and the
# new one comes last, so a stamp never describes an older binary.
install_built_binary() {
  local built=$1 output=$2 inputs=$3 staged staged_sha
  mkdir -p -- "$(dirname -- "$output")"
  staged="$output.ais-new-$$"
  cp -- "$built" "$staged"
  chmod 0755 "$staged"
  staged_sha=$(sha256sum < "$staged" | cut -d' ' -f1)
  (
    flock 9
    rm -f -- "$output.ais-build"
    mv -f -- "$staged" "$output"
    bun "$repo_root/scripts/tokscale-stamp.ts" "$inputs" "$output" "$staged_sha"
  ) 9>"$output.lock"
}

main() {
  # build_base and build_root stay global: the EXIT trap reads them after main returns.
  local output target_dir archive source_dir inputs
  build_base="${AIS_TOKSCALE_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tokscale-ais-build}"
  output="${1:-${AIS_TOKSCALE_SHARED_BIN:-$HOME/.ais/cache/usage/native-tokscale/tokscale}}"

  if [[ "$output" != /* ]]; then
    printf 'output path must be absolute: %s\n' "$output" >&2
    exit 2
  fi
  command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 2; }
  command -v sha256sum >/dev/null || { printf 'sha256sum is required\n' >&2; exit 2; }
  command -v cargo >/dev/null || { printf 'cargo is required\n' >&2; exit 2; }
  command -v bun >/dev/null || { printf 'bun is required (it writes the build stamp)\n' >&2; exit 2; }
  command -v flock >/dev/null || { printf 'flock is required\n' >&2; exit 2; }

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
  cleanup_build_root() {
    [[ -d "$build_root" && ! -L "$build_root" ]] || return 0
    rm -r -- "${build_base:?}/tokscale-v4.20.0-$$"
  }
  trap cleanup_build_root EXIT

  inputs="$build_root/inputs"
  snapshot_build_inputs "$repo_root" "$inputs"

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
  apply_snapshot_patches "$inputs" "$source_dir"

  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_shared_snapshot)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib selector_)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_incremental)
  (cd "$source_dir" && cargo test --locked --package tokscale-cli --bin tokscale ais_shared_overlay)
  (cd "$source_dir" && cargo test --locked --package tokscale-cli --test cli_tests ais_native_export_from_json_model_report_uses_report_parser_vector)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_sampled_prefix)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib test_resume_)
  (cd "$source_dir" && cargo test --locked --package tokscale-cli --test cli_tests ais_native_export_reports_unchanged_messages_instead_of_rewriting_the_batch)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_cache_scope)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_codex_resume)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib codex_prefix)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_segmented)
  (cd "$source_dir" && cargo test --locked --package tokscale-cli --test cli_tests ais_native_export_writes_segments_and_rewrites_only_unlisted_ones)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_grok)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib rev412)
  (cd "$source_dir" && cargo test --locked --package tokscale-core --lib ais_checkpoint)
  (cd "$source_dir" && cargo build --locked --release --package tokscale-cli --bin tokscale)

  if [[ -z "$target_dir" ]]; then
    target_dir="$source_dir/target"
  fi
  install_built_binary "$target_dir/release/tokscale" "$output" "$inputs"
  printf 'Installed AIS-patched Tokscale v4.20.0 at %s\n' "$output"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
