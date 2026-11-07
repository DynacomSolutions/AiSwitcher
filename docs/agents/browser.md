# AIS Browser (Chrome extension)

Lets Claude and Codex sessions drive a real Chrome profile through the gateway. The extension (`apps/chrome-extension`, MV3) holds a WebSocket to the gateway relay; each agent session reaches it through the `ais-browser` MCP server (`ais browser mcp`). Source of truth for the design: the AIS Browser design spec in the task data folder.

## Install on the Mac

1. If your AIS and gateway are on a private network (for example Tailscale), it must be running, or the extension cannot reach them.
2. `ais browser extension update` downloads the latest `ais-browser-extension.zip` release asset (via `gh`, else the GitHub REST API with `GITHUB_TOKEN` or `GH_TOKEN`) and swaps it into `~/.ais/browser-extension/` atomically (old folder renamed aside, new one renamed in, old removed; on any failure the old folder stays). `--from=<zip>` installs a local zip instead.
3. `ais browser extension path` prints the folder.
4. In Chrome: `chrome://extensions`, enable Developer mode, Load unpacked, pick that folder. Repeat in every Chrome profile that should be drivable (each profile connects separately).
5. After a later `update`, reload the extension in each Chrome profile.

## Connect and bind

1. Open the AIS Browser side panel (toolbar button). Type the address of your AIS Console (for example `https://ais.example.com`) and press Connect. The panel names the Chrome account email as the profile label, or "Chrome on <platform> <id>" when no account is signed in.
2. Chrome opens the console page `/browser/authorize`: "Connect <label> to AIS". Pick a pool (the first is preselected) or an identity and press Approve. An identity binding serves that identity; a pool binding serves every identity in the swap pool.
3. The page returns to the extension, which stores the token and the gateway relay address the console handed out, and shows Connected. Nothing needs the CLI.
4. `ais browser list [--json]` shows bindings and when each browser last connected. `ais browser approve <CODE>` remains an admin command for the older pairing-code flow.

The console does the approval server-side: it starts a pairing on the gateway, approves it with the gateway admin bearer, and claims the token. The bearer never reaches the browser. The page has no login: the console is meant to sit on a private network. It is guarded by a CSRF cookie and a strict `redirect_uri` check (`https://<32 letters a-p>.chromiumapp.org/...`, optionally limited to the extension ids in `AIS_CONSOLE_EXTENSION_IDS`). Gateway and console URLs may carry a path prefix such as `/gateway`.

Console configuration: `AIS_GATEWAY_PROXY_URL` (gateway proxy, reachable from the console, with any prefix), `AIS_GATEWAY_ADMIN_URL` and `AIS_GATEWAY_ADMIN_TOKEN` (env or `~/.secrets`), `AIS_CONSOLE_GATEWAY_WSS_URL` (the public `wss://` address handed to the extension; defaults to the proxy URL with `ws`), `AIS_CONSOLE_EXTENSION_IDS` (optional comma-separated allowlist). Without the first three the page answers 503.

## Agent tokens

Run `ais browser agent-token <identity>` once per identity, not per host; `ais sync` distributes the token file to your other hosts. It mints a token (replacing any earlier one), writes it 0600 to `<configDir>/ais-browser-token` for the identity's claude and codex config dirs and to `~/.secrets` as `AIS_BROWSER_AGENT_<IDENTITY>_TOKEN`, and never prints it. Then relaunch the sessions: launches that find a token wire the `ais-browser` MCP server. `--revoke` removes the token everywhere.

Swap pools: mint a token for each pool member (`ais browser agent-token <member>`); the pool directory itself never holds one. A pool launch (claude or codex) wires the `ais-browser` MCP server when any allowed, non-retired member has a token, and the shim is told the pool (`--pool <name> --tool <claude|codex>`) instead of a fixed identity. On every tool call the shim reads the pool's current active member from the registry and uses that member's token, so the browser is matched against whichever member is active at that moment. If the active member has no token the call fails with `no AIS Browser agent token for identity <x>; run ais browser agent-token <x>`. The session id stays the same across swaps. Tab ownership for calls routed through a pool binding is per pool, not per member: the gateway forwards `session.identity` as `pool:<name>` (the caller must still be a live allowed member of the pool) and titles the tab group `<pool> / <id>`, so tabs stay owned across swaps. Identity bindings keep the real identity, and an identity session can never claim a pool session's tabs.

## Tools

`list_browsers`, `tabs_context`, `tabs_create`, `adopt_tab`, `navigate`, `screenshot`, `read_page`, `find`, `click`, `type`, `key`, `scroll`, `hover`, `form_input`, `javascript`, `get_console`, `get_network`, `wait`, `resize`, `close_tab`. Every tool except `list_browsers` takes an optional `browser` argument, required only when several browsers are connected. Tabs must be created by the agent or adopted with `adopt_tab`; other tabs fail with `forbidden_tab`. Ownership needs both the session id and the identity that created it to match.

File upload is deliberately unsupported: it would let an agent read arbitrary local files on the Mac running Chrome (other identities' tokens, `~/.secrets`), which breaks identity isolation.

## Pause, Stop, revoke

- Pause (extension popup): calls fail with `paused_by_user` until resumed.
- Stop: ends the agent's calls with `stopped_by_user`.
- `ais browser revoke <name>` revokes the binding and drops its connection; the profile must pair again.
- Error codes: `paused_by_user`, `stopped_by_user`, `no_browser`, `ambiguous_browser`, `forbidden_tab`, `tab_closed`, `tab_hidden`, `timeout`, `browser_disconnected`, `bad_args`, `internal`.

## Deploy requirements

- The Emissary Mapping for the gateway needs `allow_upgrade: [websocket]` and `timeout_ms` of 0 or at least 130000, or long calls and the socket are cut.
- The gateway runs as a single replica.

## Tool timeout

The relay allows up to 125 s per call (`wait`). Codex is wired with `mcp_servers.ais-browser.tool_timeout_sec=135`. Claude Code's MCP config has no per-server timeout field; its `MCP_TOOL_TIMEOUT` env (ms) must be at least 135000. AIS sets `MCP_TOOL_TIMEOUT=135000` for the claude launch only when it is not already set.

## Limits

The relay keeps sockets, pairing rate limits and in-flight calls in memory, so the gateway must run as a single replica. Scaling it out needs a shared relay first.

Agent tabs live in the user's window, inside the session's tab group. Before a screenshot or input the extension brings the target tab to the front of its window (never the window itself). If Chrome still does not render it (minimised window), the call fails with `tab_hidden` after 8 s.

Known limit: the headless Chromium used in CI cannot reproduce headful background-tab and minimised-window behaviour on this host, so that behaviour is verified only on a real Mac with a headful Chrome.

## Metrics

`ais_gateway_browsers_connected`, `ais_gateway_browser_sessions_active`, `ais_gateway_browser_calls_total`, `ais_gateway_browser_call_seconds` (histogram: `_bucket`, `_count`, `_sum`), `ais_gateway_browser_pairings_total`.

## Release

`.github/workflows/release.yml` builds the extension (`bun run build` in `apps/chrome-extension`, `dist/` zipped with `manifest.json` at the root) and uploads `ais-browser-extension.zip` with the other assets. CI builds and tests it when the extension or `src/browser/` changes.
