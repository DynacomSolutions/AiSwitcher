# grok and kimi case studies

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1463-1618). Read before touching this area._

### grok case study (2026-07-13)

Concrete example of the above, since grok was the first tool actually added
via this recipe after it was written:

- **`GROK_HOME`** (config-dir env var) was not documented in `grok --help` —
  found via `strings ~/.grok/bin/grok | grep -i grok_home` (turned up
  `$GROK_HOME/trace-exports/...` in a `--help` string for an unrelated flag)
  and cross-checked against `grok inspect`'s "Config Sources" output, which
  confirmed `~/.grok/config.toml` as the default. Default config dir is
  `~/.grok`, matching `~/.claude`/`~/.codex`'s convention.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): grok has `-p`/`--single <PROMPT>` (prints one
  response and exits, like claude's `-p`) AND a `grok agent ...` subcommand
  family ("Run Grok without the interactive UI", the direct analog of
  `codex exec`) — so grok's detection checks both, unlike claude/codex which
  each only need one check.
- **`SESSION_MARKER_PATTERN`** (`src/shared/exec.ts`) was extended to strip
  `GROK_*` env vars defensively, by analogy to the confirmed claude/codex
  nested-session hang — NOT independently reproduced for grok. If a future
  bug report describes grok hanging when invoked from inside an agentic
  session, this is already covered; if grok legitimately needs one of its own
  `GROK_*` env vars passed through from the parent shell, this pattern is the
  first place to check.
- **No desktop app**: no `grok app` subcommand exists (unlike codex) and no
  `/Applications/Grok.app` bundle was found on the machine this was built on.
  `--desktop` is still wired up structurally for grok (same generic code path
  as Claude) for consistency, but is expected to just fail resolving the app
  bundle — this is the one part of the recipe that turned out to have nothing
  real to attach to.
- **The PATH-ordering gap** (see "Key design decisions" above) was discovered
  by inspecting the dev machine's actual `$PATH` output and `~/.zshrc`, not
  assumed — always verify this per-tool rather than trusting the
  `~/.local/bin`-is-already-first assumption that held for claude/codex.
- **grok's own installer had already symlinked `~/.local/bin/grok ->
  ~/.grok/bin/grok`** (and `~/.local/bin/agent -> ~/.grok/bin/agent`) before
  this project ever touched it — `ls -la ~/.local/bin` showed this on the dev
  machine. That collided badly with `scripts/install.ts`'s/`src/installer.ts`'s
  original `copyFile`/`Bun.write` calls: both follow a destination symlink
  and overwrite whatever it points at rather than replacing the symlink
  itself (confirmed empirically — `copyFile(src, dest)` onto a symlinked
  `dest` silently rewrites the symlink's *target* file's contents). Installing
  our `grok` shim would therefore have silently overwritten the REAL
  `~/.grok/bin/grok` binary with our thin wrapper — not merely "the shim
  doesn't intercept anything" like the PATH-ordering gap above, but active
  corruption of the user's real install. Fixed by unlinking the destination
  path first (`rm(dest, { force: true })`) in both `scripts/install.ts` and
  `src/installer.ts`'s `downloadAsset` before writing — this is a general
  fix (protects claude/codex too, if either's real binary is ever symlinked
  at its own shim path for some reason), not grok-specific, but it was grok's
  installer that actually triggered it. `ais update`'s
  `downloadAssetAtomic` was already safe (temp file + `rename()`, which
  replaces the directory entry rather than writing through it) — this bug
  only affected first-time `bun run install:shims` / the standalone
  installer.

### kimi case study (2026-07-17)

Second tool added via the recipe above. All findings below were verified
empirically on this machine, 2026-07-17:

- **Real binary and config root**: `~/.kimi-code/bin/kimi` (v0.26.0,
  Bun-compiled). Config root is `~/.kimi-code` (config.toml, credentials/,
  sessions/, session_index.jsonl, ...) — NOT `~/.kimi`, which is the legacy
  kimi-cli, a different product.
- **`KIMI_CODE_HOME`** (config-dir env var) was not documented in
  `kimi --help` — found via `strings` on the binary (turned up
  `KIMI_CODE_HOME`/`KIMI_CODE_HOME_ENV`), then confirmed live:
  `KIMI_CODE_HOME=/tmp/... kimi doctor` looks for `config.toml`/`tui.toml`
  under the override. Same discovery method as `GROK_HOME`.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): kimi has `-p`/`--prompt <prompt>` ("Run one
  prompt non-interactively and print the response" — the analog of claude's
  `-p`, but note kimi's `-p` is `--prompt`, NOT `--print`) AND an `acp`
  subcommand (ACP server over stdio, the analog of `grok agent`) — so kimi's
  detection checks both.
- **`SESSION_MARKER_PATTERN` (`src/shared/exec.ts`) deliberately does NOT
  strip `KIMI_*`** — the opposite of grok's defensive strip. Checked live
  from inside a running kimi session's own Bash tool (`env`): kimi injects
  NO `KIMI_*` env vars into its tool-spawned environment at all, so there is
  no nested-session marker to strip (unlike claude/codex, whose markers
  caused real hangs, and unlike grok, which was stripped defensively without
  a live session to inspect). A blanket `KIMI_*` strip would only eat a
  user's legitimately exported `KIMI_API_KEY`/`KIMI_BASE_URL`. If nested kimi
  launches ever hang in future, this is the first place to revisit.
- **The PATH-ordering trap is the same class as grok's, and CONFIRMED on
  this machine**: kimi's installer wrote
  `export PATH="/Users/<username>/.kimi-code/bin:$PATH"` at `~/.zshrc`:166-167,
  *after* the `~/.local/bin` export — putting the real binary AHEAD of our
  shim, so the `kimi` shim installs fine but intercepts nothing until the
  user reorders their shell rc (move the `~/.kimi-code/bin` line above the
  `~/.local/bin` export, or re-export `~/.local/bin` after it). Verify with
  `which kimi` → `~/.local/bin/kimi` after `bun run install:shims`. Contrast
  with grok: there was NO pre-existing symlink at `~/.local/bin/kimi`
  (checked) — the unlink-first protection added for grok wasn't needed here,
  but stays generic.
- **Self-updater**: `kimi upgrade` (aliased `kimi update`) exists in
  `kimi --help`, but `ais upgrade` now installs Kimi's managed npm package;
  the native command is only a capability-checked fallback.
- **No desktop app**: no `kimi app` subcommand and no
  `/Applications/Kimi*.app` bundle on this machine (checked 2026-07-17).
  `--desktop` is wired up structurally (same generic
  `runWrapper`/`launchDesktopApp` path) but is expected to just fail
  resolving the app bundle — verified negative 2026-07-17; same caveat as
  grok about re-verifying if the user installs a Kimi desktop app later.
- **Session storage layout drives `src/cli/resume/kimi-resume.ts`'s shape**:
  kimi keeps its own resume index at `<configDir>/session_index.jsonl` — one
  JSON object per line, `{sessionId, sessionDir, workDir}` — plus a
  per-session `state.json` (`{title, createdAt, updatedAt, ...}`) for
  label/timestamps. Reading the index beats walking
  `sessions/wd_<slug>_<hash>/` buckets whose names are a one-way slug+hash of
  the cwd (not reversible). The placeholder title "New Session" counts as no
  label. Relaunch via `kimi --session <id>` (kimi's `-S, --session [id]`).
- **`ais limits` for kimi is a genuinely LIVE fetch** (unlike grok's
  log-scrape): `GET https://api.kimi.com/coding/v1/usages` with the OAuth
  access token from `<configDir>/credentials/kimi-code.json`; expired tokens
  are refreshed via `POST https://auth.kimi.com/api/oauth/token` (kimi-code's
  public OAuth client id — the same refresh-and-persist the kimi CLI itself
  and tokscale both do; persisted back to the credentials file atomically).
  Response = `limits[]` duration-windowed quotas (a 300-minute = 5h session
  window, confirmed live) plus a top-level weekly `usage` quota (resetTime
  exactly 7 days out). Endpoint and response shape confirmed live against the
  real account 2026-07-17; flow cross-checked against tokscale's kimi quota
  fetcher (`crates/tokscale-cli/src/commands/usage/kimi.rs`). Under
  `--cached`, kimi reports "not available" like claude/codex (no offline
  cache).
- **tokscale/`ais usage`**: kimi works exactly like codex/grok — tokscale's
  kimi client (client id `kimi`, confirmed in tokscale's README `--client`
  list and its sessions scanner, 2026-07-17) reads `KIMI_CODE_HOME` and scans
  `<home>/sessions` — the same env var this project redirects per identity.
  `EXTRA_DIR_RELATIVE` for kimi is `sessions`. Not yet re-verified against
  real per-identity kimi data the way claude/codex were.
- **Disk layout / migrate**: `~/.kimi-code/identities.json` +
  `~/.kimi-code/identities/<name>/`, same container pattern as the others.
  `scripts/migrate.ts` was intentionally NOT extended (same stance as grok):
  the existing `~/.kimi-code` default-login content stays at the container
  level and is simply not part of any identity; first identity via
  `ais identities create --tool=kimi` or the picker. `scripts/backup.ts`
  group: `kimi: [".kimi-code"]`.
- **Ships on every platform** (like grok, not darwin-gated like `open`):
  `scripts/build.ts`, `scripts/install.ts`, `src/installer.ts`'s `TOOLS`,
  `src/cli/update.ts`'s `MANAGED_BINARIES`, and
  `.github/workflows/release.yml` all include kimi. New source files:
  `src/kimi.ts` (entrypoint, `runWrapper(KIMI_CONFIG, "Kimi")`),
  `src/cli/resume/kimi-resume.ts`, `src/cli/limits/kimi-limits.ts`;
  string-literal unions widened across `src/identities/types.ts`,
  `src/shared/{cli-args,resolve-binary,run-wrapper,launch-desktop}.ts`,
  `src/open.ts`, `src/cli/{identities/resolve-tool.ts,update.ts,upgrade.ts,
  usage/*,limits/*,resume/*}`, `src/cli/help.ts`.
- **Chrome (Claude MCP) redirects work for wrapped kimi sessions too** —
  `src/open.ts`'s `TOOL_CONFIGS` includes kimi — under the SAME two
  still-unverified assumptions documented in "Chrome profile per identity"
  below (that the real kimi binary shells out to bare `open` via PATH, and
  that the invocation shape is bare `open <url>`). Never re-verified for
  kimi; the real binary IS Bun-compiled, so the circumstantial evidence for
  assumption 1 is the same strength as claude's.

