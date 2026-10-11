# Desktop apps (--desktop)

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3396-3455). Read before touching this area._

## Desktop apps

`--desktop` on the `claude` wrapper launches Claude.app's real binary directly
(bypassing `open`, which does not forward env vars to the launched app) with
the resolved `CLAUDE_CONFIG_DIR` set. **Codex has a native, better path**:
`codex app [PATH]`, run *through* the codex wrapper (so `CODEX_HOME` is already
correctly set on the real `codex` process before it launches the desktop app)
— try this before reaching for a `--desktop`-style hack on codex. **Grok has
neither** — no `grok app` subcommand and no `/Applications/Grok.app` bundle
found on this machine — `--desktop` is wired up structurally for grok anyway
(consistency with the generic `runWrapper`/`launchDesktopApp` code path), but
is expected to just fail resolving the app bundle binary. **Kimi is the
same** — no `kimi app` subcommand and no `/Applications/Kimi*.app` bundle
found on this machine (checked 2026-07-17) — `--desktop` is wired up
structurally for kimi anyway (same consistency argument), and is likewise
expected to just fail resolving the app bundle binary. **zai is now the same
category as grok/kimi too** — its current real binary, `crush`, is a
terminal-only CLI with no known desktop app bundle — `--desktop` for zai is
wired up structurally (appName `"Crush"`) but expected to just fail
resolving `/Applications/Crush.app`. (This flips zai's own earlier note:
when zai's real binary was `opencode`, a real `OpenCode.app` cask DID exist —
see "zai case study, take 1" — but that's moot now that zai proxies crush
instead.) **ali is in the identical category to zai.** Same real binary
(`crush`), same terminal-only CLI with no known desktop app bundle,
`--desktop` for ali wired up structurally (appName `"Crush"`, same as zai)
but expected to just fail resolving `/Applications/Crush.app` too (see the
"ali case study" above.

**Spike outcome (fill in after running verification step 12):**
- `codex --identity=<name> app .` — TODO: does the launched Codex.app actually
  reflect the identity, or does it manage its own account independent of
  `CODEX_HOME`?
- `claude --identity=<name> --desktop` — TODO: does Claude.app's embedded
  Claude Code/Cowork feature respect `CLAUDE_CONFIG_DIR`, or is its identity
  determined purely by its own logged-in OAuth session (its
  `claude-code-sessions/` storage is keyed by Anthropic account UUID, which
  points this way, but wasn't confirmed empirically before shipping v0.1)?
- `grok --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-13: no
  `Grok.app` exists on this machine to even attempt launching. Not re-checked
  on a machine that does have one installed; if the user installs a Grok
  desktop app later, re-verify rather than assuming this stays negative.
- `kimi --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-17: no
  `Kimi.app` (no `/Applications/Kimi*.app` at all) exists on this machine to
  even attempt launching. Same caveat as grok: if the user installs a Kimi
  desktop app later, re-verify rather than assuming this stays negative.
- `zai --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-17
  (take 3): no `Crush.app` exists on this machine (crush is a terminal-only
  CLI with no known desktop bundle) to even attempt launching. Same caveat
  as grok/kimi: re-verify rather than assume this stays negative if that
  ever changes. (Superseded finding: when zai's real binary was `opencode`
  — take 1 — a real `OpenCode.app` Homebrew cask DID exist but was untested;
  moot now.)
- `ali --identity=<name> --desktop`: verified NEGATIVE as of 2026-08-07,
  same basis as zai: no `Crush.app` exists on this machine, and ali's real
  binary is the identical `crush` CLI. Same caveat: re-verify rather than
  assume this stays negative if that ever changes.

If either comes back negative: drop that mechanism and document here that
desktop identity switching for that app can only be done via its own in-app
login/logout UI.

