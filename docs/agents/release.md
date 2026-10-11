# Release assets and aistui self-heal

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3289-3315). Read before touching this area._

### aistui ships in releases; `ais tui`/`ais herdr` self-heal (2026-09-15)

- release.yml builds the Rust TUI alongside the bun binaries:
  `aistui-darwin-arm64`/`aistui-darwin-x64` (aarch64-apple-darwin and
  x86_64-apple-darwin, natively on the org's `apple-builder` macOS runners),
  `aistui-linux-x64` (x86_64-unknown-linux-gnu on ubuntu) and
  `aistui-linux-arm64` (aarch64-unknown-linux-gnu via `cross`, the pinned
  Docker toolchain being the least fragile CI path for that target). Same
  `<tool>-<platform>` asset convention the installer downloads by.
- The installer binary fetches `aistui-<platform>` during fresh installs. It
  is the one tolerated failure: releases older than aistui have no such
  asset, so a miss is a warning, never an install error.
- First `ais tui` / `ais herdr` on a machine without the binary self-heals
  (shared/aistui-bin.ts `ensureAistuiBinary()`): download `aistui-<platform>`
  from the release matching the RUNNING ais (`v<pkg.version>`; latest release
  as fallback when that tag predates aistui), install atomically into
  `~/.local/bin/aistui` (temp file, chmod 755, rename, destination symlink
  never followed), then launch. ONE attempt per tag per invocation, no retry
  loop; if the download fails the historical not-found error returns with
  the reason attached.
- Resolution order is unchanged: `AIS_TUI_BIN` > `~/.local/bin/aistui` >
  dev cargo checkout (`apps/tui/target/release/aistui`). Dev checkouts never
  download. `ais update` refreshes an already-installed aistui like every
  other managed binary (and never installs a first copy itself).
- `bun run install:shims` (scripts/install.ts) still installs dist/ binaries
  only: aistui is a Rust artifact, not a bun compile output, so dev machines
  get it via `cargo build --release` in apps/tui (or the self-heal above).

