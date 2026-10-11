# Wrappers, exec, shims, PATH, nested launches

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 504-543 566-588). Read before touching this area._

- **No `execve`-style process replacement.** Bun has no non-experimental
  primitive for true process-image replacement, so `src/shared/exec.ts` uses
  `Bun.spawn` with full fd inheritance (`stdio: ["inherit","inherit","inherit"]`)
  plus explicit signal relay (SIGINT/SIGTERM/SIGHUP/SIGQUIT/SIGTSTP) and
  exit-code/signal-code mirroring. This is the same model nvm/asdf/direnv-style
  shims use. The one accepted gap: an uncatchable SIGKILL sent to the wrapper
  itself orphans the child rather than killing it too.
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
- **A nested claude/codex/grok/kimi/zai launch with no `--id` auto-inherits the parent
  session's identity — it is never rejected for merely omitting the flag.**
  `resolveNestedIdentity()` (`src/shared/cli-args.ts`), called from
  `run-wrapper.ts` before `resolveIdentity()`, only rejects a nested launch
  that EXPLICITLY names a *different* identity than
  `AI_PROFILE_SWITCHER_SESSION` — that's the actual cross-identity-pollution
  case. Bare nested launches must inherit the session so downstream callers
  need no identity-specific arguments. The companion Bash-level hook,
  `~/.ais/hooks/cross-agent-require-id.sh` /`.py` (wired into every identity's
  settings.json/hooks.json as "everywhere" enforcement — NOT part of this
  repo, lives in the shared `~/.ais/` tree), encodes the identical policy
  independently at the Bash-tool-call layer and
  was fixed in lockstep — a bare nested launch is not a violation there
  either; only an explicit, mismatched `--id=` is. The two enforcement points
  (this repo's own runtime check, and the Bash-command-level hook) are
  deliberately redundant (defense in depth — the hook catches it before a
  process even spawns; the runtime check catches anything that reaches the
  binary some other way) but MUST be kept in sync — this incident is exactly
  what happens when they drift.

