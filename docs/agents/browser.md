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

### T3 Code sessions

T3 Code starts Claude and Codex through the AIS shims with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` preset to the instance's home folder. The wiring maps that folder back to a registered identity or pool (`identityForConfigDir` in `src/shared/browser-wiring.ts`), in this order:

1. The folder is the identity's config dir (for example the swap pool folder).
2. Its `projects` or `sessions` link points into an identity's config dir (`~/.t3/gateway/t3-claude-<name>`).
3. The folder sits directly in `<T3CODE_HOME>/gateway` (a folder made by `ais gateway t3-instance`, which holds only the gateway app token). Its name matches an identity name or alias, first as is, then without a `t3-claude-` / `t3-codex-` prefix, then without a `kimi-` / `zai-` segment. A remaining name `pool` maps to the tool's only swap pool. Example: a folder `<name>` where `<name>` is an alias of a Claude pool maps to that pool.

`ais browser wiring [--check] [--json]` runs the same steps as a launch (`browserLaunchWiring`) for every enabled Claude and Codex instance in `<T3CODE_HOME>/userdata/settings.json`. It prints the instance, its folder, the identity or pool, and `wired` or the reason it is not wired (`no identity`, `no token`, `ais binary not installed`). `--check` exits 1 when an instance is not wired. A session gets the tools only when it starts after the fix: resume a T3 thread or start a new one.

Reason (owner report, 19 Nov 2026): the T3 "Pool (Claude)" instance moved to a folder under `~/.t3/gateway`. That folder matched no identity, so resumed threads lost the `ais-browser` tools.

## Tools

`list_browsers`, `tabs_context`, `tabs_create`, `adopt_tab`, `navigate`, `screenshot`, `read_page`, `find`, `click`, `type`, `key`, `scroll`, `hover`, `form_input`, `upload_file`, `javascript`, `get_console`, `get_network`, `wait`, `resize`, `close_tab`, `handle_dialog`. Every tool except `list_browsers` takes an optional `browser` argument, required only when several browsers are connected. Tabs must be created by the agent or adopted with `adopt_tab`; other tabs fail with `forbidden_tab`. Ownership needs both the session id and the identity that created it to match.

`resize` emulates the tab's viewport over CDP (`Emulation.setDeviceMetricsOverride`, like DevTools responsive mode). It never resizes or moves the browser window. The override ends when the session detaches.

### When to close a tab

Close a tab only when the work in it is fully finished. A tab that waits for the owner stays open.

- Do not call `close_tab` on a tab while a step in it waits for the owner. Examples: a sign-in, a 2FA code, "Verify that it's you", a CAPTCHA, a consent or payment page, a manual review, or a question to the owner about that page. Leave the tab open on the page the owner must use.
- Before you ask the owner, make sure that the tab shows the page the owner needs (`tabs_context` or `screenshot`). In the question, give the browser profile (`profileLabel` from `list_browsers`) and the tab title, so that the owner can find the tab.
- Keep the session alive while you wait. When the agent session ends, the extension closes the tabs the session created.
- Close a tab only when the work in it is finished and verified, and neither the owner nor the agent needs it again. A move to a different step is not the end of the work in the tab.
- If you closed a tab by mistake, open it again on the correct page (`tabs_create` with the URL) before you ask the owner to act.
- At the true end of the task, close the tabs the session opened.

Agents get this rule in three places: the `ais-browser` MCP server instructions (`BROWSER_INSTRUCTIONS` in `src/browser/mcp-shim.ts`), the `close_tab` and `tabs_create` descriptions (`src/browser/tool-args.ts`) and this section. Keep the three in step.

Reason (owner report, 18 Nov 2026): an agent closed its tab at a "Verify that it's you" page, did other work, then asked the owner to sign in "in that tab". The tab was gone.

### JavaScript dialogs

A page blocked by a JavaScript dialog (alert, confirm, prompt, or beforeunload "Leave site?") answers neither input nor script, so a call on it used to hang until the 30 s timeout. The extension watches `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed` on every tab it is attached to and keeps the open dialog per tab (type, message, url, default prompt text).

- A dialog that opens while a call runs on the tab (a click, `javascript`, `navigate`, `close_tab` on a page with unsaved changes) ends that call at once with `dialog_open`, naming the dialog type and message. The call's own work is left to finish in the background once the dialog is answered.
- While a dialog is open every call on the tab fails with `dialog_open` without touching the page, except `get_console`, `get_network` and `handle_dialog`. `tabs_context` shows it as `dialog` on the tab.
- `handle_dialog {tabId, accept, promptText?}` answers it (`Page.handleJavaScriptDialog`). Nothing ever answers a dialog on the agent's behalf. Accepting a beforeunload dialog leaves the page (or lets `close_tab` close the tab) and discards the user's unsaved changes, so agents must only do it when the user asked; the tool description and the error say so. Dismissing it keeps the page and its changes, and the tab stays owned.
- `close_tab` and `navigate` never force-leave a page: they run the page's beforeunload as Chrome does. `close_tab` attaches first so a "Leave site?" dialog is seen, then waits up to 5 s for Chrome to close the tab.
- Chrome never reports a dialog that opened before the debugger attached, and then answers no command (`Page.enable` hangs). A fresh attach the page does not answer within 5 s fails with `timeout` and a message saying the page probably shows such a dialog that only the user can answer; `adopt_tab` still adopts the tab and says so. Chrome suppresses dialogs in a background tab no debugger watches, so this only happens in a foreground tab, typically one the user opened.

### File upload

`upload_file` puts files on a page's file input. The agent gives `paths`: files on the machine the agent runs on, which is often not the machine that runs Chrome. The `ais-browser` MCP server reads them there, with the rights the agent session already has, and sends only their content (`files`: name, MIME type from the file extension, base64 data) through the gateway. The target is a `ref` or a `coordinate`:

- A ref to the file input itself: the files are set on it directly.
- Anything else (the button or drop area that opens the file dialog, also inside an iframe): the extension clicks it with file chooser interception on (`Page.setInterceptFileChooserDialog`), so no dialog opens in the owner's window, and sets the files on the input that asked for them. Interception is on for that call only; the owner's own file dialogs open as usual. A cross-origin iframe is its own debugger target, so the first upload in a tab attaches to the tab's iframes (`Target.setAutoAttach`, iframes only) to catch a chooser opened inside one.

Isolation: no tool reads a file from the disk of the machine that runs Chrome, so an agent cannot reach other identities' tokens or `~/.secrets` there. The gateway and the extension accept file content only: the wire schema has no path field, a name with a folder in it is refused, and the gateway answers 400 before any browser sees the call. The extension builds the `File` objects in the page from the content (`DataTransfer`) and never calls `DOM.setFileInputFiles`, the debugger command that takes host paths. Do not add a tool or argument that takes a path on the Chrome host.

Limits: at most 10 files and 10 MiB in total per call (checked by the MCP server, the gateway and the extension). The gateway allows an upload 120 s to reach the extension. The page's `input` and `change` events come from script (`isTrusted` is false). A page that asks for files without a file input (`showOpenFilePicker`) or takes them by drag and drop only cannot be filled.

## Pause, Stop, revoke

- Pause (extension popup): calls fail with `paused_by_user` until resumed.
- Stop: ends the agent's calls with `stopped_by_user`.
- `ais browser revoke <name>` revokes the binding and drops its connection; the profile must pair again.
- Error codes: `paused_by_user`, `stopped_by_user`, `no_browser`, `ambiguous_browser`, `forbidden_tab`, `tab_closed`, `tab_hidden`, `dialog_open`, `timeout`, `browser_disconnected`, `bad_args`, `internal`.

## Deploy requirements

- The Emissary Mapping for the gateway needs `allow_upgrade: [websocket]` and `timeout_ms` of 0 or at least 130000, or long calls and the socket are cut.
- The gateway may run as several replicas. They need the shared PostgreSQL (presence table `gateway_browser_presence`, NOTIFY channel `ais_gateway_browser`) and must reach each other's admin port: every replica publishes `AIS_GATEWAY_REPLICA_URL` (default `http://$POD_IP:<admin port>`) and serves `POST /internal/browser/relay` there, authenticated with a secret derived from the admin token (HMAC; the admin token itself never leaves the replica). Keep that port cluster-internal.

## Tool timeout

The relay allows up to 125 s per call (`wait`). Codex is wired with `mcp_servers.ais-browser.tool_timeout_sec=135`. Claude Code's MCP config has no per-server timeout field; its `MCP_TOOL_TIMEOUT` env (ms) must be at least 135000. AIS sets `MCP_TOOL_TIMEOUT=135000` for the claude launch only when it is not already set.

## Limits

Each extension socket lives on the replica it connected to. Replicas publish their bindings in PostgreSQL every 5 s and on every attach, detach or pause change; a call for a browser held by another replica is forwarded to that replica's admin relay endpoint, which runs it on its local hub (and aborts it when the forwarded request is dropped). A row not refreshed for 20 s is ignored, so a dead replica's browsers disappear after at most that long. If a binding reconnects to another replica, the newer connection wins and the older socket is closed with 4409. Revoking a binding closes its socket on whichever replica holds it. The database is the authority: remote presence only lists bindings that are active in `browser_bindings`, and the relay re-checks the binding before calling the local hub, so a revocation whose NOTIFY was lost still takes effect (a failing check lets the call through). If the database or the other replica is unreachable, local browsers keep working and the remote ones return `no_browser` (presence stale) or `browser_disconnected` (replica did not answer).

In-flight calls, pairing rate limits and active-session counts are per replica and may diverge; the replica that serves a call counts its metrics.

Agent tabs live in the user's window, inside the session's tab group. Agents work entirely in the background: new tabs open inactive, and navigation, input, evaluation and screenshots go through the debugger (CDP, with focus emulation on) without ever activating a tab or focusing a window, so the owner's active tab never changes. Only a click in the side panel may switch tabs. A page in an agent tab can still open a tab itself (a `target=_blank` link or `window.open` after an agent click); Chrome treats the click as a user gesture and opens that tab in the foreground. The extension spots it through CDP `Page.windowOpen` on the agent tab, adds the new tab to the agent's session (its own group, or the granted group it came from) and makes the owner's previous tab active again. When the owner is looking at the agent tab, a link opens as usual. Each session has exactly one tab group: creation is serialised per session id, the group is persisted in `chrome.storage.session`, and a live group with the same title is re-adopted after a worker restart. If Chrome still does not render a tab (minimised window), the call fails with `tab_hidden` after 8 s.

Known limit: the headless Chromium used in CI cannot reproduce headful background-tab and minimised-window behaviour on this host, so that behaviour is verified only on a real Mac with a headful Chrome.

## Metrics

`ais_gateway_browsers_connected`, `ais_gateway_browser_sessions_active`, `ais_gateway_browser_calls_total`, `ais_gateway_browser_call_seconds` (histogram: `_bucket`, `_count`, `_sum`), `ais_gateway_browser_pairings_total`.

## Release

`.github/workflows/release.yml` builds the extension (`bun run build` in `apps/chrome-extension`, `dist/` zipped with `manifest.json` at the root) and uploads `ais-browser-extension.zip` with the other assets. CI builds and tests it when the extension or `src/browser/` changes.

The tab group title and the page pill show a readable session name, never an id and never the identity. The shim picks the first of these and looks again every 30 s:

1. The T3 Code thread title, when the agent runs in T3 Code. T3 sets `T3CODE_THREAD_ID` (and `T3CODE_HOME`) in the agent process, so a shell that runs `ais browser mcp` gets it too. The shim reads the title from `<T3CODE_HOME>/userdata/statev2.sqlite` (table `orchestration_v2_projection_threads`) read-only, with one primary-key lookup (`src/browser/t3-thread-title.ts`). Any failure gives no title.
2. The Claude or Codex chat name from the transcript (`/rename` or the automatic title).
3. `AIS_SESSION_NAME`, when the launcher sets it.
4. `<Tool> in <folder>` (for example `Claude in my-app`): the tool and the last part of the working directory.

Reason (owner report, 19 Nov 2026): T3 sessions have no transcript title, so tab groups showed the short session id. The side panel shows only the sessions using the active tab, with Pause, Stop and Resume (profile-wide), and "No agent is using this tab." when there are none.

Granting a group: when the active tab sits in a tab group no agent uses, the side panel offers "Let an agent use this group" with a picker of the live sessions and a Grant button (a granted group shows the session and Revoke access). A granted session lists the group's tabs in `tabs_context` (`scope: "granted"`, plus `grantedGroups`), can act in them and open tabs inside the group with `tabs_create` `groupId`. It never renames, recolours or closes the group, and `close_tab` only closes tabs it opened. The grant is kept in `chrome.storage.session` and ends on Revoke, Stop, when the group is closed, or after 30 minutes without a call from the session.
