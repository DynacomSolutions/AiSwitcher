# AIS Browser (Chrome extension)

Lets Claude and Codex sessions drive a real Chrome profile through the gateway. The extension (`apps/chrome-extension`, MV3) holds a WebSocket to the gateway relay; each agent session reaches it through the `ais-browser` MCP server. The shared server is the gateway itself (`POST <gateway>/browser/mcp`). Claude gets the server entry from the shared-skills plugin in the `.ais` repository, Codex from `ais browser codex-config`. The AIS launcher adds no browser wiring. The stdio server `ais browser mcp` is only a fallback that nothing starts. Source of truth for the design: the AIS Browser design spec in the task data folder.

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

T3 Code starts Claude and Codex with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` preset to the instance's home folder. `ais browser headers` maps that folder back to a registered identity or pool (`identityForConfigDir` in `src/shared/browser-wiring.ts`), in this order:

1. The folder is the identity's config dir (for example the swap pool folder).
2. Its `projects` or `sessions` link points into an identity's config dir (`~/.t3/gateway/t3-claude-<name>`).
3. The folder sits directly in `<T3CODE_HOME>/gateway` (a folder made by `ais gateway t3-instance`, which holds only the gateway app token). Its name matches an identity name or alias, first as is, then without a `t3-claude-` / `t3-codex-` prefix. A remaining name `pool` maps to the tool's only swap pool. Example: a folder `<name>` where `<name>` is an alias of a Claude pool maps to that pool. Kimi and Z.ai folders (`t3-claude-kimi-*`, `t3-claude-zai-*`) never map: they would send page content to another provider.

Reason (owner report, 19 Nov 2026): the T3 "Pool (Claude)" instance moved to a folder under `~/.t3/gateway`. That folder matched no identity, so resumed threads lost the `ais-browser` tools.

## Shared MCP service (the gateway)

Reason (owner decisions, 19 and 20 Nov 2026): one stdio `ais browser mcp` process per session cost about 110 MB each, and a failed wiring left a session with no tools. The owner asked for one shared, stateless server that starts when needed. AIS is being removed from the hosts, so the server must not be a host daemon or a systemd unit. Everything is meant to run in the agent pods later. The one shared server is therefore the AIS gateway, which runs in k3s and is always on. An earlier design (PR 635) ran a loopback daemon `ais browser mcp-serve` with a systemd unit. It was never installed on a host and is removed.

Design:
- `POST <gateway>/browser/mcp` is MCP Streamable HTTP. It answers `application/json` (no SSE), `202` for notifications, `405` for `GET`. `DELETE` ends a session. Code: `src/gateway/browser/mcp.ts`, mounted next to `/browser/call` in `src/gateway/app.ts`.
- Auth: `Authorization: Bearer <agent token>`, checked by the same code as `/browser/call` (`agentFromRequest`, `authAgentToken`). The identity comes from the token only.
- It is stateless. `initialize`, `ping` and `tools/list` do the token check and nothing else: no store, database or file work, so tool registration stays cheap under load. Any gateway replica can answer any request.
- `tools/call` runs the `/browser/call` code in-process (`createBrowserCaller` in `src/gateway/browser/routing.ts`). It makes no HTTP call to itself.
- Shared parts of the shim and the endpoint (`BROWSER_INSTRUCTIONS`, `mapCallResult`, protocol versions) live in `src/browser/mcp-core.ts`. It has no Node or file system code.
- Cancel: a client cancels with a separate `notifications/cancelled` POST. The gateway keeps each running call under a hash of (identity, session id, request id) and aborts it. The cancel may reach another replica, so it also goes out as a NOTIFY on the browser channel (`cancel`), and every replica aborts a matching call. A cancel from another identity never matches.
- Metric: `ais_gateway_browser_mcp_requests_total{method,outcome}`. The labels come from fixed sets (see `src/gateway/metrics.ts`).

Session description (request headers, set at launch and validated by the gateway):
- `X-AIS-Session-Id`: optional, and `ais browser headers` does not send it. When absent, the gateway uses `Mcp-Session-Id`. A client with neither gets one: the `initialize` reply carries a new `Mcp-Session-Id`, and the client sends it back. A `tools/call` with no session id is a tool error.
- `X-AIS-Session-Label`: a readable name, percent-encoded, cleaned and capped at 80 characters. It names the tab group.
- `X-AIS-Pool`: the pool name for a pool launch. The gateway checks that the token's identity is a live allowed member of that pool, as `/browser/call` does for a pool binding. A non-member gets a tool error (`DELETE`: 403). Tab ownership stays per pool, as described under Agent tokens.
- A bad id, pool name or label gets `400`.

Client wiring (owner decision, 20 Nov 2026: the server entry comes from `.ais`, not from the AIS launcher):
- Claude: the shared-skills plugin (repository `.ais`, folder `skills-shared`) ships `.mcp.json` with the `ais-browser` server: `type: http`, the gateway URL `<gateway>/browser/mcp` and `headersHelper: "ais browser headers --tool=claude"` and `timeout: 135000`. Claude Code runs the helper when it connects and reads the JSON it prints as request headers. The plugin never holds a token. Claude names the plugin tools `mcp__plugin_shared-skills_ais-browser__<tool>`.
- Codex 0.167 has no plugin `.mcp.json` path that fits, so `ais browser codex-config [<codex home>...]` writes a managed block in each Codex folder's `config.toml`: `[mcp_servers.ais-browser]` with `url`, `http_headers_helper` and `tool_timeout_sec = 135`. Without folders it manages every non-retired Codex identity folder and every `t3-codex-*` folder in `<T3CODE_HOME>/gateway`. It includes pool folders. It skips Kimi and Z.ai folders, a folder that does not exist or holds no Codex file (`config.toml`, `auth.json`, `sessions`), and a folder with its own `ais-browser` entry in any TOML spelling. It never creates `config.toml` in a non-Codex folder, keeps the file mode, shell-quotes the helper command, and goes on with the other folders. `--check` reports only. `--remove` deletes the block. The URL comes from `AIS_GATEWAY_PROXY_URL` (env or `~/.secrets`) and is written to the user's own config, never to this repository.
- `ais browser headers` prints one JSON object on stdout and always exits 0. For an identity it holds `Authorization: Bearer <token>` (the token file in the identity's folder), `X-AIS-Session-Label` (the T3 thread title, else `<Tool> in <folder>`) and, for a pool, `X-AIS-Pool` and the active member's token. It prints `{}` when the folder maps to no identity, is a Kimi or Z.ai folder, or has no token: the endpoint then refuses the call and the session has no browser. The token goes to stdout only and is never logged.
- Claude starts the helper with the session environment (`CLAUDE_CONFIG_DIR`, `T3CODE_THREAD_ID`). Codex starts it with a bare environment (`HOME`, `PATH` and a few others, no `CODEX_HOME`, no `T3CODE_*`). The Codex config line therefore names the folder: `ais browser headers --tool=codex --config-dir=<folder>`. The helper sends no `X-AIS-Session-Id`: Claude does not reliably set `CLAUDE_CODE_SESSION_ID` for the helper, and a `claude -p` started from another session's shell would inherit that session's id and fight over its tab group. The gateway issues `Mcp-Session-Id` on `initialize`, and that id keys the session. Its label is the T3 thread title, else `<Tool> in <folder>`. `--tool=claude` reads only `CLAUDE_CONFIG_DIR`, never `CODEX_HOME`.
- The helper runs when the client connects. A pool swap during a session is not seen until the client reconnects. The token of the member that was active at connect time keeps working while that member stays an allowed pool member.
- The AIS launcher (`run-wrapper`) adds no `--mcp-config` and no `-c mcp_servers.*` argument. `MCP_TOOL_TIMEOUT` is no longer set by AIS: The plugin entry sets `timeout: 135000` (a per-server timeout, Claude Code 2.1.159 and later). Without it Claude cuts an HTTP call at 60 s, and a `wait` of 61 to 125 s would fail, because the gateway answers only when the call ends.
- A session that started before a change keeps its old servers until you resume it.

Local proxy: Claude sessions run with `HTTPS_PROXY` set to the local gateway proxy and `NODE_EXTRA_CA_CERTS`. That proxy (`src/gateway/connect-relay.ts`, `src/gateway/usage-proxy.ts`) pipes every CONNECT as plain TCP bytes. It reads TLS only for `api.anthropic.com`, `opencode.ai` and `cli-chat-proxy.grok.com` on port 443. A request to the gateway's own `/browser/mcp` passes unchanged, with its `Authorization` header, and an open tunnel has no timeout, so a 135 s call is fine. No `NO_PROXY` entry is needed.

Session end:
- The `initialize` reply always carries `Mcp-Session-Id` (the launch's session id, else a new one), so the client sends it back. `DELETE <gateway>/browser/mcp` (with `X-AIS-Session-Id` or `Mcp-Session-Id`) sends the session end notice, so the extension closes the tabs the session created.
- There is no timer that closes tabs. A tab may wait for the owner (see "When to close a tab"). The stdio shim keeps its own end notice when the agent process ends.

Deploy: the gateway image must contain this code. No new config is needed. The deploy requirements below (Mapping timeout, replicas) already cover `/browser/mcp`.

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

`upload_file` puts files on a page's file input. The agent gives `paths`: files on the machine the agent runs on, which is often not the machine that runs Chrome. The stdio `ais-browser` MCP server reads them there, with the rights the agent session already has, and sends only their content (`files`: name, MIME type from the file extension, base64 data) through the gateway. The target is a `ref` or a `coordinate`:

- A ref to the file input itself: the files are set on it directly.
- Anything else (the button or drop area that opens the file dialog, also inside an iframe): the extension clicks it with file chooser interception on (`Page.setInterceptFileChooserDialog`), so no dialog opens in the owner's window, and sets the files on the input that asked for them. Interception is on for that call only; the owner's own file dialogs open as usual. A cross-origin iframe is its own debugger target, so the first upload in a tab attaches to the tab's iframes (`Target.setAutoAttach`, iframes only) to catch a chooser opened inside one.

Gateway MCP server: it cannot read the agent's files, so `upload_file` with `paths` there answers a tool error. The error holds the command to run in the agent's shell, with the real session id: `ais browser upload --session <id> [--label <name>] --tab <tabId> (--ref <ref> | --coordinate <x,y>) [--browser <name>] <paths...>`. The command reads the files locally with the same limits, finds the token as a launch does (the identity of `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, a pool's active member, or `--identity` and `--pool`), and posts one `upload_file` call with the content to `<gateway>/browser/call`. `upload_file` with `files` (content) works over the gateway as on the wire.

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

The relay allows up to 125 s per call (`wait`). The Codex config block sets `tool_timeout_sec = 135`. The Claude plugin entry sets `timeout: 135000`, which overrides `MCP_TOOL_TIMEOUT`. AIS no longer sets that variable.

## Limits

Each extension socket lives on the replica it connected to. Replicas publish their bindings in PostgreSQL every 5 s and on every attach, detach or pause change; a call for a browser held by another replica is forwarded to that replica's admin relay endpoint, which runs it on its local hub (and aborts it when the forwarded request is dropped). A row not refreshed for 20 s is ignored, so a dead replica's browsers disappear after at most that long. If a binding reconnects to another replica, the newer connection wins and the older socket is closed with 4409. Revoking a binding closes its socket on whichever replica holds it. The database is the authority: remote presence only lists bindings that are active in `browser_bindings`, and the relay re-checks the binding before calling the local hub, so a revocation whose NOTIFY was lost still takes effect (a failing check lets the call through). If the database or the other replica is unreachable, local browsers keep working and the remote ones return `no_browser` (presence stale) or `browser_disconnected` (replica did not answer).

In-flight calls, pairing rate limits and active-session counts are per replica and may diverge; the replica that serves a call counts its metrics.

Agent tabs live in the user's window, inside the session's tab group. Agents work entirely in the background: new tabs open inactive, and navigation, input, evaluation and screenshots go through the debugger (CDP, with focus emulation on) without ever activating a tab or focusing a window, so the owner's active tab never changes. Only a click in the side panel may switch tabs. A page in an agent tab can still open a tab itself (a `target=_blank` link or `window.open` after an agent click); Chrome treats the click as a user gesture and opens that tab in the foreground. The extension spots it through CDP `Page.windowOpen` on the agent tab, adds the new tab to the agent's session (its own group, or the granted group it came from) and makes the owner's previous tab active again. When the owner is looking at the agent tab, a link opens as usual. Each session has exactly one tab group: creation is serialised per session id, the group is persisted in `chrome.storage.session`, and a live group with the same title is re-adopted after a worker restart. If Chrome still does not render a tab (minimised window), the call fails with `tab_hidden` after 8 s.

Known limit: the headless Chromium used in CI cannot reproduce headful background-tab and minimised-window behaviour on this host, so that behaviour is verified only on a real Mac with a headful Chrome.

## Metrics

`ais_gateway_browsers_connected`, `ais_gateway_browser_sessions_active`, `ais_gateway_browser_calls_total`, `ais_gateway_browser_call_seconds` (histogram: `_bucket`, `_count`, `_sum`), `ais_gateway_browser_pairings_total`, `ais_gateway_browser_mcp_requests_total` (`method`, `outcome`).

## Side-panel chat

The side panel can run chats with an agent. The agent runs as an `AgentSession` pod. The gateway talks to it over ACP and gives it the browser tools of the tabs the user linked to the chat. The code lives in `src/gateway/chat/` (broker, store, bus, pod transport, frames, catalogue). The frame types are in `src/browser/chat-protocol.ts`, shared with the extension.

Chat is off unless `AIS_GATEWAY_CHAT_GROUP` and `AIS_GATEWAY_CHAT_MCP_URL` are set (see "Side-panel chat" in `docs/agents/gateway.md`). With chat off, every chat frame gets `chat.reject` with code `unavailable`.

A chat belongs to one browser binding. Another binding cannot read it, prompt it or take its id. The extension socket carries these frames:

| Frame | Direction | Meaning |
| --- | --- | --- |
| `chat.list` | gateway to extension | The chats of the binding. Sent after the welcome. The extension then sends `chat.resume` for each chat. |
| `chat.list` | extension to gateway | Ask for the chats of the binding, or of one window. |
| `chat.create` | extension to gateway | New chat. The gateway answers `chat.state` with state `starting`. No pod runs until the first prompt. |
| `chat.prompt`, `chat.cancel`, `chat.permission`, `chat.link`, `chat.config`, `chat.rename`, `chat.close` | extension to gateway | Commands for one chat. A command for a chat of another binding gets `chat.reject` with `bad_request`. A permission answer with an unknown request id is ignored. |
| `chat.resume` (`afterSeq`) | extension to gateway | Replay the events after `afterSeq` in order, then the current state. Live events follow. An unknown chat gets `expired`. |
| `chat.event` | gateway to extension | One feed item with its number (`seq`). The panel drops a number it has. |
| `chat.state` | gateway to extension | The state and summary of a chat. Sent when the state, name, tabs or selection change. |
| `chat.catalog` | both | The picker list: providers, identities and pools, models. A list that cannot be read gives `chat.reject` with the `reqId`. |
| `chat.reject` | gateway to extension | A refused or failed command, with a code and fixed copy. |

A frame over the size caps (65 536 characters of text, 32 tabs, 80 characters of name) or with a bad shape is dropped. The socket stays open.

Caps. A window holds at most 6 open chats (`window_cap`). The gateway holds at most `AIS_GATEWAY_CHAT_MAX` open chats (default 12). Over it, the panel gets `chat.reject` with code `limit` and the text "Too many chats are open. Close one, then try again."

Catalogue. The identities and pools come from the `agent-runtime-config` ConfigMap (`providers.<provider>.identities`). The models come from the gateway app of the identity (`identityApps[<identity>]`, else `app`), as the union over a pool or the list of a pin. An identity that is a known browser pool has kind `pool`. A model list that fails gives an empty list and the text "Models are unavailable. The agent's default will be used." Efforts are known only after the pod starts: the first `config` item of the feed lists them.

Rollouts. A chat resumes after a rollout. It does not reattach. On SIGTERM the replica refuses new prompts, ends open permission asks as cancelled, lets turns in flight finish, then ends each pod and frees each lease. The extension sockets close with code 1012 and reconnect. The next prompt, on any replica, starts a new pod and sends ACP `session/load`. If the agent cannot load the session, the feed says that the chat restarted. No timer ends a turn in flight: the pod grace period is the only limit.

Replicas. A chat has one owner replica at a time (a database lease). Events go through the database. A notice on the bus tells every replica, and the replica that holds the socket of the chat's binding sends the frame. Commands for a chat that another replica owns travel over the bus to it.

Metrics: `ais_gateway_chat_sessions_total` (`event`), `ais_gateway_chat_turns_total` (`outcome`), `ais_gateway_chat_errors_total` (`kind`), `ais_gateway_chat_pod_start_seconds` (histogram) and `ais_gateway_chats_active` (agents running on this replica).

## Release

`.github/workflows/release.yml` builds the extension (`bun run build` in `apps/chrome-extension`, `dist/` zipped with `manifest.json` at the root) and uploads `ais-browser-extension.zip` with the other assets. CI builds and tests it when the extension or `src/browser/` changes.

The tab group title and the page pill show a readable session name, never an id and never the identity. The shim picks the first of these and looks again every 30 s:

1. The T3 Code thread title, when the agent runs in T3 Code. T3 sets `T3CODE_THREAD_ID` (and `T3CODE_HOME`) in the agent process, so a shell that runs `ais browser mcp` gets it too. The shim reads the title from `<T3CODE_HOME>/userdata/statev2.sqlite` (table `orchestration_v2_projection_threads`) read-only, with one primary-key lookup (`src/browser/t3-thread-title.ts`). Any failure gives no title.
2. The Claude or Codex chat name from the transcript (`/rename` or the automatic title).
3. `AIS_SESSION_NAME`, when the launcher sets it.
4. `<Tool> in <folder>` (for example `Claude in my-app`): the tool and the last part of the working directory.

Reason (owner report, 19 Nov 2026): T3 sessions have no transcript title, so tab groups showed the short session id. The side panel shows only the sessions using the active tab, with Pause, Stop and Resume (profile-wide), and "No agent is using this tab." when there are none.

Granting a group: when the active tab sits in a tab group no agent uses, the side panel offers "Let an agent use this group" with a picker of the live sessions and a Grant button (a granted group shows the session and Revoke access). A granted session lists the group's tabs in `tabs_context` (`scope: "granted"`, plus `grantedGroups`), can act in them and open tabs inside the group with `tabs_create` `groupId`. It never renames, recolours or closes the group, and `close_tab` only closes tabs it opened. The grant is kept in `chrome.storage.session` and ends on Revoke, Stop, when the group is closed, or after 30 minutes without a call from the session.
