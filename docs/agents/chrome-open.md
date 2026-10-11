# open shim and Chrome profile per identity

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 706-762 3457-3592). Read before touching this area._

- **Chrome-profile-per-identity is implemented as a PATH shim (`open`), not a
  Claude Code/Codex/Grok/Kimi Code setting.** Checked docs.claude.com and the
  Codex CLI config reference (2026-07-06): neither tool exposes a `BROWSER`
  env var, a settings.json key, or a pre-open hook for controlling
  auto-opened links (e.g. the `/login` OAuth flow) — grok's `login`
  subcommand (OAuth via auth.x.ai) and kimi's OAuth flow (auth.kimi.com) were
  not separately checked for an equivalent lever, but are assumed to have the
  same gap by default. The only viable lever is the same PATH-shim trick this
  project already uses for `claude`/`codex`/`grok`/`kimi` themselves, applied
  to `open` (macOS's URL-opening command): `src/open.ts`
  installs to `~/.local/bin/open`, ahead of `/usr/bin/open` on `PATH`. Only
  built/shipped for darwin (`scripts/build.ts`/`scripts/install.ts`/
  `src/installer.ts`/the release workflow all gate it out elsewhere) —
  there's no equivalent bare `open` command on Linux to fall back to for
  passthrough, so shipping it there would turn ordinary `open <file>` calls
  into hard crashes instead of transparent passthrough.
- **The redirect target is the identity's own isolated Chrome (Claude MCP)
  instance.** An existing Chrome profile directory does not establish account
  ownership, and automated login flows must stay separate from personal
  browsing profiles. The distinct bundle IDs (`CFBundleIdentifier`:
  `com.google.Chrome` for real Chrome vs `com.google.Chrome.claude-mcp` for
  `Chrome (Claude MCP).app`) that `open -a "Google Chrome"` can **never**
  resolve to the MCP-dedicated copy — the two are registered as completely
  separate apps to LaunchServices, so no amount of retargeting the profile
  *string* could have redirected into Chrome (Claude MCP); only changing
  which *app* gets launched could. Redesigned so `open <url>` instead targets
  the SAME per-identity Chrome (Claude MCP) instance the `chrome-devtools`
  MCP server already uses (see "Chrome profile per identity" below) — no
  per-identity config value is needed any more for the default case, since
  the active identity's own name is enough; `chromeProfile` was dropped from
  `Identity` entirely, and `ChromeProfileOverride.chromeProfile` (a raw
  Chrome profile string) was renamed to `.targetIdentity` (an identity name
  to borrow that identity's Chrome (Claude MCP) instance instead).
- **`open`'s activation check is a dedicated marker env var
  (`IDENTITY_SESSION_MARKER` / `AI_PROFILE_SWITCHER_SESSION`, `src/shared/exec.ts`),
  not `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`/`KIMI_CODE_HOME`
  directly.** First cut of
  this feature keyed `open`'s activation off "is `CLAUDE_CONFIG_DIR`/
  `CODEX_HOME` present in my environment" — but `resolve.ts` step (b)
  explicitly treats an already-set env var as a legitimate, permanent,
  deliberate power-user override (e.g. exported once in a shell rc), not just
  something inherited from a nested subagent. Keying off the env var alone
  meant a shell with `CLAUDE_CONFIG_DIR` pinned that way would redirect
  *every* `open` call in that shell — `gh pr view --web`, `git`, unrelated
  scripts — not just ones claude/codex/grok/kimi actually triggered.
  `run-wrapper.ts` now sets a second, dedicated marker (via `execReal`'s
  `extraEnv`, so it only ever lands on the child process the wrapper itself
  spawns) alongside the resolved config-dir env var; `open.ts` requires the
  marker before doing anything, making "only ever changes behavior for
  descendants of our own claude/codex/grok/kimi wrapper" actually true
  instead of just documented. `open.ts`'s `resolveActiveChromeProfile()`
  loops over an array of all four `ToolConfig`s (`TOOL_CONFIGS` in
  `src/open.ts`, distinct from the same-named export in
  `src/cli/identities/resolve-tool.ts`) rather than branching on two
  hardcoded env vars, so a fifth tool only needs appending to that array.
  See "Chrome profile per identity" below for the (still) unverified spike
  outcome this doesn't cover.

## Chrome profile per identity (auto-opened links)

Auto-opened links (OAuth `/login`, etc.) redirect into the active identity's
own isolated **Chrome (Claude MCP)** instance — the exact same dedicated,
per-identity automation browser the `chrome-devtools` MCP server already uses.
Identity names, ports, and Chrome profile directories are machine-local data
loaded from `~/.ais/config/chrome-mcp.json` (or
`AIS_CHROME_MCP_CONFIG`), never source-controlled configuration.
A top-level `chromeProfileOverrides` array can redirect a specific directory
to a **different** identity's Chrome (Claude MCP) instance instead — same
pattern grammar as `directories` (see `src/identities/match.ts`), most-
specific wins, and it takes precedence over the active identity when both
would otherwise apply:

```text
{
  "version": 1,
  "identities": [ ... ],
  "chromeProfileOverrides": [
    { "directories": ["<absolute-directory>/*"], "targetIdentity": "<name>", "label": "optional note" }
  ]
}
```

**Mechanism** (`src/open.ts`, installed as `~/.local/bin/open`, darwin only;
`src/identities/chrome-mcp.ts` for machine-local config + self-heal + CDP call):
requires running inside a session our own claude/codex/grok/kimi/zai wrapper
launched (`IDENTITY_SESSION_MARKER`, same guard as before) with
`resolveChromeMcpTarget()` resolving an identity. Once resolved:

1. `ensureChromeMcpRunning(identityName)` checks whether that identity's port
   is listening (`GET /json/version`); if not, and `devserver ls` shows the
   `chrome-mcp-<identity>` session is genuinely missing (mirrors
   `chrome-mcp-ensure-running.sh`'s hook logic exactly, including the same
   guard against double-launching a duplicate window), runs the same Recovery
   launch command and polls up to 15s.
2. `openUrlInChromeMcp(port, url)` opens the URL as a new tab via the
   already-running instance's **full CDP WebSocket protocol** —
   `Target.createTarget` with `{ url, background: true, newWindow: false }`
   — never an app launch, and never the simpler HTTP `/json/new` endpoint.

   **First cut used HTTP `/json/new` and shipped a real, user-visible bug
   (2026-07-14, caught immediately in the same session): it stole OS-level
   window focus every time a link opened**, because `/json/new` has no
   parameter for background tab creation at all — it always activates the
   new tab and brings the whole Chrome window to the front. This is exactly
   the failure mode the `chrome-mcp-profile` skill's `background: true`
   convention (`mcp__chrome-devtools__new_page`'s own param) exists to
   prevent — "this browser is shared, visible, and not yours alone." The fix
   required moving off the HTTP endpoint entirely: `background`/`newWindow`
   are only accepted by `Target.createTarget` over the WebSocket protocol
   (`webSocketDebuggerUrl` from `GET /json/version`), the same mechanism
   puppeteer/chrome-devtools-mcp itself relies on for the already-proven
   "don't steal focus" guarantee elsewhere in this project. Verified the
   WebSocket call succeeds with these params against a fully disposable,
   throwaway **headless** Chrome instance on an unused port with a `/tmp`
   `--user-data-dir` — deliberately never re-touching any real identity's
   visible Chrome (Claude MCP) window to "verify the fix," since the whole
   point was to stop doing that.

   Two more things confirmed empirically against a live instance
   (2026-07-14), neither documented anywhere in Chrome's own docs, both still
   true of the current WebSocket-based implementation: `GET /json/new`
   (the old HTTP endpoint) returns 405 on this Chrome build (150.x) — the
   DevTools HTTP endpoints require `PUT`, CSRF hardening added at some point
   — moot now that HTTP `/json/new` isn't used at all, but worth remembering
   if anything ever needs it again; and an unencoded target URL passed
   through a URL-shaped CDP/HTTP parameter gets silently truncated at its
   first embedded `&` (whatever's parsing the query string treats it as a
   break into a new, unrecognized param and drops everything after) — e.g. an
   OAuth callback's `&state=...` vanishes silently unless the URL is passed
   as a proper JSON string value (as `Target.createTarget`'s WebSocket
   `params.url` does — no manual encoding needed there, since it's a JSON
   payload field, not a query string).

When a redirect actually happens (success or failure at any stage — target
resolution, self-heal timeout, CDP call failure), `open.ts` prints one
`console.error` diagnostic line; a failure at any stage falls through to
unmodified `open` rather than hanging or erroring outright, matching the
"never let this shim break plain `open`" principle from before — but always
loudly, never silently, per the 2026-07-14 identity-a incident where a silent
browser-tool fallback (unrelated to this file, but the same failure shape)
went unnoticed for 4+ days.

**Spike outcome: still UNVERIFIED**, same two stacked assumptions as before —
the redirect *target* changed, but neither of these was re-tested, since both
are about whether `open.ts` gets invoked at all, independent of what it does
once invoked:

1. That the real `claude`/`codex`/`grok`/`kimi`/`crush` binaries (and
   whatever they spawn for OAuth login) invoke the bare command name `open`
   via a PATH lookup, the same way
   `Bun.spawn(["open", ...])`/Node's `child_process.spawn("open", ...)` do —
   rather than a hardcoded absolute path like `/usr/bin/open`, which would
   make this shim invisible to them. Circumstantial evidence is strong (the
   real `claude` binary is itself Bun-compiled, and shelling out via bare
   command name is the standard portable pattern — hardcoding an absolute
   path is unusual and non-idiomatic) but this was NOT confirmed empirically:
   attempts to drive a real onboarding/login flow through `expect` inside
   this sandbox to observe whether a logging decoy at `~/.local/bin/open` got
   hit were blocked by the sandbox's lack of pty allocation for nested
   interactive sessions.
2. That the actual invocation shape is the bare `open <url>` this shim
   intercepts (`urlToOpenInBrowser` in `src/open.ts`, zero other flags). If
   the real call includes any extra flag (e.g. `-g` to avoid stealing focus),
   this shim's narrow guard rejects it and falls through to passthrough —
   deliberately conservative (a wrong guess broadening it risks hijacking
   unrelated `open` calls) but untested against the real invocation shape.

kimi, zai, and ali are wired identically (`src/open.ts`'s `TOOL_CONFIGS` now
includes all three, so redirects resolve for wrapped kimi/zai/ali sessions
too) but were never re-verified under either of the two assumptions above:
treat all three as exactly as unverified as for the other tools. Moot for
zai's and ali's CURRENT designs either way: crush's Z.ai/Alibaba auth (see
"zai case study, take 3" and "ali case study") is a one-time file write
(`identities/zai-auth.ts`/`identities/ali-auth.ts`), with no browser OAuth
flow involved at all, so no auto-opened link is expected to fire for either
session in the first place; this redirect mechanism simply has nothing to
do for zai or ali. (Historical note: zai's take-1 real binary, opencode, DID
have an interactive `opencode auth login` OAuth-style flow, never attempted
through this project's `open` shim at the time — moot now that zai's auth
model has changed entirely, and ali never had an equivalent design to begin
with.)

If assumption 1 is wrong: drop the mechanism entirely, document that here,
and fall back to `/login`'s manual "press `c` to copy the URL" flow. If only
assumption 2 is wrong: broaden `urlToOpenInBrowser` once the real flag shape
is known — don't guess at further flag combinations blind.

**To verify for real** (safe, ~30 seconds, after `bun run install:shims`): run
`claude --identity=<name>` somewhere that triggers a fresh login (or any
other auto-opened link) and watch whether a new tab appears in that
identity's Chrome (Claude MCP) window instead of your regular daily-driver
Chrome. If a real Chrome window opens instead (or nothing redirects at all),
the bare-command-name assumption is wrong — drop this mechanism and record
that finding here instead of iterating on it further.

