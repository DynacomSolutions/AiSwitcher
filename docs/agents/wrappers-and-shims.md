# Wrappers, exec, shims, PATH, nested launches

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 504-543 566-588). Read before touching this area._

- **The shim execs the real tool; a detached sidecar does the session work.**
  A wrapper that stays alive as the TUI's parent orphans the TUI when it dies
  (2026-10-14: a JSC GC segfault in the codex shim left codex drawing in the
  background, mouse tracking on, over the shell's prompt). So `runWrapper` (and
  `ais resume`) do all setup, spawn `<self> __session-sidecar` (own session, stdio
  `/dev/null`, spec in `AIS_SESSION_SIDECAR_SPEC`; see `session-sidecar.ts`), then
  `execve` the real binary over the shim (`execve.ts`, libc via `bun:ffi`; Linux
  `execve`, macOS `posix_spawn` with `POSIX_SPAWN_SETEXEC`), so the tool keeps the shim's PID, parent and terminal. The sidecar polls
  the PID (start-time guarded: `/proc` on Linux, `sysctl kern.proc.pid` in
  `darwin-proc.ts` on macOS; zombies count as exited; Bun has no pidfd), runs the profile-sync
  watcher and `HerdrTabTitleWatcher` meanwhile, and on exit does the post-exit
  sync. It must never touch the terminal. `execve` also clears ignored signals
  (Bun ignores SIGPIPE/SIGXFSZ), the blocked mask and non-CLOEXEC descriptors so
  the child sees what `Bun.spawn` would have given it. On macOS this is one
  `posix_spawn` attribute set (SETSIGDEF, SETSIGMASK, CLOEXEC_DEFAULT keeping
  fds 0-2) because `fcntl` is variadic and a non-variadic `bun:ffi` declaration
  is not ABI-safe on Apple arm64; never reintroduce `fcntl`/`ioctl` there. Fallbacks: execve
  unavailable (other platforms, no FFI, exec error) keeps the old `Bun.spawn` path in
  `exec.ts` (inherited stdio, signal relay SIGINT/SIGTERM/SIGHUP/SIGQUIT/SIGTSTP,
  exit-code mirroring) with the sidecar still doing the session work; a sidecar
  that cannot start falls back to the fully in-process legacy flow.
  The sidecar is double-forked through a short-lived `sh` so it is never the
  tool's child. Every fallback to the old spawn path appends one line to
  `~/.ais/state/shim-fallback.log` (never the terminal; Linux and macOS only, since elsewhere
  spawning is the expected route; truncated past 1 MiB). Anything that must
  finish before the exec has to be awaited first: `poolLaunchCheck` therefore
  stops starting new swaps after `LAUNCH_SETTLE_MS` past its 4 s budget but
  always awaits the in-flight work (token refresh, locks) to its end. `AIS_HERDR_TITLE_OWNER_PID` for a nested launch names the
  parent, not the wrapper, because the tool now shares the wrapper's PID.
  `execReal` (usage passthrough, `open`) tries execve first; `ais upgrade` and
  `ais herdr` keep `spawnReal` (sequential or follow-up work after the child).
- **Shims install to `~/.local/bin`, not a dedicated shim directory.** This
  conventional user binary directory must precede vendor install directories
  on `PATH` for the wrappers to intercept commands.
  `src/shared/resolve-binary.ts` first checks AIS's managed
  real-CLI directory (`~/.ais/npm/bin`, formerly `~/.local/share/ais/npm/bin`
  — see "~/.ais: one consolidated root" below), then the conventional
  Grok/Kimi installer directories where relevant, then strips the shim
  directory from inherited `PATH` (compared by realpath, not string match)
  and does a fresh `Bun.which` lookup. It never caches an install-time path:
  Homebrew, npm, and vendor upgrades can move a real binary without the
  wrapper being reinstalled. Preferring the managed directory also makes an
  `ais upgrade` take effect in the current shell instead of rediscovering an
  older `/usr/bin` binary.
  **This "zero shell-rc edits" assumption does NOT hold for grok**: the
  official Grok CLI installer appends its own `export PATH="$HOME/.grok/bin:
  $PATH"` line to the shell rc. If added after the `~/.local/bin` export,
  it puts `~/.grok/bin/grok` ahead of the shim, which cannot intercept
  commands until the user
  reorders their shell rc (move the `~/.grok/bin` PATH line above the
  `~/.local/bin` one, or re-export `~/.local/bin` after it). Explain this when
  wiring up grok, and check `which grok` resolves to `~/.local/bin/grok`
  after `bun run install:shims`. Kimi Code's installer can likewise put
  `~/.kimi-code/bin` ahead of the shim. Apply the same reorder fix and check
  `which kimi` resolves to `~/.local/bin/kimi`. See the kimi case
  study below.
- **Independent compiled binaries per tool, not one dispatch-by-name
  binary.** Inside a `bun build --compile` executable, `process.argv[0]` is
  always the literal string `"bun"` and `import.meta` paths are virtual
  bundle paths — argv0-based name dispatch (the pattern used by many Go/Rust
  multi-call binaries) is unreliable here. `src/claude.ts`, `src/codex.ts`,
  `src/grok.ts`, `src/kimi.ts`, and `src/zai.ts` are separate entrypoints that
  all import the same `src/shared/*` modules; `bun build --compile`
  bundles/tree-shakes each independently.

- **`--identity`, not `--account` or `--profile`.** Codex already has an
  unrelated native `-p/--profile <name>` (layers `$CODEX_HOME/<name>.config.toml`
  on the *same* identity — a config variant, not an account switch). Using a
  different flag name avoids the collision entirely.
- **Nested identity inheritance and validation are scoped to the provider
  tool.** `launchWithSession()` stamps `AI_PROFILE_SWITCHER_TOOL` alongside
  `AI_PROFILE_SWITCHER_SESSION`, including direct resume launches. A nested
  launch from another provider keeps nested-session behaviour such as sync
  and title ownership, but resolves its identity in its own registry. A
  launch within the same provider inherits the parent's identity when no
  `--id` is given and rejects an explicit different identity. Older wrappers
  without the tool marker retain same-provider protection when the target's
  own config env var is present. The machine-local Bash hook
  `~/.ais/hooks/cross-agent-require-id.sh` /`.py` is outside this repository
  and applies the same rule: it validates `--id` only when the child tool
  matches the host session's tool.

