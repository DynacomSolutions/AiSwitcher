# ais Host shell

The desktop shell lives in this workspace. It uses Rust 1.99.0 and Bun 1.3.11,
React 19, Vite 8, Tauri 2.11.5 and tauri-build 2.6.3. Rust is pinned by
`rust-toolchain.toml`; the tested compiler version is a build pin, not a claim
about the minimum Rust version supported by every dependency.

Supported build architectures are macOS arm64, Windows x86_64 and Linux
x86_64. The selected platform floors are macOS 11 or later, Windows 10 version
1803 or later with WebView2, and a Linux distribution providing GTK 3 and
WebKitGTK 4.1. Linux package names vary by distribution. macOS transparency
uses Tauri's private API setting, so the effect depends on native OS support;
this scaffold has not verified the native effect on macOS or Windows. Reduced
transparency and forced-colour preferences use opaque CSS surfaces.

From this directory, run `bun install --frozen-lockfile`, `bun run typecheck`, and
`bun run build`. Native Cargo commands use `--locked` to match the checked-in
workspace lockfile.
The browser smoke suite uses Playwright 1.58.2 from the isolated host-app
tooling cache and an installed Chromium binary without adding either as a
project dependency:

```sh
HOST_PLAYWRIGHT_MODULE=/path/to/playwright/node_modules/@playwright/test \
HOST_CHROMIUM_PATH=/path/to/chromium bun run test:smoke
```

The native smoke command accepts an already built app. It sends only the
`--native-smoke` readiness request and has a 45 second deadline:

```sh
HOST_APP_PATH=/path/to/ais-host-app bun run native:smoke
```

On macOS, `HOST_APP_PATH` may point to an `.app` bundle. Build separately with
`cargo build --locked --features custom-protocol -p ais-host-app` from this directory;
the custom protocol embeds the frontend output.
