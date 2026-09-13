# AIS Console API (v1)

The console server is a local-only HTTP API that exposes AiProfileSwitcher's
existing engines (identity registries, limits fetchers, usage aggregation,
resume readers, auth helpers) to two frontends:

- **WebUI** (`apps/web`, Vite + React + shadcn/ui), served by the same process.
- **TUI** (`apps/tui`, Rust + ratatui), which polls this API over HTTP.

Both frontends are **live views**: they poll every endpoint on an interval.
Every GET below is safe to call repeatedly; responses are plain JSON with no
streaming/session state. Expensive endpoints (`limits`) are cached server-side.

## Server lifecycle

- Started/stopped via `ais web start|stop|status|open` (background by default).
- Binds `127.0.0.1` only. Default port: `47129` (override: `--port` / `AIS_WEB_PORT`).
- State file: `~/.ais/web/server.json` = `{ pid, port, token, startedAt }`.
  - `token`: random per-boot bearer token, for non-browser clients (the TUI
    reads it from this file).
- Client authentication (either suffices):
  - `Authorization: Bearer <token>` from `server.json`, or
  - request originates from loopback **and** its `Host` header is
    `127.0.0.1[:port]` or `localhost[:port]` (DNS-rebinding guard).
- Mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) additionally require the
  custom header `X-AIS-Console: 1`. Browsers cannot attach custom headers to
  cross-origin "simple" requests without a CORS preflight (never granted), so
  this closes CSRF for form/fetch attacks from hostile web pages.

## Conventions

- All endpoints are prefixed `/api`.
- Errors: `{ "error": string }` with a 4xx/5xx status.
- Identities are always qualified per tool registry: `(tool, identity.name)`.
  The same name may exist in several registries.
- Secrets are masked by default. Fields named like keys/tokens/cookies come
  back as `{ "masked": "sk-s…abcd" }`. Full values are only ever written, never
  read back through the API.
- Money/percent fields are numbers; timestamps are ISO 8601 strings.

### Polling intervals used by both frontends

| Endpoint | Interval |
|---|---|
| `/api/status`, `/api/processes` | 3s |
| `/api/identities`, `/api/auth` | 10s |
| `/api/sessions` | 15s |
| `/api/sessions/tree` | 30s (server caches 15s) |
| `/api/sessions/transcript` | 3s for an open chat (server caches 4s; appended lines appear within one poll interval) |
| `/api/files/*` | on demand |
| `/api/limits`, `/api/usage`, `/api/spend-guard`, `/api/herdr-bridge` | 60s (server caches 45s) |
| `/api/usage/breakdown` | 300s (server caches 60s; heavy local JSONL scan) |

## Endpoints

### Status

`GET /api/status`

```jsonc
{
  "ok": true,
  "version": "0.2.1",            // ais version
  "uptimeS": 123,
  "home": "/home/me",
  "aisHome": "/home/me/.ais",
  "tools": [                      // one entry per ToolConfig
    {
      "toolName": "claude",
      "realBinaryName": "claude",
      "registryPath": "/home/me/.claude/identities.json",
      "registryExists": true,
      "binaryPath": "/home/me/.local/bin/claude" // resolved real binary, null if not found
    }
  ]
}
```

### Live processes

`GET /api/processes`

Scans the process table for running agent CLIs and attributes each to its AIS
identity via the `AI_PROFILE_SWITCHER_SESSION` marker env var.

```jsonc
{
  "processes": [
    {
      "pid": 4242,
      "tool": "claude",          // best-effort binary basename match
      "identity": "work",        // null if not launched via a wrapper
      "cwd": "/home/me/Projects/foo",
      "startedAt": "2026-08-25T10:00:00Z",
      "command": "claude --identity=work",
      "wrapped": true,           // present only when the marker env was found
      "identityEnv": {           // per-identity config-dir env vars, when present
        "CODEX_HOME": "/home/me/.codex/identities/work"
      }
    }
  ],
  "scannedAt": "2026-08-25T12:00:00Z"
}
```

### Spend guard

`GET /api/spend-guard`

Last-known per-AWS-account enforcement state (breach killer + cache writer
status). 503 when the daemon-side scheduler is not running. Machines with no
identity-to-AWS mapping report an empty `accounts` list. `config.mode`
decides the breach response: `"warn"` (the default, also when the key or
the whole `~/.ais/config/spend-guard.json` is absent) surfaces breaches
loudly but refuses nothing and kills nobody; `"enforce"` blocks new
launches at the gate and terminates active sessions on the transition into
breach.

```jsonc
{
  "ok": true,
  "running": true,
  "config": { "intervalS": 300, "killGraceS": 10, "mode": "warn" },
  "lastCycleAt": "2026-09-10T10:00:00Z",
  "lastError": null,             // joined cycle errors of the last pass, if any
  "accounts": [
    {
      "accountId": "123456789012",
      "profile": "acme-prod",
      "region": "eu-west-2",
      "budgetName": "acme-bedrock-monthly",  // absent when degraded
      "budgetLimitUsd": 1000,
      "budgetActualUsd": 12.5,   // the budget's own AWS-side spend
      "budgetTimeUnit": "MONTHLY",
      "periodStart": "2026-09-01T00:00:00.000Z",
      "periodEnd": "2026-10-01T00:00:00.000Z",
      "localEstimateUsd": 100.5, // offline token-based estimate (primary)
      "realReportedUsd": 55.5,   // Cost Explorer; present only when fetched this cycle
      "effectiveUsd": 100.5,     // max(local, every real source that succeeded)
      "breached": false,
      "enforced": true,          // false exactly when degraded
      "degraded": false,
      "reason": "…",             // degraded reason / breach summary
      "identities": ["acme-bedrock"],
      "computedAt": "2026-09-10T10:00:00Z"
    }
  ],
  "recentKills": [               // newest last, capped at 20
    {
      "pid": 4242,
      "tool": "codex",
      "identity": "acme-bedrock",
      "accountId": "123456789012",
      "command": "codex",
      "signal": "SIGTERM",       // SIGTERM within grace, else SIGKILL
      "reason": "spend 1004.12 reached cap 1000.00 (acme-bedrock-monthly)",
      "at": "2026-09-10T10:05:00Z"
    }
  ]
}
```

### herdr metadata bridge

`GET /api/herdr-bridge`

Last-known state of the daemon-side bridge that feeds per-pane AIS limit
tokens to herdr's sidebar (`herdr pane report-metadata --token $ais_*=...`).
503 when the daemon-side scheduler is not running (`AIS_HERDR_BRIDGE=0`).
`panes` lists every herdr pane attributed to an AIS identity this cycle;
plain shell panes and unmarked sessions never appear.

```jsonc
{
  "ok": true,
  "state": "active",           // disabled | idle | pending | active
  "running": true,
  "config": { "enabled": true, "intervalS": 60, "categories": ["session", "week"], "push": true },
  "herdrVersion": "0.8.2",     // captured during the capability probe
  "pendingReason": null,       // set while pending, e.g. "report-metadata needs herdr >= 0.9.0"
  "panes": [
    {
      "paneId": "w2B:p1",
      "agent": "opencode",     // herdr's own agent label
      "agentStatus": "working",
      "focused": true,         // only on the pane herdr currently shows; omitted (not false) elsewhere
      "tool": "opencode",      // AIS attribution (marked binary / config-dir env)
      "identity": "workco",
      "title": "OC | ...",
      "session": 43,           // omitted when the provider has no such window
      "week": 100,
      "summary": "s:43% w:100%" // the $ais_limits string pushed for this pane
    }
  ],
  "lastCycleAt": "2026-09-10T10:00:00Z",
  "lastPushAt": "2026-09-10T10:00:00Z",  // null while pending/idle or push:false
  "lastError": null
}
```

States: `disabled` (config `enabled: false`), `idle` (herdr not running;
retried every cycle), `pending` (herdr lacks `pane report-metadata`; the
probe re-runs every cycle, so a herdr upgrade flips to `active` within one
interval with no config change or restart), `active` (pushes happen each
cycle with a TTL of three intervals so stale panes clear themselves). A
pane whose identity has no limits data is listed but carries no
percentages and gets no push. `push: false` in the machine config
suppresses the metadata writes only. `focused` mirrors herdr's own
pane-focus flag (threaded from `herdr pane list`) and is the consumer-side
highlight source for `aistui --overview`; at most one pane carries it.

### Identities

`GET /api/identities`

```jsonc
{
  "registries": [
    {
      "toolName": "claude",
      "path": "/home/me/.claude/identities.json",
      "identities": [
        {
          "name": "work", "label": "Work", "description": "...",
          "configDir": "/home/me/.claude/identities/work",
          "configDirExists": true,
          "colour": "#22c55e",            // only when explicitly set (normalised #rrggbb)
          "effectiveColour": "#22c55e",   // ALWAYS present: explicit or stable auto pick
          "directories": ["/home/user/Projects/acme/*"],
          "aliases": ["wk"]
        }
      ],
      "chromeProfileOverrides": [
        { "directories": ["..."], "targetIdentity": "personal", "label": "..." }
      ]
    }
  ]
}
```

Mutations (all return the updated registry entry; body is JSON):

| Route | Body |
|---|---|
| `POST /api/identities/:tool` | `{ name, label, description?, configDir, directories?, aliases?, apiKey? }` |
| `PATCH /api/identities/:tool/:name` | `{ label?, description?, configDir?, colour? }` |
| `DELETE /api/identities/:tool/:name` | – |
| `POST /api/identities/:tool/:name/directories` | `{ pattern }` |
| `DELETE /api/identities/:tool/:name/directories` | `{ pattern }` |
| `POST /api/identities/:tool/:name/aliases` | `{ alias }` |
| `DELETE /api/identities/:tool/:name/aliases` | `{ alias }` |

`apiKey` (zai/ali create only) is forwarded to the respective auth writer and
never persisted anywhere else. Registry edits persist atomically via the
existing store. Deleting an identity never touches its configDir on disk.

#### Identity colours

Every identity carries a session colour for the WebUI's tree/chat views:

- `colour`: the identity's EXPLICIT colour, `#rgb` or `#rrggbb`
  (case-insensitive; normalised to lowercase `#rrggbb` on write). Absent
  unless set. `PATCH ... { "colour": "" }` clears it; an invalid value is a
  400. CLI equivalent: `ais identities update <name> --tool=<t> --colour=#rrggbb`
  (`--colour=` clears; `ais identities show` prints the effective colour).
- `effectiveColour`: ALWAYS present, ready to render. The explicit colour
  when set, otherwise a stable auto pick: `hash(tool + ":" + name)` over a
  fixed 16-colour palette (see `src/identities/colour.ts`, the single
  source of truth so CLI, server and web always agree). Auto colours are
  pure functions of the identity key: same identity, same colour, on every
  machine, across restarts, with no stored state.

A malformed `colour` in the registry file is a load error (validated at
read time); unknown extra fields around it are still preserved.

### Limits

`GET /api/limits?tool=&identity=&maxAge=S`

Returns the exact `ToolLimitResult[]` shape the CLI's JSON mode emits
(`status: live|cached|unavailable`, `windows[]` with `usedPercent`,
`resetsAt`, `overage`). Results are cached server-side; `maxAge` (default 45,
min 5) controls staleness tolerance. Concurrent identical requests share one
upstream fetch.

```jsonc
{
  "results": [ /* ToolLimitResult[] */ ],
  "cached": true,
  "fetchedAt": "2026-08-25T12:00:00Z"
}
```

### Usage

`GET /api/usage?tool=&identity=`

Same shape as `ais usage --json` (`usageResultsForJson()` output), plus a
trailing aggregate row per provider where applicable:

```jsonc
{ "results": [ /* UsageResult[] (provider-first) */ ], "generatedAt": "..." }
```

### Usage breakdown

`GET /api/usage/breakdown?identity=&tool=&days=30`

Per-tool-call token and cost breakdown for one identity's local logs, read
in the scan worker (like `/api/usage` but heavier: raw session JSONL, so
the child ceiling is 240s; a request that outlasts it answers 504 with a
clear error and a smaller `days` scans proportionally less). `identity` and
`tool` are optional but recommended: unscoped scans walk every registry
entry.

```jsonc
{
  "results": [
    {
      "identity": "workco",
      "tool": "claude",
      "windowDays": 30,
      "generatedAt": "...",
      "filesRead": 7,
      "categories": [           // estCostUsd-desc
        {
          "kind": "tool",       // tool | mcp | edit | web | conversation
          "name": "Bash",       // mcp rows: "mcp:<server>", with server set
          "server": undefined,  // MCP server name when kind is "mcp"
          "callCount": 2649,
          "inputTokens": 0,
          "outputTokens": 2635004,
          "cacheReadTokens": 0,
          "cacheWriteTokens": 0,
          "estCostUsd": 130.64,
          "lastUsedAt": "2026-09-04T...",
          "tools": [ /* mcp only: per-tool rows inside the server */ ]
        }
      ],
      "unavailable": undefined, // set (with reason) for tools without per-call local data
      "notes": [ /* e.g. models with no list price, excluded from estCostUsd */ ]
    }
  ],
  "generatedAt": "..."
}
```

All figures are ESTIMATES under one documented attribution rule (see
`src/cli/usage/breakdown.ts`): prompt-side tokens (input, cache read,
cache write) always sit on the `conversation` row, and output tokens split
evenly across the turn's tool calls. The logs record usage per model turn,
never per call, so nothing here is real billed spend. Only claude and
codex produce rows; other tools return `unavailable` with a reason.

### Sessions

`GET /api/sessions?cwd=&tool=&identity=` (cwd defaults to the server's cwd)

Same shape as `ais resume --json`: `ToolResumeResult[]` flattened into
`{ results: [...] }`.

### Session trees

`GET /api/sessions/tree?tool=&identity=&days=30`

What-spawned-what: parent/child links between sessions and the subagent
threads/sidecar agents the tools record locally. Heavy JSONL/SQLite reads
run in the isolated scan worker; results are cached server-side (15s).
`tool` and `identity` are optional: unscoped requests scan EVERY registry
identity of EVERY tool (this is the heavy case; scope when you can).
`days` is the lookback window (default 30, minimum 1); sessions whose last
local activity is older drop out.

```jsonc
{
  "tools": [                        // one entry per (tool, identity) scanned
    {
      "tool": "claude",
      "identity": "work",
      "nodes": [
        {
          "id": "9b6f...",          // opaque handle; pass verbatim to the transcript endpoint
          "tool": "claude",
          "identity": "work",
          "title": "Fix the session tree",  // <= 72 chars, never empty
          "cwd": "/home/user/Projects/acme",  // null when the tool records none
          "startedAt": "2026-09-12T08:00:00.000Z",
          "updatedAt": "2026-09-12T09:14:00.000Z",
          "inProgress": false,      // transcript file modified within the last 60s
          "messageCount": 412,      // only when cheaply available; absent != 0
          "depth": 0                // recomputed within this response (see below)
        },
        {
          "id": "9b6f.../a8e84a5f8e0625282",  // claude subagent: "<parentSessionId>/<agentId>"
          "parentId": "9b6f...",
          "agentName": "a8e84a5f8e0625282",   // codex nickname / kimi agent dir / claude agentId
          "tool": "claude",
          "identity": "work",
          "title": "SYNTHETIC_FIXTURE subagent task",
          "cwd": "/home/user/Projects/acme",
          "startedAt": "2026-09-12T08:01:00.000Z",
          "updatedAt": "2026-09-12T08:05:00.000Z",
          "inProgress": false,
          "depth": 1
        }
      ],
      "unavailable": undefined      // set (with reason) ONLY for tools with no tree support
      ,"error": undefined           // partial read failure; other slices unaffected
    }
  ],
  "generatedAt": "2026-09-12T09:20:00.000Z",
  "days": 30
}
```

Contract notes (the WebUI codes against these):

- Node `id` forms: claude subagents are `"<parentSessionId>/<agentId>"`,
  kimi subagents are `"<sessionId>/<agentDir>"` (e.g. `session_.../agent-3`);
  every other tool (and every root) uses the tool's native session/thread
  id. Treat ids as opaque and pass them back verbatim.
- `parentId` references a node in the SAME (tool, identity) slice. A child
  whose parent fell outside the `days` window (or whose parent record
  vanished) keeps its `parentId` but renders as a ROOT: `depth` is 0 and
  no node with that id exists in this response (orphan). Cycles terminate
  at depth 0.
- `inProgress` is the 60-second file-mtime heuristic (crush:
  `sessions.updated_at`); it is best-effort by design.
- Per-tool support: claude (subagent sidecar files), codex
  (`parent_thread_id` rollout threads, incl. guardian-review threads),
  kimi (`agents/<dir>` wire files), crush-backed zai/ali
  (`sessions.parent_session_id`, provider-scoped), pi and grok are FLAT
  (the tools record no parent links; all nodes are roots); opencode
  answers `unavailable` ("no session tree reader implemented").

### Session transcript

`GET /api/sessions/transcript?tool=&identity=&id=&tail=500`

One session's normalized transcript for the chat view. All four parameters:
`tool` and `identity` select the registry identity (required; they come
from the tree), `id` is the node id from the tree (required), `tail` caps
the returned turns (default 500, hard cap 2000, minimum 1). Cached
server-side for 4s so a 2-3s poll of an in-progress chat stays cheap while
still picking up appended lines (every read streams to the file's current
end; the cache only bounds re-read cost, it never pins old content beyond
the TTL).

```jsonc
{
  "transcript": {
    "session": {
      "id": "9b6f...", "tool": "claude", "identity": "work",
      "title": "Fix the session tree",
      "cwd": "/home/user/Projects/acme",
      "startedAt": "2026-09-12T08:00:00.000Z",   // optional per tool
      "updatedAt": "2026-09-12T09:14:00.000Z"
    },
    "turns": [                        // chronological, tail-weighted (newest kept)
      { "role": "user",      "text": "SYNTHETIC_FIXTURE please run the tests", "atMs": 1788253200000 },
      { "role": "tool",      "text": "42 passing",  "toolName": "Bash",
        "argsPreview": "{\"command\":\"bun test\"}", "atMs": 1788253205000 },
      { "role": "assistant", "text": "SYNTHETIC_FIXTURE all green", "atMs": 1788253207000, "tokens": 120 }
    ],
    "totalTurns": 412,               // the WHOLE session, including tail-dropped turns
    "truncated": true,               // turns were dropped from the front (totalTurns > turns.length)
    "inProgress": false
  },
  "cached": false
}
```

Errors: `400` missing/unknown tool or parameters, `404` when the session
id does not exist (or its store vanished), `504` when the scan child
overruns its deadline.

Contract notes:

- Roles: `user`, `assistant`, `tool` (ONE tool invocation: `toolName` +
  `argsPreview` = the call, `text` = its result; an in-flight call has an
  empty `text`), `system` (rare; leading system prompts and claude's
  informational notices only).
- Normalisation rules: assistant thinking/reasoning content is NEVER a
  turn; codex's synthetic `<environment_context>` user messages are
  skipped; claude's `isMeta` entries contribute tool-result fills only;
  bookkeeping lines (titles, token counts, mode changes) are skipped.
- `text` is capped at 2000 chars and `argsPreview` at 400 per turn
  (trailing ellipsis); `atMs` (epoch ms) is present only when the tool
  records per-entry times (grok records none); `tokens` (input+output)
  only where the tool records per-message usage (claude, pi).
- Per-tool support matches the tree (claude, codex, pi, grok, kimi, zai,
  ali); opencode answers `400` with an honest "no reader" message.

### Auth

`GET /api/auth`

Per identity/tool auth health. States: `ok` (logged in), `expiring`,
`expired` (expiry in the past), `missing` (no credential file at all), and
`unknown` (credential present but freshness not verifiable). `expiresAt` is
an ISO timestamp read from the stored credential where its shape exposes one
(claude `.credentials.json`, codex `auth.json` JWTs, kimi OAuth expiry,
pi/opencode `auth.json`); ali's entry carries `lastRefreshAt`/`refreshError`
from the daemon-side refresh scheduler instead.

```jsonc
{
  "entries": [
    {
      "toolName": "kimi",
      "identity": "work",
      "kind": "oauth",             // oauth | apikey | cookie | none
      "state": "ok",               // ok | expiring | expired | missing | unknown
      "detail": "token expires in 3h (refresh happens on next live fetch)",
      "fixable": ["refresh", "login"],
      "expiresAt": "2026-09-10T12:00:00.000Z",
      "lastRefreshAt": "2026-09-10T02:00:00.000Z",  // ali only
      "refreshError": null                           // ali only
    }
  ]
}
```

Actions (all POST, JSON bodies):

| Route | Body | Effect |
|---|---|---|
| `POST /api/auth/zai-key` | `{ tool: "zai"\|"ali", identity, apiKey }` | writes crush.json provider entry |
| `POST /api/auth/ali-cookie` | `{ identity, cookie }` | writes console-cookie.txt |
| `POST /api/auth/kimi-refresh` | `{ identity }` | refreshes OAuth token if expired (live fetch path) |
| `POST /api/auth/login` | `{ tool, identity }` | starts a login; see below |
| `GET /api/auth/flows` | – | all active/recent login flows (newest active first) |
| `GET /api/auth/flows/:id` | – | one flow's current status |
| `POST /api/auth/flows/:id/submit` | `{ code }` | inject a pasted code/URL (claude's paste path) |
| `POST /api/auth/flows/:id/cancel` | `{}` | kill the login process, mark `cancelled` |

#### Login flows

`POST /api/auth/login` runs the real CLI's own login with piped stdio so it
works on a headless machine. Per tool:

- **claude** — `claude auth login` under a `script`-allocated pseudo-terminal
  (its Ink UI renders nothing without a TTY). The authorize URL is parsed
  from the output; the redirect page is remote (no localhost callback), so
  the user completes sign-in on any device and pastes the shown code (or the
  full redirect URL) back, which the daemon injects on the CLI's stdin.
- **codex / grok / kimi** — device-code flows (`codex login --device-auth`,
  `grok login --device-auth`, `kimi login`) under plain pipes: the CLI
  prints the verification URL plus a one-time code (both surfaced here) and
  polls the provider itself, so no paste is needed.
- **pi / opencode** — no daemon-managed flow (pi has no login subcommand;
  opencode's prompts are not scriptable): the response is a terminal
  handoff instead.
- **zai / ali** — no login flow by design: use the api-key / ali-cookie
  actions.

Managed response (`kind: "managed"`):

```jsonc
{
  "kind": "managed",
  "flow": {
    "flowId": "uuid",
    "toolName": "claude",
    "identity": "work",
    "status": "waiting",   // starting | waiting | callback | completed | failed | cancelled
    "mode": "pty",         // pty | pipes
    "authUrl": "https://...",
    "deviceCode": "4L6A-6ISQH",  // device flows only; not a secret
    "instruction": "...",        // shown next to the paste box
    "acceptsPaste": true,
    "error": null,
    "startedAt": "...", "updatedAt": "...", "endedAt": null
  }
}
```

Terminal-handoff response (`kind: "terminal"`): `{ kind: "terminal",
spawned: bool, command }` — best-effort spawn into a detected terminal
emulator, or the command to run by hand on headless hosts. `callback`
status means the identity's credential file appeared or changed (path +
mtime + size fingerprint only, never contents) while the CLI is still
finishing. Flows time out after 15 minutes; error text is redacted
(token-shaped runs are stripped). Poll `/api/auth/flows/:id` about every
1.5s while a flow is active.

Credential renewal (`AuthRefreshScheduler`, daemon-side; ali console cookies
today):

`GET /api/auth/refresh` returns one status row per refreshable identity:

```jsonc
{
  "results": [
    {
      "tool": "ali",
      "identity": "personal",
      "lastAttemptAt": "2026-09-10T01:38:14.927Z",
      "lastSuccessAt": "2026-09-05T10:30:56.178Z",
      "lastError": "the auth browser is not signed in to the Alibaba console",
      "consecutiveFailures": 41,   // reset to 0 by any success; the UI escalates at >= 3
      "running": false
    }
  ]
}
```

| Route | Body | Effect |
|---|---|---|
| `POST /api/auth/refresh` | `{ tool, identity }` | runs that tool's refresher now and returns the updated row; failures never throw, they land in `lastError` |

### Files

Whitelisted editable roots:

- `~/.ais` (shared skills, hooks, AGENTS.md, STANDING-DEFAULTS.md, config)
- Each existing tool container dir (`~/.claude`, `~/.codex`, `~/.grok`,
  `~/.kimi-code`, `~/.zai`, `~/.ali`, Pi dir)
- Each registered identity's configDir (covers custom locations)

Traversal guard: resolved realpath must stay inside a whitelisted root;
symlink escapes rejected; junk dirs (`node_modules`, `.git`, caches...) are
skipped in listings; text files up to 2 MB.

Path convention: `GET /api/files/roots` and `GET /api/files/tree` return
paths in `~`-display form (e.g. `~/.ais`), and clients send them back
verbatim. A leading `~` (bare or `~/...`) expands to the real home before
the containment check, so `~` paths that land outside the chosen root are
still rejected; `~name` is treated as a literal file name. Paths without
`~` are relative to the chosen root.

| Route | Notes |
|---|---|
| `GET /api/files/roots` | root list with existence + label |
| `GET /api/files/tree?root=&path=` | dir listing (files+dirs, sizes, mtimes) |
| `GET /api/files/file?root=&path=` | `{ path, content, size, mtime, binary }` |
| `PUT /api/files/file` | `{ root, path, content }` atomic write; previous bytes kept at `~/.ais/web/file-backups/<ts>-<name>` |
| `POST /api/files/backup` | runs the git-managed config backup now; returns commit summary |
