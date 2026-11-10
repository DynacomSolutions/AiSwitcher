# AI Gateway: giving an app AI access

_Read before wiring a cluster app to a provider, or before touching `src/cli/gateway/`._

## When to use it

Use the gateway when a cluster app needs to call a provider that AIS already holds a
subscription login for (Claude, Codex, Kimi, Grok, Z.AI, Alibaba, OpenCode Go). The
app keeps the provider's real SDK and changes only its base URL and API key. AIS
swaps in the live login and refreshes it, so one refresh in AIS fixes every app, and
every request is recorded against the app that made it. Do not copy provider
credentials into an app.

## The one command

Run it from a host that has `kubectl` access to the app's namespace. The admin
endpoint and token are read from `~/.secrets` (`AIS_GATEWAY_ADMIN_URL`,
`AIS_GATEWAY_ADMIN_TOKEN`, plus `AIS_GATEWAY_PROXY_URL`, the public proxy base). The base may carry a path prefix
(for example `https://gw.example.com/gateway`); clients append `/<app>/...` and
`/browser/...` to it unchanged. There is no built-in default: when it is unset
the CLI asks for it.

```sh
ais gateway app add billing --namespace=shop --provider=claude --pool
```

Flags use the `--flag=value` form.

`add` registers the app with the admin API, mints its token, applies Secret
`ais-gateway-<app>` into `--namespace` (keys `AIS_GATEWAY_URL`,
`AIS_GATEWAY_USERNAME`, `AIS_GATEWAY_TOKEN`) with your kube context, and stores the
token in `~/.secrets` as `AIS_GATEWAY_APP_<NAME_UPPER_SNAKE>_TOKEN` (after a
`~/.secrets.bak.<epoch>` backup, mode 0600). The token is printed once and is never
passed to `kubectl` on the command line (the manifest goes through stdin). The
Secret is created out of band, not through GitOps; mount it in the app's manifests
with `envFrom` / `secretKeyRef`.

`--url=<base>` overrides `AIS_GATEWAY_PROXY_URL` for one run.

Other commands:

```sh
ais gateway app list | show <name> | update <name> [flags] | rotate <name> | revoke <name>
ais gateway usage [--app=billing] [--provider=claude] [--days=7] [--json]
```

## Pinned or pool

- `--identity=<id>` pins the app to one AIS identity. Use it when the app needs one
  specific account.
- `--pool` lets the gateway pick among the provider's identities by headroom;
  `--identities=a,b` limits the pool to those. Prefer the pool unless there is a
  reason to pin.
- The two are mutually exclusive, and one of them is required.
- `--style=anthropic|openai` is required for `kimi` and `zai`, which offer both API
  styles. Other providers have one style and it is filled in for you.

## Caps and reserve

- `--daily-tokens=N` caps the app's tokens per day.
- `--reserve=80` (1 to 100) is the share of an identity's limit that apps may use,
  keeping the rest for people working in AIS directly.
- `--models=glob,glob` restricts which models the app may request.

The admin API owns validation; its reason is shown when a value is refused.

`update` merges your flags over the current app. It cannot clear a field (such as
`--models` or a cap), and it does not move the Secret to another namespace. To do
either, `revoke` the app and `add` it again.

## Out of capacity

When every allowed pool member is over its limit or reserve (or a pinned member is), claude and codex apps answer
in the provider's own limit shape, so the CLI shows its built-in limit message and resets:

- claude: `429` with a `rate_limit_error` body and the `anthropic-ratelimit-unified-*` headers (status `rejected`,
  reset in epoch seconds, representative claim, 5h and 7d families) plus `retry-after`.
- codex: `429` with `error.type` `usage_limit_reached`, `resets_at` and `resets_in_seconds`, plus `x-codex-primary-*`
  and `x-codex-secondary-*` headers.

The reset is the earliest member recovery time from AIS usage data (300 s when no member reports one). A real
upstream 429 from a member is passed through unchanged. Other providers keep the generic gateway error.

Claude Code in API-key mode (the gateway token via `apiKeyHelper`) retries a 429 only when `retry-after` is
60 s or less; a longer wait ends the request with `Request rejected (429)`.

## Rotate and revoke

`rotate` mints a new token and rewrites the Secret and `~/.secrets`. Earlier tokens
keep working for an overlap window (24 hours by default) so pods can restart onto
the new Secret. `revoke` is immediate and final for the app. If `kubectl` fails
during `add` or `rotate`, the token is still saved to `~/.secrets`; fix access and
run `rotate`.

## What the app sets

| Setting | Value |
| --- | --- |
| Base URL | `AIS_GATEWAY_URL` (`<proxy base>/<app>`) |
| API key | `AIS_GATEWAY_TOKEN` |

```python
# Anthropic SDK
import os, anthropic
client = anthropic.Anthropic(base_url=os.environ["AIS_GATEWAY_URL"], api_key=os.environ["AIS_GATEWAY_TOKEN"])

# OpenAI SDK
import os, openai
client = openai.OpenAI(base_url=os.environ["AIS_GATEWAY_URL"], api_key=os.environ["AIS_GATEWAY_TOKEN"])
```

The gateway changes credential headers only. It does not rewrite bodies.

## Usage recording

Chat Completions streams carry no usage unless the request sets
`stream_options={"include_usage": true}`. Without it the stream works but no usage
is recorded for it. Anthropic Messages (the final `message_delta` usage) and
Responses API (`response.usage` on completion) bodies are read as sent, with no
extra option.

## Per-provider notes

Subscription endpoints can insist on the request shape of their own CLI. The gateway
is transparent, so an app that does not meet the shape gets the provider's own error
back; meeting it is the app's job.

- **claude** (anthropic style, proven live with the Anthropic SDK): the Claude OAuth login expects Claude Code's identity
  system prompt as the first system block (`You are Claude Code, Anthropic's official
  CLI for Claude.`). Add it to the app's system prompt. The gateway adds the
  `anthropic-beta: oauth-2025-04-20` header and merges the app's own betas.
- **codex** (openai style): a ChatGPT login reaches only the Codex backend, so the
  OpenAI SDK works through the Responses API, not Chat Completions. Proven live
  with the OpenAI SDK, as app-side requirements: send `instructions`, a list-shaped
  `input` (`[{role, content}]`; a bare string gets 400 `Input must be a list`),
  `store: false` and `stream: true` (a plain request gets 400 `Stream must be set
  to true`, so there is no non-streamed call). The SDK's `responses.stream()`
  helper throws on the backend's `response.metadata` event; iterate
  `responses.create({ stream: true })` instead. Known gap: the Codex backend sends
  its SSE without a `content-type` header, so the gateway sniffs the body
  (`event:`, `data:` or `:` first means SSE) so usage is still recorded.
- **kimi** (anthropic or openai): the Kimi Coding endpoint; choose the style that
  matches your SDK.
- **grok** (openai style): Chat Completions. The endpoint answers 426 to a caller
  with no Grok CLI version; send the header `x-grok-client-version: 1.0.70` (any
  version from 1.0.13 up).
- **zai** (anthropic or openai): choose the style that matches your SDK.
- **ali** (anthropic style only): Alibaba Token Plan. UNPROVEN: the route is
  written from the Anthropic-compatible base URL and an inferred `x-api-key`
  header, and has never been run against the live endpoint (no ali identity on
  the host, board row 4.111).
- **opencode** (openai style only): OpenCode Go. Send an `x-opencode-session`
  header (any stable id per conversation); without it the endpoint answers 400
  `MissingSessionID`. `GET /models` lists the models the plan serves; `glm-5` is
  not one of them.

### Extra routes (`src/gateway/routes.ts`)

These sit beside the plain pass-through. They use the same app key, pool, failover,
ledger and metrics. The model allowlist does not apply to them (a list, search or
speech call is not a model call); the daily token cap does.

- **Model lists**, `GET /models` or `/v1/models` (and `/models/<id>` where the
  provider has it), for every provider. ali has no upstream list, so the gateway
  lists the models AIS knows.
- **kimi** `POST /search` and `POST /fetch` (also under `/v1`), sent to the Kimi
  Coding `search` and `fetch` services. UNPROVEN live.
- **codex** `POST /v1/audio/transcriptions` (or `/transcribe`), sent to ChatGPT's
  `backend-api/transcribe` with the multipart body untouched. UNPROVEN live.
- **Account API, forwarded with the member's login** (`kind: "account"`, `src/gateway/account.ts`). One rule for every
  provider: a request for an account feature (usage and limits, reset credits view and spend, profile, plugins) is sent to
  the provider with the REAL login of the member the app maps to. A pinned app uses its identity; a pool app uses the member
  that owns the resource (below), else the member the pool would route to now (lowest utilisation). The member's token is
  added by the gateway and never returned; the app token is never sent on. Decision of 10 Nov 2026 (replaces the earlier
  "never let an app read account detail" design). These calls count as side calls (no token rows, the daily side limit and
  token cap apply, the reserve does not), are logged as app, class and status only, and one 401 gets one locked refresh.
  - **claude**: every `/v1/*` path is model traffic (messages, batches, complete, sessions, ...) on the model path (allowlist where
    the body names a model, ledger row, token cap, pool hold and failover), except `/v1/models` (side) and `/v1/oauth*`
    (account). Every other path goes to `api.anthropic.com` as an account call: `/api/oauth/*`, `/api/claude_cli*`,
    `/api/organizations/*`, telemetry, settings, hello. Telemetry-style calls (`/api/event_logging`, `/api/claude_code`,
    `/api/hello`, `/api/eval`) are logged but not counted against the daily side limit. Account calls
    holds a member, fails over or forces a refresh beyond the locked account one (profile answers keep the real account and
    organisation uuids). A
    pinned app forwards `/api/oauth/usage` whole. A pool app keeps the served windows of the least-used member and, when the
    query has `cedar_ember=1`, merges that member's real `cedar_ember` block in. `POST /api/organizations/<org>/reset_rate_limits`
    reads a fresh `cedar_ember` view of each member to find the one owning `grant_id`, and is sent with that member's login
    and organisation; when the org in the path differs from the member's (from its `/api/oauth/profile`, kept 10 minutes) the
    path is rewritten to the member's, so a stale local uuid still works.
  - **codex**: `POST .../rate-limit-reset-credits/consume` goes to the member with an unspent credit (the pin for a pinned
    app). Model traffic goes through the model path (ledger, token cap, pool selection and failover): `/backend-api/codex/*`, and
    writes to `/backend-api/conversation`, `/f/conversation` and `wham/tasks*`. The bare `/backend-api` is 404. Every other
    `/backend-api/*` path and `wham/*` / `api/codex/*` (including GET task listings) go to
    `chatgpt.com/backend-api/*` with the login and `chatgpt-account-id`. Pool apps still get the served `wham/usage` (windows
    of the least-used member) and the summed `rate-limit-reset-credits`; pinned apps get the provider's real bodies.
    Codex 0.166 reads `account/rateLimits/read` from `<chatgpt_base_url>/wham/usage` when its config sets `chatgpt_base_url`
    and `auth.json` holds a placeholder ChatGPT login whose `access_token` is the app token (how T3 Code shows limits).
  - **kimi** `GET /usages` (`api.kimi.com/coding/v1/usages`), **zai** `GET /api/monitor/*` (`api.z.ai`), **opencode**
    `GET /usage` (`opencode.ai/zen/go/v1/usage`): forwarded with the member's key. **grok** and **ali** have no account
    endpoint AIS calls with the model key (ali usage needs a console cookie, not the API key): nothing is forwarded for them.
  - **Never forwarded (403)**: paths that mint a durable credential of the member, which would bypass the gateway:
    `create_api_key`, `api_keys`, `oauth_tokens`, `setup_token`, `access_token`, `oauth/token`, `oauth/authorize`
    (Claude and ChatGPT). The owner should know the app can still see account detail, but never obtains a key.
  - Classification reads the normal form of the path (repeated percent-decoding, `;params` dropped, lower-case, `//`
    collapsed); what is sent upstream is the client's spelling. A path that cannot be normalised is refused (404).
  - Organisation ids are fail-closed: for `/api/(oauth/)organizations/<org>[/...]` the org sent upstream is always the
    member's own (from its profile); if that cannot be read the answer is 502 and the client's org is never sent.
  - Account request bodies are capped at 1 MiB, read in chunks inside the body budget (413 over it).
  - An `aisg_` token in `x-api-key`, `api-key` or a Basic password is treated like the bearer by the CONNECT proxy.
  - All of this is UNPROVEN live.
- **CONNECT proxy**: every request with an `aisg_` bearer (any method and path, body included) is handed to that app's route;
  an `aisg_` token the gateway does not accept is 401 and never sent on. Other bearers are forwarded unchanged.
- **Side routes** (lists, search, fetch, speech) pass the provider's 401/402/403/429 straight to the app: no login
  refresh, no pool hold, no failover. Side and served calls are counted per app and day apart from tokens (default 5000 a
  day, `AIS_GATEWAY_SIDE_DAILY_LIMIT`; over it the answer is 429); no token rows are written for them. Codex reset credits
  are cached 60 s per app.
- Repeated slashes in any app path are collapsed before matching and before the path is sent upstream. Claude paths are
  matched after decoding, lower-casing and dropping `;params`.

### Claude limits for gateway-routed Claude Code (CONNECT proxy)

Claude Code reads its limits from a fixed host (`https://api.anthropic.com/api/oauth/usage`), never from
`ANTHROPIC_BASE_URL`, and only when its login has the `user:profile` scope. `ais gateway serve` runs a CONNECT proxy
for those clients when the deployment mounts a certificate for `api.anthropic.com` (`AIS_GATEWAY_CONNECT_TLS_DIR`,
a cert-manager secret with `tls.crt`, `tls.key`, `ca.crt`; port `AIS_GATEWAY_CONNECT_PORT`, default 47132). The
certificate and its CA are cluster-managed (.cluster); the gateway makes none. `AIS_GATEWAY_CONNECT_CA_PUBLISH` copies
`ca.crt` to a host path for clients. Without the TLS dir the proxy is off; a proxy that cannot start never stops the gateway.

A client sets `HTTPS_PROXY` to the proxy and `NODE_EXTRA_CA_CERTS` to the published CA, and adds `user:profile` to the
`scopes` of its gateway-token `.credentials.json` (the token is still the gateway app token, so the scope grants nothing
upstream). AIS's own gateway entry keeps only `user:inference`: without the proxy, that scope would send the gateway
token to the real host.

- Every CONNECT is a plain TCP tunnel except `api.anthropic.com:443`, whose TLS the proxy terminates.
- On that host, any request with an `aisg_` bearer is handed to the route of the claude app the token belongs to, which
  forwards account requests with the member's login (see "Account API" above). An `aisg_` token the gateway does not accept
  gets 401 there and is never sent on. Requests with any other bearer are forwarded unchanged.
- The proxy itself reads and sends no member login. A renewed certificate is picked up within 5 minutes.

### Claude usage proxy on a folder

`ais gateway claude-proxy <dir>...` sets `HTTPS_PROXY` (the CONNECT proxy) and `NODE_EXTRA_CA_CERTS` in a Claude folder's
settings.json, and always adds `NO_PROXY=127.0.0.1,localhost,::1`. Never set `HTTPS_PROXY` on a Claude folder by
hand: Claude Code sends every request through it, including a plain-HTTP loopback `ANTHROPIC_BASE_URL` (the
`ais gateway local` proxy), and the CONNECT proxy answers those with 405, so every model call fails (incident
10 Nov 2026, row 4.162). `--check` and `ais doctor` report a folder in that state. Run a real `claude -p` turn on each
folder after a change: running sessions read settings.json at once.

### Codex usage limits on a folder

`ais gateway codex-home <dir>...` sets up Codex folders (CODEX_HOME, for example T3 Code's) that run through the gateway
so Codex and `codex app-server` show real limits. It reads the app from the folder's
`[model_providers.ais-gateway] base_url = "<base>/<app>"`, takes the token from `AIS_GATEWAY_APP_<APP>_TOKEN` in
`~/.secrets`, then:

- writes `auth.json` (0600): a placeholder ChatGPT login whose `access_token` is the app token (the `id_token` needs a
  non-empty signature segment: codex 0.145 rejects an empty one);
- sets top-level `chatgpt_base_url = "<base>/<app>/backend-api"` in config.toml and `requires_openai_auth = true` on the
  provider, and removes `[model_providers.ais-gateway.auth]` (codex refuses provider auth combined with
  `requires_openai_auth`); every other key survives; reruns change nothing;
- registers the folder in `~/.ais/gateway-codex-homes.json`.

`app add` and `app rotate` then rewrite `auth.json` in every registered folder of that app and report the count (never the
token); a failure there is reported and never hides the minted-token message. `--check` writes nothing and reports each
folder (`ok` or the problem).

### Public host

`/metrics`, `/healthz`, `/readyz` and `/browser/pair*` answer 404 when the request names a public host (Host or
X-Forwarded-Host is in `AIS_GATEWAY_PUBLIC_HOSTS`, comma-separated; no default is compiled in, so the deployment must set it); the pod address still works for probes and
vmagent. Every `cf-*`, `x-forwarded-*` and `x-envoy-*` header, `cdn-loop`, `forwarded`, `x-real-ip`, `x-request-id`, `x-client-ip` and `true-client-ip` (Cloudflare Access JWTs and client credentials included) is removed before a
request goes to a provider. The side-route daily count lives in the gateway database (table `gateway_side_counts`); if the
database cannot answer, each replica counts in memory and an owner alert (`side-count-unavailable`) is raised.

The path is matched after repeated percent-decoding, slash collapsing and lower-casing. A path that cannot be decoded (a stray
`%` escape) cannot be shown to be harmless, so on a public host it is treated as one of the operational paths and answers 404.
Side-count database calls are limited to four at once; the rest queue for a slot within the same time limit, and only a
database error or running out of time falls back to memory and raises the alert.

### ali login ownership

The gateway renews the Alibaba console session of every live ali identity on its keep-alive timer
(`src/gateway/ali-session.ts`, `ais_gateway_keepalive_total{provider="ali"}`; failures raise an owner alert). The heartbeat
names them as `ali/<identity>`; while it is fresh, the console daemon, the host timer `ais-ali-auth-refresh-<identity>` and
`ais auth refresh --tool=ali` skip their run (the host timer stays installed, so the host resumes at once when the heartbeat stops naming the login; `--force` renews anyway). The gateway claims `ali/<identity>` only when the startup check found nothing missing and that login has been renewed successfully at least once. Renewals take a
lock on the shared Chrome tab and never navigate away from a sign-in page a person is using. On shutdown a renewal in
flight is abandoned and `stop()` waits at most 10 s for the pass.

What the gateway pod needs for this, checked once at startup (alert `ali-setup-missing` lists what is absent):
`kubectl` on the PATH; `AIS_K8S_API_SERVER` set to the in-cluster API address (no systemd in a pod); the permission
`create pods/portforward` in the chrome-auth namespace; writable `~/.ais/auth-browser` and each ali identity directory.

The live proof lives in `test/gateway-e2e/` (one script per provider using the
unmodified official SDK, configured with `AIS_GATEWAY_URL` and `AIS_GATEWAY_TOKEN`
only) and `test/gateway-e2e/run-in-cluster.sh <script>`, which runs one from a
throwaway pod outside the `dev` namespace.

## Operations notes

- Revoking an app needs the database. While the database is down, revoke
  returns 503 and the app stays active; retry once the database is back.
- The usage table becomes a TimescaleDB hypertable only on the first migration.
  If TimescaleDB is added to the database later, the table stays a plain table
  until someone converts it by hand.

## Refresh guard

The gateway alone refreshes account logins, and a provider rotates the refresh
token on every refresh, so two refreshes racing (or one replayed with a spent
token) kill the login. `src/gateway/refresh-guard.ts` wraps the one refresh
that the credential cache and the idle keep-alive both use (design after
CLIProxyAPI's refresh journal):

- One refresh per account at a time across all replicas: a PostgreSQL
  session-level advisory lock on a reserved connection
  (`src/gateway/pg-refresh-backend.ts`). A holder that dies loses its session,
  so the database frees the lock. The journal queries run on that same
  connection, and at most 8 locks are held at once (pool of 10), so the pool
  cannot deadlock. Every backend call is bounded to about 5 s
  (a client timeout, plus a best-effort `SET statement_timeout` on the reserved connection; never a startup parameter, which a connection pooler rejects).
- Adopt first: the latest stored grant is re-read under the lock. A newer
  refresh token or expiry (or an access token that no longer matches the one
  the caller saw) is used as it is; no token request and no journal row. A grant
  read error fails retryably (no alert, nothing sent).
- Journal (`gateway_refresh_journal`, indexed by account and old fingerprint):
  the claim is written by the refresher (`beforePost`) immediately before the
  token request, under its file locks, and resolved after it (retried on
  error). A pass that sends nothing journals nothing. Rows hold refresh-token
  fingerprints only, never a token. Outcomes: `refreshed`, `failed`, `lost`
  (provider rotated but no store was written), `interrupted`, `recovered`.
- Never reuse a rotated-out token: a stored token the journal shows as
  `refreshed` to a different token is refused (a restored backup or lagging
  store), and this process also remembers such tokens in memory for the times
  the journal cannot be read. An unresolved claim for the stored token (a
  crash, a network blip between claim and resolve) is closed as `interrupted`
  and the token is sent again: the provider's own dead-grant answer decides, so
  a token that never reached the provider is never stranded. From the second
  interruption in a row an owner alert (`refresh-interrupted`) is raised. A
  `lost` write (provider rotated, no store written) is sent once more too. Resolve
  retries run on a fresh pool connection, not the lock's. A claim whose token
  the stores have moved past is closed as `recovered`.
- Retention: every 6 hours resolved rows older than 30 days are deleted,
  keeping the newest 50 per account and all open claims; rotated-out evidence
  (`refreshed`, `lost`, `interrupted`) is kept for a year.
- A lock handle that arrives after the guard gave up is released, never leaked.
- Database or guard unavailable: the refresh still runs, under AIS's
  `.oauth_refresh.lock` file lock and the `expectedAccessToken`
  compare-and-swap, with a `refresh-guard-degraded` alert and
  `ais_gateway_refresh_guard_degraded_total`. A lock timeout is not alerted as a
  dead login.
- `stop()` waits for refreshes and the keep-alive in flight before closing the
  backend.
- Metrics, per `provider` and `identity`:
  `ais_gateway_refresh_attempts_total`, `ais_gateway_refresh_successes_total`
  (renewed or adopted), `ais_gateway_refresh_failures_total`,
  `ais_gateway_refresh_lock_waits_total`,
  `ais_gateway_refresh_lock_wait_seconds_total` and
  `ais_gateway_refresh_guard_degraded_total`.
