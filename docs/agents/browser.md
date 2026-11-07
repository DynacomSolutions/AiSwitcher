# AIS Browser (Chrome extension)

Lets Claude and Codex sessions drive a real Chrome profile through the gateway. The extension (`apps/chrome-extension`, MV3) holds a WebSocket to the gateway relay; each agent session reaches it through the `ais-browser` MCP server (`ais browser mcp`). Source of truth for the design: the AIS Browser design spec in the task data folder.

## Install on the Mac

1. Tailscale must be running: the gateway hostname is Tailnet-only, so the extension cannot connect without it.
2. `ais browser extension update` downloads the latest `ais-browser-extension.zip` release asset (via `gh`, else the GitHub REST API with `GITHUB_TOKEN` or `GH_TOKEN`) and swaps it into `~/.ais/browser-extension/` atomically (old folder renamed aside, new one renamed in, old removed; on any failure the old folder stays). `--from=<zip>` installs a local zip instead.
3. `ais browser extension path` prints the folder.
4. In Chrome: `chrome://extensions`, enable Developer mode, Load unpacked, pick that folder. Repeat in every Chrome profile that should be drivable (each profile pairs separately).
5. After a later `update`, reload the extension in each Chrome profile.

## Pair and bind

1. Open the extension options page. Set Gateway URL to the `wss://` form of the host in `AIS_GATEWAY_PROXY_URL` (same host and path prefix, `wss://` instead of `https://`; for example `https://gw.example.com/gateway` becomes `wss://gw.example.com/gateway`). `ws://` is accepted only for localhost.
2. Press Sign in. The page shows a pairing code.
3. On a machine with the gateway admin settings in `~/.secrets`: `ais browser approve <CODE> --identity=<id>` or `--pool=<pool>` (exactly one; `--name=<n>` names the binding). An identity binding serves that identity; a pool binding serves every identity in the swap pool.
4. `ais browser list [--json]` shows bindings and when each browser last connected.

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
