# Provider-first limits and usage; OAuth reconcile and refresh

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 2853-3056). Read before touching this area._

### Provider-first views for limits and usage

Both `ais limits` and `ais usage` group results by PROVIDER + identity.
The wrapper/tool is collection provenance, retained in internal records,
logs and source diagnostics, never as a reporting dimension.

What the rule means in practice, now enforced in both pipelines:

- **`ToolLimitResult.provider` is the report's grouping key.** The six 1:1
  tools stamp it from `providerForTool` in one place (`singleToolFetcher` in
  limits/collect.ts); their fetchers return the narrower
  `FetchedLimitResult` (no provider field), which makes it a compile error
  to construct a provider-less result anywhere else. The multi-provider
  clients' adapters (`pi-limits.ts`, `opencode-limits.ts`) stamp each
  result's provider themselves — only they know which upstream each answer
  came from. `formatLimitsReport` renders one section per provider
  (Anthropic, OpenAI, xAI, Kimi, Z.ai, Alibaba, OpenCode Go, ...), never a
  tool name.
- **The same provider+identity reached through two wrappers merges into one
  row** (`aggregateLimitResults`, the counterpart of usage/run.ts's
  `aggregateUsageResults`). This is the common case, not the edge case: pi's
  auth.json was IMPORTED from the native tools (identities/pi-auth.ts), so
  its Z.ai key IS the zai tool's key. Windows come from the best-ranked
  result (live > cached > unavailable; the flat target order puts native
  tools first so ties resolve deterministically); a live answer discards the
  duplicate source's error text, two failures merge their reasons, and a
  resolved result always supersedes a pending placeholder.
- **Native-covered providers are skipped, not duplicated.** Pi's
  anthropic/openai-codex/xai/alibaba-plan entries and OpenCode's
  alibaba_token_plan entry contribute nothing: the native claude/codex/
  grok/ali fetchers already answer for the same account through their own
  authenticated paths (Claude/Codex/Grok limit reads go through the native
  CLI itself; the Alibaba Token plan has no API-key quota endpoint at all),
  and a pi/opencode row would either duplicate the branch or add an
  unactionable "can't fetch" line. Fetchable from pi today: `zai` (static
  key, same quota endpoint as zai-limits), `kimi-coding` (OAuth via
  `fetchKimiUsageForCredentials`), and `opencode-go` (same Go-plan quota
  endpoint as opencode-limits). Fetchable from opencode today:
  `zai_coding_plan` and `opencode-go`.
  **OpenCode Go's quota endpoint** (`GET
  https://opencode.ai/zen/go/v1/usage`, Bearer the Go API key) uses the
  `/zen/go/v1` base path; `/zen/v1` does not serve Go quota requests.
  The endpoint returns the plan's three
  DOLLAR-denominated windows ($12/5h rolling, $30 weekly, $60 monthly) as
  `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}` — percent is
  share-of-window-budget, `status: "rate-limited"` marks an exhausted
  window. Its real token usage also appears in `ais usage` (see
  usage/opencode-usage.ts).
  **OpenCode identity usage also reads its db directly**: tokscale's
  opencode client collapses multi-plan models into comma-joined
  pseudo-providers ("opencode_go, zai_coding_plan") and underscore
  spellings, fragmenting the report. Identity dbs are read with the same
  exact per-message providerID attribution as the default profile, and
  canonicalUsageProvider splits comma-joined provider strings so any
  residual joined form still collapses to one stable key. The db scan
  yields every ~500 rows — bun:sqlite is synchronous, and an unyielding
  scan of a large db can block the live render.
  **Default-profile usage is attributed by CREDENTIAL MATCH, not scope**
  because an unscoped profile can use a registered identity's account.
  The profile's auth.json keys are
  matched against every opencode/pi identity's keys; usage logs under the
  identity holding the same credential. The synthetic "default" identity
  is the fallback ONLY for providers no identity can claim.
- **ONE credential per (identity, provider) (kimi-store.ts, oauth-reconcile.ts).**
  Every OAuth provider pi imports (kimi, anthropic, openai-codex, xai)
  rotates its refresh token, and each account's grant lives in TWO stores:
  the native CLI's own file (kimi `credentials/kimi-code.json`; claude
  `.credentials.json` `claudeAiOauth`; codex `auth.json` `tokens`; grok
  `auth.json` account entries) and the same-named pi identity's imported
  `auth.json` entry. Left independent, whichever store refreshes first
  rotates the grant out from under the other copy, whose next refresh then
  fails (or, with provider-side reuse detection, revokes the grant
  everywhere: the 2026-09-12 forced re-login incident found 8 of 9 paired
  accounts diverged, pi's copies 10-24 days staler). The stores are views
  of ONE logical token, enforced at the two boundaries AIS owns:
  - READ/WRITE-THROUGH (kimi's own API path, `limits/kimi-store.ts`): reads
    take the FRESHEST copy (freshest-wins self-heals), and every refresh is
    written through to ALL of the account's stores in each store's own
    shape (pi's `expires` is milliseconds, kimi's `expires_at` seconds).
    pi's kimi-coding entry is a live projection, not a fork.
  - RECONCILE (all four providers, `identities/oauth-reconcile.ts`): pi's
    internal refreshes cannot be hooked, so convergence is enforced at
    AIS's boundaries instead. Every `ais pi` launch, `ais auth sync
    --tool=pi` and `ais auth import --tool=pi` compares both copies per
    provider, adopts the FRESHEST (JWT `iat` for codex/xai, numeric expiry
    for anthropic, `expires_at` for kimi; native wins ties), and rewrites
    the staler store in that store's own shape (units, field names,
    wrapping; 0600, temp+rename, one `.ais-bak` beside each rewritten
    native file). Import reconciles BEFORE overwriting so a fresher pi copy
    is adopted into the native store first and survives the import. Divergence
    is decided by refresh-token fingerprint (sha256 prefix, 8 hex; never
    the token value), and `ais doctor` reports a pi identity holding
    diverged copies as `forked` (degraded) with the fingerprints, drift and
    remediation. The sync stays ADD-ONLY for existing entries; the
    reconcile does the freshest-wins merge.
  - Residual race, stated honestly: pi may refresh between two reconciles,
    and that rotation is invisible to AIS until the next launch/sync heals
    it. In that window the native tool's copy is stale, and one refresh
    attempt from it can fail; worst case (a provider that revokes on
    reuse) that means a re-login of the account. Before this law there was
    NO healing path at all for anthropic/codex/xai: pi's copy drifted for
    weeks and every pi-side refresh replayed a long-dead token, which is
    the forced re-login the user kept hitting. Now the fork window is at
    most one pi session, and when PI is the fresher side the reconcile
    adopts pi's copy INTO the native store (observed live 2026-09-12:
    pi/personal's kimi-coding refreshed between the dry run and the write,
    and its grant was pushed back into the kimi store), so a pi-side
    refresh no longer strands the native tool.
  - Shape limits honoured by the reconcile: codex's pi-side expiry stamp
    can be synthetic (import time + 5 minutes) when an access token is not
    a JWT, so codex/xai recency prefers the JWT `iat` of the access token
    and falls back to codex's own `last_refresh`; claude's
    `refreshTokenExpiresAt` has no pi-side counterpart and is preserved
    verbatim on write-through (conservative; claude re-mints it on its next
    refresh); grok's multi-account store matches the account by refresh
    fingerprint, falling back to grok's own freshest entry.
- **Access tokens are REFRESHED proactively, not just reconciled
  (`identities/oauth-refresh.ts`).** The reconcile only arbitrates between
  existing copies; access tokens expire by design, and before this layer
  only the real CLI's own next run ever renewed the grant (an expired
  token stayed expired — the weekly "I keep logging in again" tax the
  2026-09-12 incident was about). The daemon's auth-refresh scheduler now
  carries OAuth refreshers for codex, claude, grok and kimi (ali's cookie
  harvester was already there): each exchanges the stored refresh token at
  the provider's token endpoint (endpoints/client ids read straight from
  the installed CLIs' own code; xai runs plain OIDC discovery off the
  account entry's `oidc_issuer`/`oidc_client_id`) and writes the rotated
  grant through to EVERY store of the account per the one-credential law.
  Cadence: inside the expiry window (AIS_AUTH_REFRESH_EXPIRY_HOURS, default
  24) or at least once daily; manual `ais auth refresh <identity>
  --tool=<t>` and POST /api/auth/refresh force past the cadence. Claude is
  the exception, as is grok: their short access tokens (claude
  ~8h, grok ~6h) are always inside a 24h window, which
  rotated every refresh token each 10-minute tick and logged out running
  sessions ("Login expired"). Claude and grok refresh only inside
  `SHORT_TOKEN_EXPIRY_WINDOW_HOURS` (claude 1h, grok 1h; `min`
  with the configured window) and get no daily keep-alive while their token
  is valid; codex (~10 day token) keeps 24h + keep-alive. Kimi's ~15min
  token is under 1.5 ticks, so no window avoids a refresh per tick: the
  daemon never refreshes kimi on expiry (the kimi CLI does when used) and
  runs only the daily keep-alive (no successful refresh in 24h); forced
  refreshes and the limits path (`EXPIRY_SKEW_SECONDS` 300) are unchanged.
  The claude refresh holds
  Claude Code's `.oauth_refresh.lock` for the member dir AND every swap-pool
  dir holding the grant (sorted order, `withOauthRefreshLocks`) across
  read-freshest -> POST -> write-through, re-reading the freshest copy once
  locked so a grant someone else refreshed meanwhile is skipped. A revoked
  refresh token (provider `invalid_grant`/`invalid_client`) is terminal
  and honest: the diagnosis is pinned to that grant's fingerprint, further
  endpoint calls are skipped (never a loop), and doctor/auth status render
  "re-login required" — a re-login mints a different token and refreshes
  resume automatically.
  - RECONCILE-ON-READ: the OAuth-backed limits/usage fetchers reconcile
    ONCE per fetch before reading (codex and claude via
    `reconcileNativeProviderStores`; kimi's fetcher already reads the
    freshest copy and writes refreshes through both stores natively), and
    codex retries once on the 401/token_expired family with the healed
    store. grok's limits fetcher is a log scrape (no token read), so there
    is nothing to reconcile there.
  - Doctor: an auth-failed codex probe distinguishes "token expired
    (refreshable)" (daemon refresh or the one manual command heals it)
    from "revoked - re-login required" (only a re-login fixes it).
- **No tool-shaped placeholder rows exist for the multi-provider clients.**
  Neither a pending seed (the provider isn't known until the adapter reads
  the identity's own auth store — a placeholder would render a fake
  "Detecting providers"/"OpenCode" section) nor a cached-mode row (same
  problem, persistent). Both render nothing until their real per-provider
  results land; an explicit `--tool=` still gets one honest row. 1:1 tools
  keep their pending spinners unchanged.
- **No per-target timeout in the shared usage engine.** The console work
  must allow history scans to complete despite contention between concurrent
  targets. The CLI must never truncate good data; hangs stay bounded where they
  actually occur (tokscale's own spawn timeout; limits has never had a
  cap). Multi-provider source failures (a pi/opencode reader crashing
  before attributing any provider) are flagged `sourceOnlyError`: they
  render NO provider table row — never a fabricated "Unattributed" row —
  and surface only in the trailing Errors section under their SOURCE label
  (the tool and identity), the same "per-tool in diagnostics" allowance as the
  internal logs.
- **A source with nothing to report renders no row — unless the user asked
  for that source specifically.** Both pipelines thread an `explicitTool`
  flag (`--tool=<t>`): unscoped, an empty tokscale report or a pi identity
  with no sessions contributes nothing (no "0 messages" pseudo-provider
  rows, no Unattributed error rows); with an explicit `--tool=`, the same
  condition becomes one honest "unavailable" row instead of silence. Real
  failures (tokscale crashed, unreadable session data) keep their error rows
  in unscoped reports — a blank table over a broken environment would hide
  the problem.
- **ESTIMATES and REAL spend never share a column (real-cost placement
  rule, 2026-09-10).** The usage table's EST. COST column is exclusively a
  local token-based estimate; provider-reported real spend (AWS Bedrock's
  Cost Explorer figures are the only instance today) renders SEPARATELY: a
  dimmed `└ real …` sub-row directly under its provider row, plus one
  trailing real-spend total line beneath TOTAL. A sub-row was chosen over
  an extra column because the figure exists for one provider out of many,
  and a permanently near-empty column would widen every row's table for
  nothing. A real figure that could not be fetched renders "unavailable"
  with its reason, never a fabricated zero, never in the estimate column
  (the WebUI mirrors this with a sub-line per Bedrock row and the TUI's
  REAL $ column reads the same `realCost` payload field).

Verification should cover aggregation when native and multi-provider clients
share a credential, fallback to an available result when one source fails,
and omission of empty sources unless explicitly requested.

