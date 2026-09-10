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
| `/api/files/*` | on demand |
| `/api/limits`, `/api/usage`, `/api/spend-guard` | 60s (server caches 45s) |

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
identity-to-AWS mapping report an empty `accounts` list.

```jsonc
{
  "ok": true,
  "running": true,
  "config": { "intervalS": 300, "killGraceS": 10 },
  "lastCycleAt": "2026-09-10T10:00:00Z",
  "lastError": null,             // joined cycle errors of the last pass, if any
  "accounts": [
    {
      "accountId": "123456789012",
      "profile": "nazare-prod",
      "region": "eu-west-2",
      "budgetName": "pcg-bedrock-monthly-1000",  // absent when degraded
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
      "identities": ["phoenix-court-group-bedrock"],
      "computedAt": "2026-09-10T10:00:00Z"
    }
  ],
  "recentKills": [               // newest last, capped at 20
    {
      "pid": 4242,
      "tool": "codex",
      "identity": "phoenix-court-group-bedrock",
      "accountId": "123456789012",
      "command": "codex",
      "signal": "SIGTERM",       // SIGTERM within grace, else SIGKILL
      "reason": "spend 1004.12 reached cap 1000.00 (pcg-bedrock-monthly-1000)",
      "at": "2026-09-10T10:05:00Z"
    }
  ]
}
```

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
          "directories": ["/home/me/Projects/acme/*"],
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
| `PATCH /api/identities/:tool/:name` | `{ label?, description?, configDir? }` |
| `DELETE /api/identities/:tool/:name` | – |
| `POST /api/identities/:tool/:name/directories` | `{ pattern }` |
| `DELETE /api/identities/:tool/:name/directories` | `{ pattern }` |
| `POST /api/identities/:tool/:name/aliases` | `{ alias }` |
| `DELETE /api/identities/:tool/:name/aliases` | `{ alias }` |

`apiKey` (zai/ali create only) is forwarded to the respective auth writer and
never persisted anywhere else. Registry edits persist atomically via the
existing store. Deleting an identity never touches its configDir on disk.

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

### Sessions

`GET /api/sessions?cwd=&tool=&identity=` (cwd defaults to the server's cwd)

Same shape as `ais resume --json`: `ToolResumeResult[]` flattened into
`{ results: [...] }`.

### Auth

`GET /api/auth`

Per identity/tool auth health:

```jsonc
{
  "entries": [
    {
      "toolName": "kimi",
      "identity": "work",
      "kind": "oauth",             // oauth | apikey | cookie | none
      "state": "ok",               // ok | expiring | expired | missing | unknown
      "detail": "token expires in 3h",
      "fixable": ["refresh", "login"]
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
| `POST /api/auth/login` | `{ tool, identity }` | spawns an interactive login in a new terminal window (best-effort); returns `{ spawned: bool, command }` |

Login spawn strategy: detect a terminal emulator (`x-terminal-emulator`,
`gnome-terminal`, `konsole`, `alacritty`, `kitty`, `wezterm`), run the real
CLI's interactive flow with the identity env applied. Never blocks the API.

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

| Route | Notes |
|---|---|
| `GET /api/files/roots` | root list with existence + label |
| `GET /api/files/tree?root=&path=` | dir listing (files+dirs, sizes, mtimes) |
| `GET /api/files/file?path=` | `{ path, content, size, mtime, binary }` |
| `PUT /api/files/file` | `{ path, content }` atomic write; previous bytes kept at `~/.ais/web/file-backups/<ts>-<name>` |
| `POST /api/files/backup` | runs the git-managed config backup now; returns commit summary |
