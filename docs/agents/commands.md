# Commands (original text)

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3364-3394). Read before touching this area._

- `bun install` — install dependencies.
- `bun test` — run the unit test suite (`test/match.test.ts`, `test/resolve.test.ts`,
  `test/chrome-profile.test.ts`, `test/codex-backfill.test.ts`,
  `test/store.test.ts`, `test/cli-args.test.ts`, and `test/cli/*`).
- `bun run build`: `bun build --compile` all eight proxy entrypoints (`claude`,
  `codex`, `grok`, `kimi`, `zai`, `ali`, `pi`, `opencode`) plus `open`
  (darwin only), `ais`, and the installer into `dist/`.
- `bun run backup` — snapshots `~/.claude`, `~/.claude-identity-a`,
  `~/.claude-personal`, `~/.codex`, `~/.grok`, `~/.kimi-code`, `~/.zai`,
  `~/.ali`, `~/.pi`, and `~/.opencode` into the git-only repo at `~/.ais/backups/.git` (work tree `$HOME`, no plain copy) and
  commits whatever changed since the last backup (see "~/.ais: one
  consolidated root" above).
- `bun run migrate` — **one-time, destructive.** Restructures the real
  `~/.claude`/`~/.codex` directories into the `identities/<name>/` layout.
  Refuses to run if a `claude`/`codex` process is currently running (checked
  via `pgrep`) — run it from a plain terminal, not from inside an active
  Claude Code/Codex session. Takes a fresh backup first, unconditionally.
  Does NOT cover `~/.grok`, `~/.kimi-code`, `~/.zai`, or `~/.ali`: those
  directories started fresh/unauthenticated when grok/kimi/zai/ali support
  was added, with nothing worth preserving under a default identity, so
  this script was intentionally left claude/codex-only rather than
  generalized speculatively.
- `bun run install:shims` — backs up, then copies `dist/claude`/`dist/codex`/
  `dist/grok`/`dist/kimi`/`dist/zai`/`dist/ali`/`dist/pi`/`dist/opencode`/
  `dist/open` to `~/.local/bin`.
  Open a new terminal (or `hash -r`) afterward, and for grok and kimi
  specifically, verify with `which grok` / `which kimi` that they actually
  resolve to `~/.local/bin/grok` / `~/.local/bin/kimi` (see the PATH-ordering
  caveat under "Key design decisions"). `zai`/`ali` have no equivalent
  PATH-ordering risk: there's no real `zai`/`ali` binary anywhere on `PATH`
  to lose a race against.

