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
- **Served by the gateway itself**, so no account detail leaves it: claude
  `GET /api/oauth/usage` (the windows of the member the pool would pick) and
  `GET /api/oauth/profile` (the app name only); codex
  `GET /rate-limit-reset-credits` (also under `/api/codex` and `/wham`), which is
  the total over the pool's members, and `POST .../consume`, which is refused.
- **Side routes** (lists, search, fetch, speech) pass the provider's 401/402/403/429 straight to the app: no login
  refresh, no pool hold, no failover. Side and served calls are counted per app and day apart from tokens (default 5000 a
  day, `AIS_GATEWAY_SIDE_DAILY_LIMIT`; over it the answer is 429); no token rows are written for them. Codex reset credits
  are cached 60 s per app.
- **Refused claude paths** (403, after collapsing `//`, decoding, lower-casing and dropping `;params`), below `/api/`:
  `oauth/{profile,account,userinfo,organization(s),roles}`, `oauth/claude_cli/{roles,profile,account,organization(s)}`,
  `claude_cli_profile`, `organization(s)`, `account`, `bootstrap`, `me`. The gateway serves `oauth/usage` and
  `oauth/profile` itself. Every other `/api/*` path passes through. Repeated slashes in any app path are collapsed before
  matching and before the path is sent upstream.

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
     login has the same refresh token or account. Every session started with the pool uses that copy, and this command
     never writes pool folders: swap the pool to another member first (`ais swap <tool> to <member> --pool=<pool>`), or
     route the pool itself, then run again;
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
a different account than its store copy, a folder without a refreshable login, a swap pool folder that is not routed yet
(it holds a copy of a member's login; the command never writes pool folders) and a symlinked file.

Swap pools break for routed members: a pool swaps by copying the member's login out of the member's identity folder, and a
routed member's folder holds only the gateway entry, so a swap to it no longer gets a working login (codex fails with "no
usable Codex login") until the pool itself is routed with its own setup (a gateway-routed claude pool never copies member
logins) or the member is taken out of the pool. The
report adds this warning to every routed member of a swap pool and to every refused pool folder.
Re-running changes nothing in an identity already routed, but checks its other holders again: a swap pool holding the
login or a pi copy that may be fresher is reported (status `already-routed`, exit code 1), and pi's same-named copy is
removed as on a first run. To undo one identity: copy the member store's login file back
(the gateway has kept it current; the `.pre-gateway` login backup may hold a refresh token already rotated away), restore
the settings or config backup, then move the store folder aside so the gateway reads the identity folder again.

### Hosts that AIS sync connects

AIS sync copies every identity folder between hosts, logins included (newest wins). The member store is never synced, so
on the other host (say hq1) the identity is not in a member store, and its own copy of the login kept refreshing: the
gateway's copy then failed `refresh_token_reused`, and hq1's newer file synced back over the gateway entry. The receiving
side of every sync merge and of the live inbox now applies these rules (`src/sync/gateway-guard.ts`) to the claude
`.credentials.json` and codex `auth.json` of every plain identity, under the identity's refresh lock:

- a host that holds a member store copy of the identity never replaces its folder file, whatever arrives;
- a gateway entry is never replaced by a real login, whatever the file times say;
- an arriving gateway entry replaces a real login, whatever the file times say. So the routed state spreads: after the next
  sync hq1's folder holds the gateway entry too (pointing at `127.0.0.1:47140` on hq1: sessions there need hq1's own local
  gateway route to work, otherwise they fail without refreshing anything). On hq1 `isGatewayManagedHere` treats an
  identity whose folder holds the pure gateway entry as the gateway's, so `ais serve` auth-refresh, `ais auth refresh` and
  the pi reconcile never refresh or reconcile it there;
- pi's same-named copy (`anthropic` / `openai-codex`) of a routed login is dropped from an arriving pi `auth.json`, and after
  each merge removed from the live file (unique `.pre-gateway` backup first, under pi's `auth.json.lock`).

Every synced host must run a build with these rules: a remote with an older build still merges by time on its side.

What sync cannot do is stop a session on hq1 that is already running: it keeps the old login in memory and refreshes it at
its next refresh, which kills the gateway's copy. The command cannot see those sessions, so it does not refuse, but its
report (dry run too) warns and names the sync remotes: stop every Claude Code, Codex and pi session of the identities being
routed on those hosts before running it. To undo routing on a synced host, restore the login on every host (a gateway
entry anywhere wins the next sync).
