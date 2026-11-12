# AIS Browser (Chrome extension)

Lets Claude and Codex sessions drive a real Chrome profile through the gateway. The extension (`apps/chrome-extension`, MV3) holds a WebSocket to the gateway relay; each agent session reaches it through the `ais-browser` MCP server (`ais browser mcp`). Source of truth for the design: the AIS Browser design spec in the task data folder.

## Install on the Mac

1. If your AIS and gateway are on a private network (for example Tailscale), it must be running, or the extension cannot reach them.
2. `ais browser extension update` downloads the latest `ais-browser-extension.zip` release asset (via `gh`, else the GitHub REST API with `GITHUB_TOKEN` or `GH_TOKEN`) and swaps it into `~/.ais/browser-extension/` atomically (old folder renamed aside, new one renamed in, old removed; on any failure the old folder stays). `--from=<zip>` installs a local zip instead.
3. `ais browser extension path` prints the folder.
4. In Chrome: `chrome://extensions`, enable Developer mode, Load unpacked, pick that folder. Repeat in every Chrome profile that should be drivable (each profile connects separately).
5. Later versions install themselves (see Updates). After a manual `update`, the extension reloads itself on its next check, or reload it in chrome://extensions.

## Updates

The extension updates itself, separately from the AIS command line. Chrome does not let an extension write its own files, so a small AIS helper does it: Chrome starts `ais browser extension host` over native messaging, and the helper reads the latest release from GitHub and swaps `~/.ais/browser-extension` the same way `ais browser extension update` does (never to an older or the same version). The extension then reloads itself as soon as no agent call is running. Sessions, their tabs and granted groups are handed to the reloaded extension through `chrome.storage.local`, because a reload clears `chrome.storage.session`.

- The side panel's Updates card shows the running version and the latest release, with Check for updates, Update now and an Update automatically switch (on by default; checks at most every 6 hours).
- The helper is registered by `ais update` and `ais browser extension update` (or `ais browser extension install-host`). They write `~/.ais/browser-host/ais-browser-host` and a host manifest in each Chrome-family browser's `NativeMessagingHosts` folder, allowed only for the unpacked extension id of `~/.ais/browser-extension`. `ais update` never changes the extension's files.
- When files on disk are already newer (for example after `ais browser extension update`), a check only reloads the extension.
- The first version with this feature (it adds the `nativeMessaging` permission) still needs one manual reload in chrome://extensions. Developer mode must stay on: Chrome disables an unpacked extension that reloads while it is off.

## Connect and bind

1. Open the AIS Browser side panel (toolbar button). Type the address of your AIS Console (for example `https://ais.example.com`) and press Connect. The panel names the Chrome account email as the profile label, or "Chrome on <platform> <id>" when no account is signed in.
2. Chrome opens the console page `/browser/authorize`: "Connect <label> to AIS". Pick a pool (the first is preselected) or an identity and press Approve. An identity binding serves that identity; a pool binding serves every identity in the swap pool.
3. The page returns to the extension, which stores the token and the gateway relay address the console handed out, and shows Connected. Nothing needs the CLI.
4. `ais browser list [--json]` shows bindings and when each browser last connected. `ais browser approve <CODE>` remains an admin command for the older pairing-code flow.

The console does the approval server-side: it starts a pairing on the gateway, approves it with the gateway admin bearer, and claims the token. The bearer never reaches the browser. The page has no login: the console is meant to sit on a private network. It is guarded by a CSRF cookie and a strict `redirect_uri` check (`https://<32 letters a-p>.chromiumapp.org/...`, optionally limited to the extension ids in `AIS_CONSOLE_EXTENSION_IDS`). Gateway and console URLs may carry a path prefix such as `/gateway`.

Console configuration: `AIS_GATEWAY_PROXY_URL` (gateway proxy, reachable from the console, with any prefix), `AIS_GATEWAY_ADMIN_URL` and `AIS_GATEWAY_ADMIN_TOKEN` (env or `~/.secrets`), `AIS_CONSOLE_GATEWAY_WSS_URL` (the public `wss://` address handed to the extension; defaults to the proxy URL with `ws`), `AIS_CONSOLE_EXTENSION_IDS` (optional comma-separated allowlist). Without the first three the page answers 503.

## Agent tokens

Run `ais browser agent-token <identity>` once per identity, not per host; `ais sync` distributes the token file to your other hosts. It mints a token (replacing any earlier one), writes it 0600 to `<configDir>/ais-browser-token` for the identity's claude and codex config dirs and to `~/.secrets` as `AIS_BROWSER_AGENT_<IDENTITY>_TOKEN`, and never prints it. Then relaunch the sessions: launches that find a token wire the `ais-browser` MCP server. `--revoke` removes the token everywhere.

Swap pools: mint a token for each pool member (`ais browser agent-token <member>`); the pool directory itself never holds one. A pool launch (claude or codex) wires the `ais-browser` MCP server when any allowed, non-retired member has a token, and the shim is told the pool (`--pool <name> --tool <claude|codex>`) instead of a fixed identity. On every tool call the shim reads the pool's current active member from the registry and uses that member's token, so the browser is matched against whichever member is active at that moment. If the active member has no token the call fails with `no AIS Browser agent token for identity <x>; run ais browser agent-token <x>`. The session id stays the same across swaps. Tab ownership for calls routed through a pool binding is per pool, not per member: the gateway forwards `session.identity` as `pool:<name>` (the caller must still be a live allowed member of the pool) and titles the tab group with the session name, so tabs stay owned across swaps. Identity bindings keep the real identity, and an identity session can never claim a pool session's tabs.

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
- The gateway may run as several replicas. They need the shared PostgreSQL (presence table `gateway_browser_presence`, NOTIFY channel `ais_gateway_browser`) and must reach each other's admin port: every replica publishes `AIS_GATEWAY_REPLICA_URL` (default `http://$POD_IP:<admin port>`) and serves `POST /internal/browser/relay` there, authenticated with a secret derived from the admin token (HMAC; the admin token itself never leaves the replica). Keep that port cluster-internal.

## Tool timeout

The relay allows up to 125 s per call (`wait`). Codex is wired with `mcp_servers.ais-browser.tool_timeout_sec=135`. Claude Code's MCP config has no per-server timeout field; its `MCP_TOOL_TIMEOUT` env (ms) must be at least 135000. AIS sets `MCP_TOOL_TIMEOUT=135000` for the claude launch only when it is not already set.

## Limits

Each extension socket lives on the replica it connected to. Replicas publish their bindings in PostgreSQL every 5 s and on every attach, detach or pause change; a call for a browser held by another replica is forwarded to that replica's admin relay endpoint, which runs it on its local hub (and aborts it when the forwarded request is dropped). A row not refreshed for 20 s is ignored, so a dead replica's browsers disappear after at most that long. If a binding reconnects to another replica, the newer connection wins and the older socket is closed with 4409. Revoking a binding closes its socket on whichever replica holds it. If the database or the other replica is unreachable, local browsers keep working and the remote ones return `no_browser` (presence stale) or `browser_disconnected` (replica did not answer).

In-flight calls, pairing rate limits and active-session counts are per replica and may diverge; the replica that serves a call counts its metrics.

Agent tabs live in the user's window, inside the session's tab group. Agents work entirely in the background: new tabs open inactive, and navigation, input, evaluation and screenshots go through the debugger (CDP, with focus emulation on) without ever activating a tab or focusing a window, so the owner's active tab never changes. Only a click in the side panel may switch tabs. A page in an agent tab can still open a tab itself (a `target=_blank` link or `window.open` after an agent click); Chrome treats the click as a user gesture and opens that tab in the foreground. The extension spots it through CDP `Page.windowOpen` on the agent tab, adds the new tab to the agent's session (its own group, or the granted group it came from) and makes the owner's previous tab active again. When the owner is looking at the agent tab, a link opens as usual. Each session has exactly one tab group: creation is serialised per session id, the group is persisted in `chrome.storage.session`, and a live group with the same title is re-adopted after a worker restart. If Chrome still does not render a tab (minimised window), the call fails with `tab_hidden` after 8 s.

Known limit: the headless Chromium used in CI cannot reproduce headful background-tab and minimised-window behaviour on this host, so that behaviour is verified only on a real Mac with a headful Chrome.

## Metrics

`ais_gateway_browsers_connected`, `ais_gateway_browser_sessions_active`, `ais_gateway_browser_calls_total`, `ais_gateway_browser_call_seconds` (histogram: `_bucket`, `_count`, `_sum`), `ais_gateway_browser_pairings_total`.

## Release

`.github/workflows/release.yml` builds the extension (`bun run build` in `apps/chrome-extension`, `dist/` zipped with `manifest.json` at the root) and uploads `ais-browser-extension.zip` with the other assets. CI builds and tests it when the extension or `src/browser/` changes.

The tab group title and the page pill show the session name only: `AIS_SESSION_NAME` when the launcher sets it, else the short session id. Never the identity. The side panel shows only the sessions using the active tab, with Pause, Stop and Resume (profile-wide), and "No agent is using this tab." when there are none.

Granting a group: when the active tab sits in a tab group no agent uses, the side panel offers "Let an agent use this group" with a picker of the live sessions and a Grant button (a granted group shows the session and Revoke access). A granted session lists the group's tabs in `tabs_context` (`scope: "granted"`, plus `grantedGroups`), can act in them and open tabs inside the group with `tabs_create` `groupId`. It never renames, recolours or closes the group, and `close_tab` only closes tabs it opened. The grant is kept in `chrome.storage.session` and ends on Revoke, Stop, when the group is closed, or after 30 minutes without a call from the session.
