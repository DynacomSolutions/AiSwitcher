# Release assets and aistui self-heal

Read before touching either release pipeline.

## Portable host releases

`host-app.yml` uses GitHub-hosted `macos-latest` arm64, `windows-latest`
x86_64 and `ubuntu-latest` x86_64 runners. It uses no schedules, containers
or legacy cross-build jobs. PR selection follows `scripts/host/affected.ts`;
shared inputs, unknown changes, default-branch pushes and release calls run
the full suite. The always-running `gate` accepts intentional skips only
when selection is `skip`; failed, cancelled or unexpectedly skipped jobs fail.

`release-host-app.yml` runs on `host-v*` tags or manual dispatch with an
existing tag. The tag must equal `host-v` plus the host package version,
resolve to the exact workflow commit, and belong to `main` history. Full
production checks run again at that SHA. Bun, the native Tauri CLI and Cargo
inputs are pinned; builds use the lockfiles and the host Rust toolchain.
The image trust key is `image/release/minisign.pub`.
Unsigned development builds may use the explicit development placeholder;
production packages reject it.

Default permissions are `contents: read`. Only the draft-release creation
job receives `contents: write`. PR checks never receive signing secrets.
The signing job reads only these repository secret names:

- `DYNACOM_APPLE_DEVELOPER_ID_P12_BASE64`
- `DYNACOM_APPLE_DEVELOPER_ID_P12_PASSWORD`
- `DYNACOM_APPLE_ASC_KEY_P8_BASE64`
- `DYNACOM_APPLE_ASC_KEY_ID`
- `DYNACOM_APPLE_ASC_ISSUER_ID`

Missing credentials emit a notice, skip signing cleanly and prevent release
creation. An isolated temporary keychain holds the Developer ID certificate.
Passwords reach `security` through standard input; the notary account IDs
reach its credential prompt through a private terminal. Tool output containing
certificate or account details is suppressed. No credential value goes in
command arguments or release metadata.

Nested executables are signed before the application, with hardened runtime.
Only the Bun adapter needs the documented JIT entitlement. Notarisation must
return `Accepted`, then stapling, signature validation and Gatekeeper
assessment must pass. The final ZIP is created after stapling.

Assets are the macOS arm64 application ZIP, unsigned Windows x86_64 portable
ZIP, Linux x86_64 AppImage, per-platform dependency notices and `SHA256SUMS`.
Checksums cover the final signed and stapled bytes. Windows signing remains
deferred and WebView2 is required. The Linux privileged helper installation
is separate from its portable package.

The workflow creates a draft prerelease and downloads it afresh on all three
native runners to verify hashes, package contents and launch. Linux tests the
extracted read-only payload without FUSE; all targets use a fresh path with
spaces and non-ASCII characters. Keep the draft unpublished until those checks
and the real privilege/USB acceptance evidence in `host-app.md` pass.

## CLI release history

### Live image releases

`release-live-image.yml` accepts only raw `live-v*` tags. It calls the shared
`live-image.yml` workflow with `release: true`, which builds the CI test image
and a separate production image without test-only packages, then boots
both flavours under BIOS and UEFI. The release job checks that the tag commit
is on `main`, writes the exact `ais-live.img` SHA256 manifest and signs it when
`MINISIGN_SECRET_KEY` is configured. `MINISIGN_PASSWORD` is required for a
password-protected key and may be empty only for an unencrypted key. Without
the key, the signing and publish path reports a notice and skips. The
minisign public key is `image/release/minisign.pub`. Live releases are marked
non-latest so they do not change the CLI release selected by `ais update`,
which uses GitHub's latest-release lookup.

The host app is not part of this release. The asset name `ais-live.img` is an
assumed host input contract. `image/docs/drive-identity.md` specifies
partitioning, but does not define release asset names.

### aistui ships in releases; `ais tui`/`ais herdr` self-heal (2026-09-15)

- release.yml builds the Rust TUI alongside the bun binaries:
  `aistui-darwin-arm64`/`aistui-darwin-x64` (aarch64-apple-darwin and
  x86_64-apple-darwin, requiring appropriate GitHub-hosted macOS runners),
  `aistui-linux-x64` (x86_64-unknown-linux-gnu on ubuntu) and
  `aistui-linux-arm64` (aarch64-unknown-linux-gnu via `cross`, the pinned
  container toolchain from the historical CLI pipeline). This is historical
  context, not an allowed host-app build path. Same
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

