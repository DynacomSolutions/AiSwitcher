# Console (ais web) and WebUI logins

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1278-1342). Read before touching this area._

- **The console (`ais web` + `ais tui`) is a thin HTTP surface over the
  existing engines, not a second brain.** Every data endpoint delegates to
  the same functions the CLI uses (store/actions for registry mutations, the
  limits FETCHERS, usage/run.ts's provider-first aggregation, resume's
  READERS, zai-auth/ali-auth for key writes), so a behaviour fixed once is
  fixed for CLI, web, and TUI together. The two frontends (apps/web: Vite +
  React + shadcn/ui + TanStack Query; apps/tui: Rust ratatui) use the same JSON API.
  The WebUI uses one authenticated stream for limits, usage and reset settings.
  The stream observer and JSON routes share cached reads across clients.
  Other WebUI queries and the TUI poll at the intervals in docs/API.md.
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
- The console's refresh scheduler (`src/server/auth-refresh.ts`) never refreshes a claude, codex, grok or kimi login that
  the gateway's PostgreSQL credential store owns (a `login` row in `gateway_home_files`), manual runs included: the gateway
  renews it and a second refresher would fork the rotating refresh token. Set `AIS_GATEWAY_STORE_DATABASE_URL` on the
  console wherever the gateway runs on that store. When the store cannot be read the scheduler stands down for all four
  tools (fail closed) and retries the check after 15 s. Without the variable nothing changes. ali is never affected.
- The WebUI is an installable PWA (`apps/web/public`: `manifest.webmanifest`, icons, `sw.js`). The service worker is
  deliberately network-only: it never uses the Cache API and answers nothing but a failed page navigation (with an
  inline offline page), so the console stays a live view and no API response or token lands in browser storage. The
  static server marks only Vite's hashed `/assets/` as immutable; every other file (index.html, sw.js, the manifest,
  icons) is `no-cache` so installs pick up new releases. Static files sit outside the `/api` guard, so the browser can
  fetch the manifest and worker without the token.
- Reset log: `GET /api/logs/resets` (`src/server/gateway-reset-log.ts`) is a read-only proxy of the gateway `GET /reset-log`. It checks the query with `parseResetLogQuery`, passes only known keys and answers an empty page when no gateway admin is set. The console sends `X-AIS-Actor: console` on reset calls so the gateway row names the console. Contract in `docs/API.md`; design in `docs/agents/gateway.md`.
- Reset-expiry push (`src/server/reset-expiry-push.ts`, `src/server/web-push.ts`): the worker also handles `push` and
  `notificationclick` (still no Cache API). Web Push is implemented with `node:crypto` only (RFC 8291 aes128gcm, RFC 8292
  VAPID; a test pins the RFC 8291 Appendix A vector), no web-push dependency. The daemon checks hourly through the shared
  limits scan, only while a subscription exists, and records each grant's sent stage (7d, 3d, 24h) only after a device
  accepted it, so a push service outage retries. Pool rows are skipped. Contract in `docs/API.md` (Push notifications).
- The widgets listener (`AIS_WIDGETS_PORT`, `src/server/widgets.ts`) has no auth on purpose. It serves only `GET` and `HEAD`
  for the widget panel routes. Every panel is a masked read-only summary. No public route points at the port. In the
  cluster, any pod can reach `podIP:port`. The main console port is already reachable the same way. A Host check stops DNS
  rebinding: it accepts only an IP literal, a loopback name or an `AIS_WEB_ALLOWED_HOSTS` vhost, and answers 403 for any
  other Host. Kubernetes RBAC on `services/proxy` guards Headlamp access through the API server. The listener sends no CORS
  headers and is off unless the variable is set. The main-listener routes keep the full console guard. Both listeners share
  one `WidgetService` cache, built in `serve.ts`. A failed build is remembered for up to 60 seconds, and the last good model
  is served while a refresh fails. Panel `link` values are empty unless `AIS_WIDGETS_LINK_BASE` is set. Headlamp cannot resolve
  console-relative paths. Contract: docs/API.md (Widget panels).
