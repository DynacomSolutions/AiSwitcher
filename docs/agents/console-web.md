# Console (ais web) and WebUI logins

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1278-1342). Read before touching this area._

- **The console (`ais web` + `ais tui`) is a thin HTTP surface over the
  existing engines, not a second brain.** Every data endpoint delegates to
  the same functions the CLI uses (store/actions for registry mutations, the
  limits FETCHERS, usage/run.ts's provider-first aggregation, resume's
  READERS, zai-auth/ali-auth for key writes), so a behaviour fixed once is
  fixed for CLI, web, and TUI together. The two frontends (apps/web: Vite +
  React + shadcn/ui + TanStack Query; apps/tui: Rust ratatui) are LIVE views:
  both poll on documented intervals (docs/API.md), which is why
  server/expensive.ts exists — a TTL + in-flight-dedupe cache so N polling
  clients share one upstream fetch instead of hammering provider quota APIs.
  Security model, decided up front because this server can write real
  identity state: binds loopback only; Host header must be loopback-shaped
  (DNS-rebinding guard); requests authenticate via the per-boot bearer token
  in ~/.ais/web/server.json OR by being loopback peers running as the server's own uid (Linux, via /proc/net/tcp{,6}; unknown fails closed); every mutating method
  additionally requires `X-AIS-Console: 1`, a custom header cross-site pages
  cannot attach without a CORS preflight this server never answers (this is
  the CSRF story); secrets are WRITE-ONLY through the API (keys/cookies can
  be set, never read back); file editing is confined to whitelisted roots
  with dual lexical+realpath containment checks and pre-edit backups. The
   server code follows the repo's test-injection convention (`configs =
   Object.values(TOOL_CONFIGS)` parameters everywhere) so tests exercise the
   real mutation paths against synthetic temp-dir registries and can never
   touch a live home. Two gotchas are load-bearing: cli/args.ts's parseArgs
   reads ONLY `--flag=value` (a space-separated value silently degrades into a
   boolean flag plus stray positional — bit once already during the daemon
   spawn work), and identities/match.ts's expandPath resolves bare relative
   paths against process.cwd(), which is registry-storage semantics and
   therefore deliberately NOT used for user-supplied paths inside the files
   API (there, relative means "relative to the selected root").

- **WebUI logins run the real CLIs' own flows with piped stdio (or a
  script PTY), surfaced to a remote browser — never a second auth
  implementation.** The console's Auth page can start a per-identity login
  for claude/codex/grok/kimi (`POST /api/auth/login` -> LoginFlowManager,
  src/server/login-flows.ts). The design constraints, all verified live on
  this machine (2026-09-10): the user's browser is on a DIFFERENT device
  (SSH-hosted daemon), so the daemon surfaces the flow's auth URL/device
  code through the API instead of opening anything locally.
  claude's `auth login` renders an Ink UI that prints NOTHING under plain
  pipes, so the daemon allocates a pseudo-terminal with util-linux `script`
  (`-qfec`); claude's redirect URI is a remote page that displays a code, so
  completion works from any device and the pasted code (or full redirect
  URL) is injected on the CLI's own stdin prompt ("Paste code here if
  prompted") — injection verified live down to the real token exchange
  (an invalid code visibly reached it). codex/grok/kimi ship device-code
  flows that work under plain pipes and poll to completion themselves
  (`--device-auth`, `--device-auth`, bare `login`), so no injection is
  needed; device codes are surfaced to the UI (they are display values, not
  secrets). pi has no login subcommand and opencode's clack prompts proved
  non-injectable under a script PTY (verified live: keystrokes reached the
  pty but the prompt never submitted), so both fall back to the legacy
  terminal handoff, and zai/ali remain key/cookie writes by design.
  Load-bearing details: the flows spawn `resolveRealBinary()`'s REAL binary,
  never the shim (spawning the shim from a daemon with a nonstandard HOME
  recursed shim-into-shim, observed live, because the managed-bin dir moves
  with HOME); session-marker env vars are stripped for the same reason
  exec.ts strips them; credential completion is detected by path+mtime+size
  fingerprints (never contents) shared with the status probes via
  credentialPathsForTool(); error text is redacted (token-shaped runs) and
  output tails never contain the pasted code; flows time out after 15
  minutes. GET /api/auth additionally reports per-identity expiry
  timestamps read from the stored credentials (claude `.credentials.json`,
  codex JWTs, kimi/pi/opencode expiry fields) plus ali's scheduler refresh
  state, so the identity list can show logged in / expiring / expired /
  not logged in / unknown per tool.

