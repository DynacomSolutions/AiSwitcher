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

The console (`ais web`) has a Gateway page with the same list, edit (reserve,
models, daily cap; it can also clear them), rotate and revoke. Its rotate calls the CLI's own
`rotateApp`, so the Secret and `~/.secrets` on the console host are updated as
`ais gateway app rotate` does, and the new token is shown once. Existing
tokens cannot be shown: the gateway keeps only prefixes and hashes.

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
- `--reserve=N` (1 to 100, default 100) is the share of an identity's limit that apps
  may use, keeping the rest for people working in AIS directly. The default is 100:
  no app is refused before the provider itself says the account is full. Set a lower
  value only for an app that must leave headroom for others.
- `--models=id,id` restricts which models the app may request. Each entry is an
  exact model id, as the request body names it; globs and prefixes are not matched.

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
  lists the models AIS knows. A pool app gets what the pool can serve, not one
  member's plan (`src/gateway/models-union.ts`, board 13.190): the list is the union of every member
  the app may use (matched by `slug` or `id`; "list" visibility beats "hide", and
  that entry's fields come from a member that lists it; Codex entries in `priority`
  order; its own ETag), and `/models/<id>` is answered by the first member that has
  it. A member that fails is left out; if none lists, the first member's answer
  stands. Conditional headers are not sent on. A pinned app keeps the plain pass-through.
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
  refresh, no pool hold, no failover. Side and served calls have no gateway limit by default; only when
  `AIS_GATEWAY_SIDE_DAILY_LIMIT` is set are they counted per app and day and answered 429 over it. No token rows are
  written for them. Codex reset credits
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

### T3 Code account API (resets)

`ais gateway t3-proxy [--proxy=<url>] [--ca=<path>] [--check] [--remove]` makes T3 Code's own Anthropic account reads
(usage, reset credits and redeem) go through the gateway. It installs a preload at `~/.ais/t3/anthropic-proxy.cjs` and
upserts `NODE_OPTIONS=--require <preload>` (other flags kept), `AIS_T3_ANTHROPIC_PROXY` and `NODE_EXTRA_CA_CERTS` in
`~/.t3/service.env` (`T3CODE_HOME` honoured; the old file is saved to `~/.t3/backups/service.env.pre-anthropic-proxy.<epoch>`).
The preload acts only when the process is the T3 server binary and only for `api.anthropic.com`; every other host and
every other process stays direct. Never put `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` in `service.env`: T3 hands its
env to every child and the CONNECT proxy refuses all hosts but `api.anthropic.com`, so git, gh, npm and codex would
break in every thread. The command refuses to write them and fails when the file already has one; `--check` and
`ais doctor` report that and an out-of-date preload. The proxy URL comes from `--proxy`, `AIS_GATEWAY_CONNECT_PROXY_URL`
in `~/.secrets`, the environment, or the `HTTPS_PROXY` of a `~/.t3/gateway/t3-claude-*` folder. T3 must be restarted to
apply a change; the command never restarts it.

### T3 Code model lists (Kimi ACP, OpenCode)

kimi-code and OpenCode do not list the models of a custom provider: they show only what their config names. AIS keeps
those lists equal to the gateway's `GET <base>/models` (`src/identities/t3-gateway-models.ts`). It scans every folder
under `~/.t3/gateway/` (`T3CODE_HOME` honoured):

- `config.toml` (kimi-code, `KIMI_CODE_HOME`): for each `[providers.<p>]` with `type = "kimi"`, `base_url` and `api_key`,
  the `[models.<id>]` blocks of that provider become one per gateway model, in gateway order: `provider`, `model`,
  `display_name`, `max_context_size` (`context_length`) and `capabilities` (`image_in`/`video_in`/`audio_in` from the input
  modalities, `always_thinking` when `supports_thinking_type` is `only`, else `thinking` for a reasoning model,
  `dynamically_loaded_tools` from `supports_dynamic_tools`). Other keys of a block that stays, blocks of other providers,
  comments and every other table are kept. A `default_model` that names a model that is gone moves to the first gateway
  model. A file whose content already matches is not rewritten, whatever its formatting.
- `opencode.json`: for each `provider.<p>` with `options.baseURL`, `options.apiKey` and a `models` map, the map becomes the
  gateway ids; an entry that stays keeps its keys and `name` follows the gateway. `{file:...}` and `{env:...}` in the key,
  base URL and headers are resolved as OpenCode does; the request sends the provider's headers (`x-opencode-session`).

A list that cannot be read (network error, non-2xx such as an expired upstream key, empty list) leaves the file as it is.
Files keep their mode. The host profile-sync daemon (`ais __profile_sync_daemon`) runs the sync at start and every
10 minutes in the background, logging changes and each new failure once, so a new gateway model needs no command.
`ais gateway t3-models` runs it now; `--check` writes nothing and fails when a list is out of date or unreadable. T3 Code
0.1.7 reads an ACP picker from the live config of the instance's latest session, so a new model shows after a new session
of that instance starts.

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

## Credential store and replicas

The gateway can keep every login in PostgreSQL instead of host files, so it runs on any node and as several replicas
(`src/gateway/home-store.ts`, `home-mirror.ts`, `home-import.ts`, `pg-leader.ts`, `browser/cluster.ts`). PostgreSQL is
the source of truth.

What is stored: an encrypted copy of exactly the files the file-based model uses, keyed by their HOME-relative path
(table `gateway_home_files`): the identity registries, each account's credential files (member store copies with their
`.claude.json`, identity-folder logins, swap pool copies, pi and kimi copies, zai/ali `crush.json`, opencode
`auth.json`), revoked markers, the ownership heartbeat and the host home the registries were written on. Every replica
writes the rows into its own HOME and follows changes (LISTEN `ais_gateway_files`, plus a 5 s poll), so the refresh, the
guard and the credential cache work unchanged. Registry paths are translated with `AIS_HOST_HOME`, taken from the
imported metadata when the deployment does not set it. Opencode's SQLite database is not copied: when only it holds the
key, the import writes the key to `data/opencode/ais-gateway-key.json` for the replicas (never onto the host).

Encryption: AES-256-GCM, key in `AIS_GATEWAY_STORE_KEY` (32 random bytes, base64 or hex; `openssl rand -base64 32`), the
path as associated data. Losing the key loses the logins (re-run the import from the host files); rotating it means a
fresh import into an emptied table.

Refresh: under the account's advisory lock the guard first pulls the account's rows into HOME (adopt-first and the
journal see the store's copy), refreshes, and pushes the changed files back (compare-and-swap on the version it pulled)
before the lock is released. If the lock cannot be taken (database error) the refresh is refused and retried later: a file
lock is local to one pod, so refreshing without the shared lock could send one single-use token twice. A push that fails is
retried (also pushing every changed tracked file of the account), then raises the alert `credential-store-write-failed`
(cleared by the next good push) and is left to the background pass; `stop()` makes a final bounded push of anything still
unpushed, and the keep-alive stops starting refreshes once the gateway drains. The journal already refuses the spent token
anywhere else. A row that does not decrypt is skipped with a warning naming only its path. Everything for one account in one process runs under an in-process mutex, so a background
pull never lands between a refresh's write and its push.

Sync rule per file (base = the version and hash this replica last synced): local unchanged and row moved, the row is
written; local changed and row unchanged, the file is pushed; both changed (or no base yet), a login goes to the fresher
grant (later expiry, ties to the store), registries and host files keep the host's copy under a file store and take the
row otherwise. The shared pi `auth.json` (account `pi/<name>`, one entry per provider) is merged per top-level key instead:
the fresher subtree wins per key, so two replicas rotating different providers both keep their entry; a push that cannot
settle throws. Every pass lists all row metadata (versions can commit out of order). Deleted files are not propagated.

Environment (`ais gateway serve`):

- `AIS_GATEWAY_CREDENTIAL_STORE=pg` turns it on; default `files` is the old behaviour.
- `AIS_GATEWAY_STORE_KEY` (required with `pg`).
- `AIS_GATEWAY_FILE_STORE=1` only on a replica whose HOME is the host's real files (hostPath): refreshed grants are written
  back to the files and host changes (a new login) are imported (every 5 s for tracked files, every 5 minutes for new
  ones). Without it HOME must be a writable pod-local directory (emptyDir) and is overwritten from the store. No replica
  needs it any more: the host runs the same mirror itself (Host files, below).
- `AIS_GATEWAY_STORE_IMPORT=1` with a file store: run the import at startup.
- `AIS_GATEWAY_REPLICA_URL` (default `http://$POD_IP:<admin port>`): this replica's admin address for the browser relay.

Import: `ais gateway store import [--dry-run]` on the host that holds the files (needs `AIS_GATEWAY_DATABASE_URL` and
`AIS_GATEWAY_STORE_KEY`). Idempotent: a missing path is added; registries, host files and markers take the host copy; a
login is replaced only by a strictly fresher grant, under the account's refresh lock, and never by a refresh token the
journal shows rotated out; the heartbeat is only seeded. The host sync below re-runs it every 5 minutes.

Host files (`src/gateway/host-sync.ts`, `ais gateway store sync`): the replicas have no hostPath, so the host that holds the
real login files keeps them in step itself. It runs the file-store mirror (HomeMirror with `fileStore`, the rule above)
against the host HOME, plus the import every 5 minutes for new files: a gateway refresh is written into the host file (so
grok, kimi, pi, zai, opencode and anything else reading its own files never holds a refresh token the gateway rotated), and
a host file that changed (a new login, a host tool's own refresh) is pushed when its grant is fresher. Newest token wins
both ways; a login never replaces a fresher one, and the import never uploads a token the journal shows rotated out.
Freshness is the grant's expiry (`grantFreshness`); a refresh token's own expiry (`refreshTokenExpiresAt`,
`refresh_token_expires_*`) is ignored, because Claude Code keeps it when it blanks a login after a failed refresh, and
counting it made a blanked file look fresher than the live grant.

- Runs as a child of the host profile-sync daemon (`src/sync/store-sync-supervisor.ts`), no unit of its own, only when
  `AIS_GATEWAY_STORE_DATABASE_URL` is set (environment or `~/.secrets`); the key is `AIS_GATEWAY_STORE_KEY` or a file named
  by `AIS_GATEWAY_STORE_KEY_FILE`. The same variable makes the console stand down, so one setting covers both. Restarted
  with a backoff (10 s to 5 minutes); it exits when the daemon goes. One per host (lock `~/.ais/state/gateway-store-sync.lock`).
- `ais gateway store setup --key-file=<path>` reads the database URL from stdin (never argv), proves the database answers
  and the key decrypts a row, writes both into `~/.secrets` (backup first, mode 0600) and restarts the daemon.
  The URL must reach the database from the host: the pooler's service address, not an in-cluster DNS name the host
  cannot resolve.
- `ais gateway store sync --once`: one pass, prints counts only (written, pushed, import added/updated/kept).
- Logs name paths and error class names only, never a token.

Replicas:

- Leader: a session advisory lock (`ais-gateway-leader`). Only the leader runs the idle keep-alive and writes the
  heartbeat (pushed to the store, so a file-store replica writes it back for the host). Every replica serves and refreshes
  on demand (401, expiry) through the guard.
- ali console-session renewal does not run on the credential store (its browser profile is on the host); the heartbeat
  never names ali, so the host timer and the console keep renewing it.
- In-memory state that is per replica and safe to diverge: exhausted and short holds (each replica learns a 429 or a
  credential failure from the upstream itself, at the cost of one extra failed attempt per replica), the side-count
  fallback while the database is down, the 401 refresh cooldown, pairing rate limits and active-session counts. Shared:
  apps, tokens, usage, side counts, the refresh lock and journal, the logins, browser presence.
- Browser relay: see `docs/agents/browser.md` (sockets stay on their replica; calls are forwarded).

Health: `/healthz` is liveness (always `ok` while the process serves). `/readyz` is readiness: 503 while warming (with the
store: until the first full pull finished), draining, or when the database has not answered a ping (every 5 s, 2 s
timeout) for 15 s.

The console stands down for every store-owned login (`docs/agents/console-web.md`, `AIS_GATEWAY_STORE_DATABASE_URL`).

## Member store and routing every identity through the gateway

The gateway used to read each account's login from the same identity folders the local tools use (the registry's
`configDir`, mounted into the pod). Replacing those files with a gateway entry would therefore have destroyed the
gateway's logins. The gateway now has its own member store, `~/.ais/gateway-members/<tool>/<identity>/`
(`AIS_GATEWAY_MEMBERS_DIR` overrides; claude: `.credentials.json` plus the `oauthAccount` record of `.claude.json`;
codex: `auth.json`). It lives under `~/.ais`, which the gateway pod already mounts read-write, so no new mount is needed,
and the host snapshot export skips it. `bun run backup` (and the pre-install backup) commits it as the `gateway` group,
since once identities are routed it holds the only live logins. A store copy counts only when its login file parses and
holds a refresh token: an empty or partial file left by a crash is ignored.

- `ais gateway serve` and `ais gateway local` (`enableMemberStore()` in `src/identities/gateway-members.ts`) resolve any
  identity whose store holds its login file to the store folder, at the one I/O boundary (`loadIdentitiesFile`). Identities
  without a store copy behave as before, so grok, kimi and pi (no local route yet) are unchanged. `saveIdentitiesFile`
  refuses to write store paths into a registry. The heartbeat carries `memberStore: true` so the host can tell which build
  is running.
- Every other process (host timers, CLI, console pod) treats an account with a store copy as the gateway's
  (`isGatewayManagedHere`), heartbeat or not: it never refreshes, heals or reconciles that login. For claude, such an account
  is gateway-managed even when it is not a member of a gateway-routed pool. Usage readers skip a folder that holds the
  gateway app token, so it never reaches Anthropic.

`ais identities route-all-via-gateway [--dry-run]` (host CLI only, never inside a gateway process) does the switch. Per
identity, under the account's refresh locks (the ones the gateway takes before it renews the login):

1. it refuses unless a fresh heartbeat from a gateway built with the member store names the account with a successful
   renewal;
2. it refuses while any session uses the folder: a running `claude` or `codex` process (this user's, found in `/proc`)
   whose `CLAUDE_CONFIG_DIR` / `CODEX_HOME` is the folder (or, without the variable, the tool's default folder). A session
   started before the switch keeps the old login in memory and later refreshes it with the single-use refresh token the
   gateway now renews; the gateway's copy then fails `refresh_token_reused` and the account is lost. Codex also writes that
   login back over the gateway entry. The report lists the pids; end those sessions, then run the command again. There is
   no override. Checked again under the locks, right before anything is written, and once more after the switch (pids
   found then are reported as a warning and the exit code is 1). Detection: argv[0], the executable or a node launcher's
   argv[1] named after the tool or its package entry (`node …/@anthropic-ai/claude-code/cli.js`, or the Agent SDK's bundled
   `node …/@anthropic-ai/claude-agent-sdk/cli.js`); folders compared after
   resolving symlinks; a process without the variable uses the default folder in its own `HOME`. A console-pod session
   carrying `AIS_HOST_HOME` has its container paths (under its `HOME`, e.g. `/home/ais`) mapped back to the host home; a
   pod session without `AIS_HOST_HOME`, or running as another uid, is not seen. When the scan cannot run (no `/proc`, as on
   macOS, an unreadable `/proc`, or one that hides this very process, as with `hidepid`) the identity is refused.

   It also refuses while another copy of the login would keep refreshing it:
   - a swap pool folder of the same tool that is not gateway-routed and whose active member is this identity, or whose
     login has the same refresh token or account. Every session started with the pool uses that copy. Pools are routed
     first in the same run (see "Swap pools" below), so this only refuses when the pool itself was refused (a running
     session in it, a symlink, the gateway holding none of its members): fix that, or swap the pool to another member
     (`ais swap <tool> to <member> --pool=<pool>`), then run again. A routed pool folder holds no login and never counts;
   - pi keeps its own copy of each identity's claude (`anthropic`) and codex (`openai-codex`) login in the same-named pi
     identity's `auth.json` (`oauth-reconcile.ts`), and once the store copy exists the reconcile no longer converges them.
     pi has no local gateway route, so that entry is removed (under pi's `auth.json.lock`, after a unique
     `auth.json.pre-gateway.<timestamp>.bak`; every other provider is kept) when it is the same refresh token or provably
     older (claude: `expires`; codex: the token's `iat` against `last_refresh`). pi then has no login for that provider for
     the identity until pi gets a gateway route. Refused instead: a pi copy that may be fresher (run
     `ais auth sync --tool=pi` first), a pi swap pool or a differently named pi identity holding the same refresh token,
     and any running pi session. Any pi session at all, whatever its folder, refuses the routing of every identity with a
     pi copy: one pi instance reads every pi identity's `auth.json`, so stop all pi sessions first;
3. pi's copy is removed first (a failure there leaves everything else as it was), then it moves the login into the member store. A store copy already there is the gateway's live login: it is replaced only
   by a login of the same account (claude: the `.claude.json` account uuid; codex: the token's account id) that is
   provably fresher (claude: later `expiresAt`; codex: later `last_refresh`), after a unique backup. A folder holding a
   different account is refused; an older, equally fresh or undatable local login (a restored or touched folder) leaves the
   store copy as it is. The store files are written durably (temp file flushed, renamed, folder flushed) and read back, and
   nothing local changes unless the store then holds a usable login. The login file is written last: its presence is what
   switches the gateway to the store. Any failure from the store write on (a read-back mismatch, `EACCES` on the folder)
   rolls back, so the login keeps exactly one holder: the folder gets its login back and the store copy this run wrote is
   renamed to `<file>.rolled-back.<timestamp>.bak`, so the gateway reads the folder again. If the folder cannot be
   restored, the store copy stays active and is then the only holder (the folder's login is in its `.pre-gateway` backup);
4. it backs up each local file it changes to `<file>.pre-gateway.<timestamp>.bak` (exclusive, 0600, flushed and read back,
   never overwritten or deleted) and writes the entry: claude `.credentials.json` gateway entry, `ANTHROPIC_BASE_URL=http://127.0.0.1:47140/claude`
   in `settings.json`, `apiKeyHelper` removed; codex `auth.json` as an API-key file holding the app key, `model_provider =
   "ais-gateway"` and its tables in `config.toml`, with the key printed by `~/.local/bin/ais-codex-gateway-key` (created if
   absent, an existing one is kept).

Keys are `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN` and `AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN` (apps `agents-claude`,
`agents-codex`). Reported and left alone, exit code 1: a tool with no local route (`src/gateway/local-routes.ts`: today
grok, kimi, pi) or no key, an account the gateway does not hold, a folder with running sessions, a folder whose login is
a different account than its store copy, a folder without a refreshable login, a swap pool folder the gateway holds none
of the members of, and a symlinked file.

Re-running changes nothing in an identity already routed, but checks its other holders again: a swap pool holding the
login or a pi copy that may be fresher is reported (status `already-routed`, exit code 1), and pi's same-named copy is
removed as on a first run. An entry written before the routing record existed (see below) gets the record on a re-run.
To undo one identity, see "Undoing the routing" below.

### Swap pools with routed members

A gateway-routed pool folder holds the gateway entry, never a member's login (claude: `.credentials.json` entry and
`ANTHROPIC_BASE_URL` at the gateway; codex: the API-key `auth.json` with the app key, or the `ais gateway codex-home`
placeholder login, plus `model_provider = "ais-gateway"`). Detection: `src/identities/pool/gateway-pool.ts`
(`isGatewayRoutedPool`; codex: the entry in `auth.json` or the gateway provider in `config.toml`).

How the gateway picks a member: per request, `src/gateway/select.ts` `pickIdentity` takes the member with the lowest
utilisation below the app's reserve (unknown usage after known headroom); the local proxy's direct fallback path
(`defaultLocalMembers` in `src/gateway/local.ts`) tries the pool's `swapPool.active` first. There is no pinned member for
pool apps (a pin is rejected, task 4.119). So for a routed pool:

- `ais swap <tool> to|next` (manual, auto, launch, hook) records the active member (registry and ledger) and copies no
  login: the note says the gateway picks the member. The pool's gateway entry stays; a real login found there (a `/login`
  or `codex login` inside the pool, an older build's copy) is backed up (0600 `.pre-swap` / `.pre-heal`) and replaced, and
  is never written back to a member (the gateway holds the members' logins). No app token in the secrets file is an error,
  never a fall back to a member login. Codex sessions of a routed pool need no relaunch after a swap.
- Pool heal (scheduler tick and launch check) keeps the entry in place and never restores the active member's login over
  it. Before this, the codex heal treated the entry as a damaged pool file and restored the active member's vault into it,
  and the launch check, not counting the entry as credentials, bootstrapped a member copy in: that is how a member login
  reappeared in a routed codex pool about a second after the entry was written.
- A plain (unrouted) pool refuses to swap to a routed member (one with a member store copy, or whose folder holds the
  entry) with the way out (route the pool), instead of copying the entry or the store login.
- Codex pool creation accepts members whose login the gateway holds.
- The pool keeps the refresh write-through away: a member's refresh never writes into a routed pool folder (claude and
  codex, `poolStoreDirsFor`).
- AIS sync and the live inbox never put an arriving login over a routed pool's entry (`kept-pool-entry`, logged); other
  pool files merge as before (`src/sync/gateway-guard.ts`).
- Usage: `ais swap status`, `ais limits`, the console and the gateway's own pool choice read a routed member's usage from
  its member store copy: claude with the store's access token (never refreshed here; an expired copy is reported), codex
  with one GET of `chatgpt.com/backend-api/wham/usage` with the store's access token (no `codex app-server` against the
  store, which could refresh and spend the gateway's refresh token). `ais swap status` marks the pool as routed
  (`gatewayRouted: true` in `--json`); `*` is the recorded active member.

`ais identities route-all-via-gateway` routes pool folders before their members, with the same checks as a member: no
running session in the pool folder, no symlinked file, and the gateway must hold at least one of the pool's members. A
login found in the pool folder is a copy of a member's login (sessions in the pool refresh it): under the pool lock and the
refresh locks (pool folder first, then the owner's folder and store copy, the order swap and refresh use), it goes back to
the member it belongs to (same refresh token, else same account; the active member first) when it is provably fresher
than that member's copy (the member store copy when the gateway holds the member, else its folder), after a unique backup.
Then the pool's files are backed up (`.pre-gateway`) and get the entry, as a member's do. A pool login that matches no
member is only kept in that backup. Members routed in the same run are no longer held by the pool; a member whose pool
stayed unrouted is reported with a warning that the pool cannot swap to it.

### Hosts that AIS sync connects

AIS sync copies every identity folder between hosts, logins included (newest wins). The member store is never synced, so
on the other host (say hq1) the identity is not in a member store, and its own copy of the login kept refreshing: the
gateway's copy then failed `refresh_token_reused`, and hq1's newer file synced back over the gateway entry. The receiving
side of every sync merge and of the live inbox now applies these rules (`src/sync/gateway-guard.ts`) to the claude
`.credentials.json` and codex `auth.json` of every plain identity, under the identity's refresh lock.

The gateway entry carries a routing record (key `aisGatewayRouting`, nothing secret in it): the routing host's name, the
time, the first 16 hex digits of the sha256 of each routed refresh token (the folder's and the member store's), the
freshness of the routed login (claude `expiresAt`, codex `last_refresh`) and its account. With it the receiving host tells
its own copy of the routed login from a sign-in made there after the routing (a new refresh token family the gateway never
held, harmless to it):

- a host that holds a member store copy of the identity never replaces its folder file, whatever arrives;
- an arriving gateway entry replaces a real login only when that login is the routed one: a routed refresh token, or not
  fresher than the routed login and not a different account. The replaced file is backed up first to
  `~/.ais/gateway-replaced/<tool>-<identity>-<file>.<timestamp>.bak` (exclusive, 0600; `~/.ais` is not synced, so the
  login does not travel on), and the sync (or inbox) log names the identity;
- an arriving entry never replaces a sign-in made after the routing (fresher than the routed login, or another account):
  the log says it was kept, at each sync. A login that cannot be told apart (an entry without the routing record, written
  by an earlier build of this command, or an undatable login) is kept too and logged; re-run the command on the routing
  host to add the record;
- the routing host keeps its own login whatever entry arrives once it has no member store copy (it was un-routed);
- a gateway entry is replaced by a real login only when that login is provably a separate one (fresher than the routed
  login, or another account): a host that has not seen the routing yet cannot undo it with its old copy, but a fresh
  sign-in, or the login restored on the routing host when un-routing, spreads like any login (newest wins after that).

**Routed identities stop working on the other synced hosts.** After the next sync hq1's folder holds the gateway entry,
pointing at `127.0.0.1:47140`, and hq1's gateway has no copy of the login (the member store is per host), so sessions there
fail, without refreshing anything. On hq1 `isGatewayManagedHere` treats an identity whose folder holds the pure gateway
entry as the gateway's, so `ais serve` auth-refresh, `ais auth refresh` and the pi reconcile never refresh or reconcile it
there. To use the identity on hq1 again, sign in again there (`/login`, `codex login`): that is a new login, the next sync
keeps it, hq1 refreshes it as usual (its folder holds a real login, so it is not gateway-managed), and the routing host
keeps its gateway entry (it holds the member store copy). The command's report says this for every routed identity when the
sync config names remotes.
- pi's same-named copy (`anthropic` / `openai-codex`) of a routed login is dropped from an arriving pi `auth.json`, and after
  each merge removed from the live file (unique `.pre-gateway` backup first, under pi's `auth.json.lock`).

Every synced host must run a build with these rules: a remote with an older build still merges by time on its side.

What sync cannot do is stop a session on hq1 that is already running: it keeps the old login in memory and refreshes it at
its next refresh, which kills the gateway's copy. The command cannot see those sessions, so it does not refuse, but its
report (dry run too) warns and names the sync remotes: stop every Claude Code, Codex and pi session of the identities being
routed on those hosts before running it.

### Undoing the routing

Restore on the routing host only, and let sync carry the login; never put a `.pre-gateway` or `gateway-replaced` login
backup back on any host (its refresh token may be rotated away already, and a restored copy beside the live one is a
second holder of one token):

1. on every other synced host, stop the identity's sessions (they hold only the gateway entry);
2. on the routing host, stop the identity's sessions, copy (`cp`, so the file gets a new time and wins the sync) the member store's login file
   (`~/.ais/gateway-members/<tool>/<identity>/`) back into the identity folder (the gateway has kept it current), restore the
   `settings.json` or `config.toml` backup the same way, then move the store folder aside so the gateway reads the identity folder again.
   From then on this host keeps that login whatever gateway entry arrives;
3. let sync run. The restored login replaces the other hosts' gateway entry when it is fresher than the routed login (the
   gateway renewed it since the routing). If it is not (un-routed before the gateway's first renewal), sync keeps the
   entry there: on that host move the identity's gateway entry file aside (`.credentials.json` / `auth.json`; it holds no
   login) and sync again, or sign in again there.

### Portal login status and sign-in for a routed identity

The Identities tab (`src/server/auth.ts`, `probeViaGateway`) probes the member-store login of an identity whose folder holds
the gateway entry, not the folder (which has no expiry): the detail reads "via gateway member store: ...". A routed folder with
no store copy on this host is "unknown" with a detail, never "ok". When the gateway's refresh gets a dead-grant answer
(`invalid_grant`, `refresh_token_*`, `token_revoked`) it writes `login-revoked.json` next to the store copy
(`src/identities/gateway-revoked.ts`: code, time, refresh-token fingerprint, no secret); the tab then shows "refresh token
revoked: re-login required". The marker names the refresh token it was written for, so a new login in the store ends it at once.

A portal sign-in writes the new login over the gateway entry in the folder. When the gateway holds the account (a store copy
exists), `LoginFlowManager` then runs route-all for that one identity (`adoptLoginIntoGateway`): same account, provably fresher
than the store copy, no running session, no other holder. The new login moves to the store, the folder gets the gateway entry
back, the marker is cleared. Whatever route-all refuses is returned as the flow's `note`.
