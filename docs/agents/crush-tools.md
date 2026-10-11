# zai and ali (Crush-backed tools)

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1919-2660). Read before touching this area._

### zai case study, take 3 (2026-07-17): Crush, a real multi-provider CLI

Same day as takes 1 and 2, later still — surfaced by the user actually
*using* a take-2 zai identity and noticing Claude Code displayed "Opus" even
though the account was GLM-backed ("Claude code says opus when the models
are GLM"), then, when told this was inherent to piggybacking on Claude
Code's own client, pushing back with "is OpenCode really our only/best
option?" — a fair challenge take 2 itself never re-litigated once take 1 was
abandoned.

- **Take 2's actual flaw, confirmed by reasoning about the integration
  shape, not observed as a bug in this project's own code**: Z.ai's Anthropic-
  compatible endpoint (what take 2 relies on) transparently remaps whatever
  model alias Claude Code sends (e.g. "opus") to a GLM model server-side —
  but Claude Code's own UI has no visibility into that remap, so it keeps
  showing its own Anthropic alias regardless of what actually answered. This
  is inherent to "reuse an existing client's protocol compatibility layer,"
  not something fixable by writing different config — the only fix is
  wrapping a client that is ACTUALLY aware it's talking to Z.ai/GLM.
- **Re-evaluated take 1's own original blocker (interactive-only opencode
  auth) instead of assuming it still held** — and it didn't: opencode's real
  auth file (`$XDG_DATA_HOME/opencode/auth.json`,
  `{"zai": {"type": "api", "key": "..."}}`) can be written directly with zero
  `opencode auth login` ever run, confirmed live (no prior investigation had
  actually tried this — take 1 accepted the interactive-only conclusion from
  reading opencode's own CLI surface, not from testing whether the
  underlying credential file itself was writable).
- **Didn't stop at re-confirming opencode — checked Z.ai's own docs for
  every terminal tool it officially supports**, not just the one already
  tried: `docs.z.ai/devpack/tool/*` lists Droid, Crush, Goose, OpenClaw, and
  OpenCode as officially documented CLI integrations (distinct from IDE
  extensions like Cline/Roo/Kilo). Ruled out: Droid needs an interactive
  Factory-account browser login even for BYOK; Goose has no dedicated Z.ai
  provider (open feature request); Aider's GLM support is
  inconsistent/community-patched, not officially documented by Z.ai at all.
- **Crush (github.com/charmbracelet/crush) chosen over OpenCode** — both
  are real, genuinely multi-provider CLIs that display the actual model
  (not a translated alias), and both can be configured non-interactively.
  Crush's edge: its own config format is a plain, Z.ai-documented JSON file
  (`crush.json`, not something reverse-engineered from a compiled binary the
  way opencode's `auth.json` shape had to be), its config isolation needs
  only 2 env vars (`CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA`) vs opencode's
  4-way XDG spread, and it's actively shipping (backed by Charm, v0.85.0
  released the day before this was written).
- **Confirmed live, not assumed from Z.ai's docs alone** (2026-07-17,
  `crush@0.85.0`): `crush dirs` reflects `CRUSH_GLOBAL_CONFIG`/
  `CRUSH_GLOBAL_DATA` overrides correctly. Writing a plain `crush.json` with
  a `"zai"` provider entry (`id`/`name`/`base_url`/`api_key`) and running NO
  `crush login` was enough for `crush run "..." --model zai/glm-4.6` to
  attempt a REAL request to Z.ai's endpoint — rejected only for an invalid
  placeholder key (`unauthorized: token expired or incorrect`), proving the
  config was actually read and used for the request. This mattered because
  `crush models` alone is NOT sufficient proof: it lists every `zai/glm-*`
  model unconditionally even with a completely empty/absent config — it's
  Crush's own static catalog, not evidence of a working, configured
  provider. Z.ai's own doc sample for Crush also omits the `models` array
  every other provider's example includes; empirically this turned out not
  to matter (the "zai" provider was already known to Crush's own catalog),
  but that was a real, flagged unknown going in, not assumed away.
- **New `ZAI_CONFIG` shape**: `realBinaryName: "crush"`, `envVarName:
  "CRUSH_GLOBAL_CONFIG"`, `extraEnvVarNames: [{ name: "CRUSH_GLOBAL_DATA",
  subdir: "data" }]` (the `subdir` form — see the 2026-07-18 addendum below
  for why a bare shared value, which is what this originally shipped as,
  turned out to be wrong). Crush's real binary name is unique among this
  project's five ToolConfigs (unlike take 2, which shared `claude` with the
  primary claude wrapper and needed a bespoke `envVarName` purely to avoid
  `open.ts`'s envVarName-based lookup colliding with `CLAUDE_CONFIG`) — one
  less moving part than take 2 had, not just a swap of one binary name for
  another.
- **Non-interactive auth is a NEW capability, not carried over from either
  prior take** — this is what actually closes take 1's original gap for
  good, independent of which tool ended up wrapped. `identities/zai-auth.ts`'s
  `writeZaiAuthFile()` does a read-modify-write into `<configDir>/crush.json`
  (preserves any other config already there — matters for rotating a key on
  an in-use identity, not just fresh creation). Wired into BOTH
  `cli/identities/create.ts`'s `--api-key=` flag (or an interactive prompt if
  omitted — optional, since a user may want to configure Crush manually
  instead) AND `identities/prompt.ts`'s own independent `createIdentityFlow`
  (the interactive-picker's "+ Create new identity" path) — confirmed no
  per-tool-extra-field concept existed anywhere in this codebase before this,
  so both call sites needed the identical addition or they'd have drifted.
  `ais identities update --tool=zai --api-key=<key>` rotates a key later
  without recreating the identity — handled as its own step in
  `cli/identities/dispatch.ts`'s "update" case, not threaded through
  `actions.updateIdentity`/`UpdateIdentityInput`, since an API key isn't
  `identities.json` metadata (kept out of the more casually viewed/backed-up
  registry file entirely).

  `--colour=` on the SAME update case IS registry metadata and therefore
  threads through `actions.updateIdentity`: `#rgb`/`#rrggbb` is normalised
  to lowercase `#rrggbb` on write, `--colour=` (empty value) clears the
  field, anything else is a usage error. See `identities/colour.ts` for
  the effective-colour rendering rule every surface shares.
- **`ais upgrade` includes zai even though Crush has no self-updater.** Its
  real binary's `--help` still has no `update`/`upgrade` command (the
  `update-providers` command is unrelated), so AIS installs/upgrades the
  documented `@charmland/crush` npm package in its managed real-CLI prefix.
  This is precisely why upgrade cannot be modelled as a flat loop over native
  updater subcommands.
- **resume/limits/usage support for zai is STILL not implemented, and the
  take-2 rationale ("zai's session files are literally claude's own format")
  no longer applies at all** — Crush's own session storage format hasn't
  been investigated in this pass. `resume/collect.ts`'s `READERS`/
  `limits/collect.ts`'s `FETCHERS` being `Partial` records still means this
  degrades to an honest "not implemented yet" instead of a crash.
  **Superseded for limits/usage by the 2026-07-18 addendum below** — Z.ai
  has its own live quota API (nothing to do with Crush's session storage at
  all), which closes both gaps; `resume` is still genuinely unimplemented,
  no live API covers it.
- **`opencode` was already uninstalled during take 2** (see take 2's own
  notes above) — Crush was installed fresh for this pass
  (`brew install charmbracelet/tap/crush`), unrelated to opencode's prior
  presence or absence.

#### zai/Crush addendum (2026-07-18): GLM-only model list, and two footguns found getting there

Take 3 shipped with zai working (real GLM responses, correct model name
display), but the very next real-world use surfaced a follow-up complaint:
the user opened Crush and saw Gemini, Grok, OpenAI, and dozens of reseller
providers alongside GLM — "It should just be GLM." Chasing that down surfaced
two confirmed, previously-undiscovered Crush behaviors, both load-bearing for
anyone touching this again:

- **The fix: `"options": {"disable_default_providers": true}` in
  `crush.json`, PLUS a fully self-contained custom "zai" provider entry.**
  Crush ships zai/GLM as a built-in provider already (its embedded Catwalk
  catalog, id `"zai"`, native `ZAI_API_KEY` env var support) — which is
  *why* take 3's original override-only entry (just `base_url`/`api_key`)
  was enough to work at all, but that catalog is *also* where every other
  provider (Gemini, Grok/xAI, OpenAI, Anthropic, 30+ resellers) comes from,
  and Crush's model picker/`crush models` lists the whole thing unconditionally
  by design (`crush --help`: "choose the provider of your choice, and paste
  your API key" — the picker is *meant* to show every known provider).
  `disable_default_providers` (confirmed via Crush's own source,
  `internal/config/provider.go`'s `Providers()`) skips loading that catalog
  entirely, but then requires each provider to be FULLY self-specified
  (`type` + non-empty `models`) to count as "configured" at all — an
  override-only entry that relied on the (now-skipped) built-in catalog to
  fill in `type`/`models` stops validating, and Crush refuses to start
  ("default providers are disabled and there are no custom providers are
  configured"). `identities/zai-auth.ts` now writes `type: "openai-compat"`
  and a static `models` array (copied from Crush's own real Catwalk "zai"
  entry, 11 GLM models) for exactly this reason. `discover_models: true` is
  also set: confirmed live that with a *working* key, Crush merges in a
  live-fetched model list from Z.ai's own API on top of the static one
  (harmless — the live-fetched 8-model set was a strict subset of the static
  11 in testing, so the merge changed nothing observable) — kept mainly so a
  real key stays authoritative if Z.ai's own live list ever drifts from what's
  hardcoded here. The static list is what keeps a freshly-created zai identity
  (blank key, "configure later") able to start Crush at all and browse
  models — without it, a missing/invalid key would fail discovery with
  nothing to fall back to, and the provider would be dropped entirely.
  Verified live (2026-07-18): `crush models` scoped to a configured identity
  now shows exactly the 11 `zai/glm-*` entries and nothing else.
- **Footgun #1 (real incident, caught and fixed same session): `crush
  update-providers <path>` ignores `CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA`
  entirely.** It was tried first, as a way to seed each identity's own
  trimmed provider cache — but confirmed via Crush's own source
  (`cachePathFor()` in `provider.go`) that this cache path is controlled
  ONLY by `XDG_DATA_HOME` (or the OS default `~/.local/share/crush`),
  completely independent of this project's per-identity env vars. Running
  `crush update-providers` scoped to one zai identity actually overwrote the
  REAL, shared, global `~/.local/share/crush/providers.json` with a
  zai-only list — corrupting the default Crush install (and any other
  identity, or ad-hoc `crush` use outside this project) until a plain `crush
  update-providers` (no path arg) was run again to re-fetch the full 39-
  provider catalog from Catwalk and restore it. **Do not use
  `update-providers` for any kind of per-identity scoping — it is
  fundamentally a global, unscoped operation regardless of what env vars are
  set.** `disable_default_providers` (above) sidesteps this cache path
  entirely (the whole default-catalog fetch is skipped, so this cache is
  never touched for a zai identity), which is the other reason it's the
  right fix rather than a merely-preferred one.
- **Footgun #2 (real bug in this project's own `ZAI_CONFIG`, caught and fixed
  same session): pointing `CRUSH_GLOBAL_CONFIG` and `CRUSH_GLOBAL_DATA` at
  the literal same directory — take 3's original, shipped design — makes
  Crush double-register every provider/model.** Confirmed live and
  reproduced deliberately: an identical `crush.json` (11 configured GLM
  models) produced 22 entries in `crush models` when both env vars pointed
  at the same path, and exactly 11 when they pointed at two different
  directories (nested or sibling, either was fine — just not identical).
  Not documented anywhere in Crush's own docs or source comments; found by
  bisecting a working scratch config against the real, broken `identity-a`
  identity until the one differing variable (same-vs-different dir) was
  isolated. Fixed generically, not with a zai-only special case: `ToolConfig
  .extraEnvVarNames` (`identities/types.ts`) changed from `string[]` to
  `Array<{ name: string; subdir?: string }>`, and `run-wrapper.ts`/
  `launch-desktop.ts` both now join `subdir` onto the resolved configDirValue
  when present instead of always mirroring the bare value. `ZAI_CONFIG` sets
  `{ name: "CRUSH_GLOBAL_DATA", subdir: "data" }` — crush's session/model-
  cache state now lives at `<configDir>/data/`, one level below `crush.json`
  itself, still fully within the identity's own configDir (so "one directory
  = one identity, holds everything" from identities.json's point of view
  still holds; it just isn't literally one flat directory internally
  anymore). This is a generic mechanism fix, not zai-specific plumbing — any
  future tool needing more than one redirected directory can reuse `subdir`
  instead of re-deriving this.

#### zai/Crush addendum (2026-07-18, later): `ais limits`/`ais usage` support, live API instead of Crush's own storage

Prompted directly: "Zai has no usage or limits fetcher but should be possible
via the API." Investigating turned up something neither prior take-3 pass
had checked — Z.ai itself exposes a live account-quota API, completely
independent of Crush and never previously looked for.

- **Confirmed live (2026-07-18) against a real "GLM Coding Max" account on
  this machine**: `GET https://api.z.ai/api/monitor/usage/quota/limit` with
  `Authorization: Bearer <key>` returns `data.limits[]`, each entry keyed by
  `(type, unit, number)` rather than a free-text label —
  `TOKENS_LIMIT`/`unit:3,number:5` is the 5h session window,
  `TOKENS_LIMIT`/`unit:6,number:1` is the weekly window, and a third
  `TIME_LIMIT`/`unit:5,number:1` entry is a separate MONTHLY allowance for
  web tools (search-prime/web-reader/zread call counts, not tokens — cross-
  checked its `nextResetTime` against `/api/biz/subscription/list`'s own
  monthly billing cycle, which matched). `percentage` is already 0-100, not
  a 0-1 fraction (confirmed: a same-day-created, barely-used account showed
  `percentage: 1`, not `100`). None of this is documented anywhere in
  `docs.z.ai`'s official API reference — found by reading real
  implementations, not Z.ai's own docs (see next bullet).
- **Found via independent reimplementation, not Z.ai's docs**: a subagent
  search turned up 15+ open-source tools already hitting this exact
  endpoint (tokscale, Raycast's `agent-usage` extension, `openusage`,
  `CodexBar`, and more) — Z.ai has an official first-party usage-check
  Claude Code plugin too (`docs.z.ai/devpack/extension/usage-query-plugin`)
  but its docs don't disclose the underlying endpoint either. tokscale's own
  Rust source (`crates/tokscale-cli/src/commands/usage/zai.rs`) was read
  directly to confirm the exact URL/header/response shape before writing any
  code against it — then verified independently with a real `curl` against
  the live endpoint (matched exactly).
- **CRITICAL caveat, found only by actually running it, not by reading
  source: tokscale's zai client is in its GitHub repo but NOT YET in any
  published release.** Confirmed 2026-07-18: `npm view tokscale versions`
  tops out at `4.5.3` (also `dist-tags.latest`, also what `bunx
  tokscale@latest` — this project's own `resolveTokscaleCommand()` fallback —
  actually resolves to), and running `ais usage --tool=zai` for real against
  that version fails with tokscale's own CLI error: `error: invalid value
  'zai' for '--client <CLIENTS>'` (its valid-values list has no "zai" at
  all yet). So as of this writing, `ais usage --tool=zai` does NOT actually
  work end-to-end — it fails cleanly (the existing "report the error,
  don't crash" path handles it fine) rather than silently.
  **CORRECTED same day, below: this bullet's "forward-compatible, will start
  working once tokscale ships a release" framing was WRONG** — the premise
  (zai.rs just hasn't shipped yet) was right, but the conclusion (that
  shipping it would make THIS report work) doesn't hold. Kept here, marked
  corrected, rather than silently rewritten, since it was already committed
  and pushed before the correction.
- **CORRECTION (2026-07-18, same day, prompted directly by the user's
  confusion — "thought we said ZAI API can be used for `ais usage`?"): the
  bullet above mixed up TWO SEPARATE tokscale subcommands.** `bunx
  tokscale@latest --help` lists a distinct `usage` subcommand ("Show
  subscription usage and quota for AI providers"), completely separate from
  the bare `tokscale --client <CLIENTS> --json` report this project's
  `ais usage` actually shells out to. `zai.rs` lives under
  `commands/usage/` because it belongs to THIS subcommand, not the one this
  project calls. Confirmed live: `ZAI_API_KEY=<key> bunx tokscale@latest
  usage --json` returns real Z.ai session/weekly/web-tools quota data TODAY,
  in the currently-published `4.5.3` — zai support was never unpublished at
  all. But `tokscale usage --help` shows it accepts NO `--client` flag at
  all (confirmed: passing one errors with "unexpected argument '--client'
  found"), and its output is quota PERCENTAGES per provider — the exact
  same shape of data `limits/zai-limits.ts` already surfaces via
  `ais limits --tool=zai`, never historical token counts/costs by model.
  Z.ai's API has no endpoint anywhere (checked directly) that exposes
  historical per-model token data, so the `--client zai --json` report
  `ais usage`'s default aggregate path always requests can NEVER succeed for
  zai, regardless of tokscale's version — this is a genuine, permanent
  data-availability gap, not a temporary one. Also confirmed `tokscale
  usage` is NOT identity-scopable in this project's model even if it were
  wired in: it auto-detects every provider it can find credentials for
  ambiently across the whole machine (confirmed live: it also picked up
  this machine's own unrelated Copilot and Kimi credentials alongside zai,
  with no way to filter to one identity) — plugging it into a per-identity
  report would leak other identities'/tools' data into what's supposed to
  be scoped.
  **SUPERSEDED minutes later, same day: "would leak" turned out to be
  solvable, not a reason to give up on wiring it in.** The user pushed back
  directly ("You need to pass ZAI_API_KEY through to tokscale... we have
  the ability to do this") rather than accepting "permanent gap, use
  `ais limits` instead" — and the fix was simpler than the paragraph above
  implied: `tokscale usage --json`'s response is unscoped, but nothing
  stops THIS project from filtering the response array down to just the
  entry whose `provider === "Z.ai"` before ever showing it to the user. Once
  that filter exists, the "ambient leakage" concern is fully resolved —
  it was a display-scoping problem, not a fundamental one. `run.ts`'s
  `fetchZaiQuotaViaTokscale` (originally named `runZaiQuota` — renamed once
  it became one of two concurrent fetches merged together, see below,
  rather than the sole handler for zai) does exactly this: calls `tokscale
  usage --json` directly
  (bypassing the `--client zai --json` path that was correctly identified
  as permanently broken above), filters to the Z.ai entry, and returns it
  as a new `UsageResult.quota` field (`TokscaleQuotaEntry`, distinct from
  `.report`'s token-count shape). `report.ts` renders it as a placeholder
  row in the main table (dashes, labeled "quota" not "error" — it isn't
  one) plus the real percentages in a new trailing "Quota:" section, rather
  than forcing them into token-count columns that don't apply.
  `tokscaleInvocationFor`'s `clientArgs` also changed: zai now gets `[]`
  unconditionally (not `["--client", "zai"]`) — "zai" was never a valid
  `--client` value for ANY tokscale subcommand, not just the per-model
  report, so the old code would have broken `ais usage --identity=<zai-id>
  --tool=zai -- usage` too (confirmed live: adding `--client zai` there
  fails with "unexpected argument '--client' found", the exact same
  scoped-passthrough case this project already supports for every other
  tool). The now-obsolete `translateZaiTokscaleError` (mentioned in the
  paragraph above as the fix) was deleted entirely — there's no longer a
  permanent failure to translate.
- **This is a LIVE QUOTA check, not a historical-token-log scan — tokscale's
  own "zai" support (its separate `usage` subcommand, see the correction
  above) works the same way, which is the direct answer to "can tokscale
  zai not use crush?"**: confirmed from tokscale's source that its zai
  client does NOT read Crush's local session data at all — it just needs a
  `ZAI_API_KEY`/`GLM_API_KEY` env var and calls the exact same live
  endpoint above.
  **This bullet originally said `ZAI_API_KEY` fed BOTH the default report
  and an unscoped passthrough — no longer true, see the SUPERSEDED note a
  few bullets down.** `ais usage`'s own default aggregate report doesn't go
  through tokscale for zai at all anymore (real numbers come from
  zai-usage.ts's direct SQLite read instead); `ZAI_API_KEY` now serves only
  the explicit passthrough case (`ais usage --identity=<zai-id> --tool=zai
  -- usage`).
  **"Still uninvestigated, still irrelevant" (Crush's own local session
  data) was WRONG, and got corrected within the hour by direct, insistent
  user pushback — twice in one sitting.** First: after seeing zai's row show
  nothing but dashes plus a bare "quota" label in the main table, the user
  said this looked broken; a first fix (putting the weekly percentage
  directly in the COST column) was rejected outright ("Nobody told you to
  move quote into the fucking usage table... FIX IT") — that fix was
  reverted, restoring plain dashes, because it was cosmetic and still didn't
  put real data anywhere. Second, immediately after: the user asked directly
  "And we don't have local logs for it like every other tool...?" — which is
  exactly the investigation that should have happened the first time zai's
  `ais usage` support was built, and didn't. Re-inspecting the SAME
  `.crush/crush.db` `resume/zai-resume.ts` already reads (this repo's own
  real database, created by this session's own earlier test invocations)
  found `sessions.message_count`/`prompt_tokens`/`completion_tokens`/`cost`
  — REAL, populated, non-zero columns (one real session: 45992 prompt
  tokens, 516 completion tokens; `sqlite3` confirmed a live SUM query
  returning 26 messages, 298004 prompt tokens, 1970 completion tokens,
  $0.145599 cost across this repo's own sessions) — that were simply never
  read for usage reporting, only `id`/`title`/`updated_at`/`created_at` for
  resume. "Z.ai's API has no token/cost history" (true, confirmed
  repeatedly) had been allowed to silently stand in for "zai has no local
  logs at all" (false) — those are not the same claim, and conflating them
  is the actual root cause of every wrong "permanent gap" statement made
  about `ais usage --tool=zai` earlier this session.
- **New: `usage/zai-usage.ts`'s `fetchZaiUsage`** — aggregates real local
  token/message/cost totals for one zai identity across EVERY project
  directory its own `projects.json` has ever recorded (unlike
  `resume/zai-resume.ts`, which scopes to the current cwd only — usage
  reporting for the other four tools means "this identity's entire history,"
  not "just here," so zai matches that). Uses the same `bun:sqlite`
  readonly-open pattern as zai-resume.ts, summing `message_count`/
  `prompt_tokens`/`completion_tokens`/`cost` with a single `SUM(...)` query
  per project db rather than iterating rows in JS. `totalCacheRead`/
  `totalCacheWrite` are genuinely `0` for zai, not a gap in this reader —
  checked the `messages` table's schema directly too, and there's no
  cache-read/write breakdown anywhere in Crush's local storage at all.
  Returns `undefined` (not an error) when there's nothing yet — no
  `projects.json`, or every registered project has no `crush.db` — matching
  every other reader's "identity has just never used this tool" convention.
  A `crush.db` that exists but fails to open/query is skipped, not fatal to
  the whole aggregate.
- **`run.ts`'s zai handling restructured to run BOTH concurrently, not
  either/or**: `runZaiUsage` calls `fetchZaiUsage` (real local totals, no API
  key needed — plain file I/O) and `fetchZaiQuotaViaTokscale` (live quota %,
  needs a key) in parallel via `Promise.all`, merging whichever succeed into
  one `UsageResult` — `report` when local data exists (now the COMMON case
  for a real, in-use identity), `quota` when a live check succeeds
  (independent of whether `report` also exists), and a hard error only when
  BOTH come up empty. This is why `runOne`'s zai branch had to move BEFORE
  the `tokscaleInvocationFor` early-return that gates every other tool: that
  check only tells you whether a live quota fetch is possible, and zai's
  local-log report doesn't depend on it at all — gating on it first would
  have skipped the (now primary) local-log path entirely for any identity
  missing a configured key.
- **`report.ts`'s row selection already handled this correctly with zero
  changes needed**: `r.report ? successRow(r) : r.quota ? quotaRow(r) :
  errorRow(r)` was written before this fix existed, but "prefer the real
  report, fall back to quota-only, then error" was already exactly the
  right precedence — a zai identity with real session history now renders
  with `successRow` (real numbers, participates in the TOTAL row) exactly
  like every other tool; `quotaRow` (plain dashes, no fabricated number —
  see report.ts's own comment for why a first attempt at showing a number
  there was reverted) is now the rarer fallback for a brand-new identity
  with a working key but no Crush sessions yet.
  **SUPERSEDED minutes later, same day: the whole quota-merge design in
  these last two bullets was removed entirely, not kept as a fallback.**
  The user's reaction was immediate and unambiguous: "Wait. Why is there
  still a fucking quoata section on the usage command???" — `ais usage`
  merging in a live quota % (even just as a fallback for brand-new
  identities, even clearly labeled) was never actually asked for, and no
  other tool's `ais usage` output has an equivalent extra section — it was
  scope creep this session added on its own initiative while fixing the
  real ask (real token/cost numbers). Fully reverted: `run.ts`'s
  `fetchZaiQuotaViaTokscale` and the concurrent `Promise.all` merge in
  `runZaiUsage` are gone — it's back to a single `fetchZaiUsage` call,
  reporting a plain "no local Crush session data yet for this identity"
  error when there's nothing. `report.ts`'s `quotaRow`/`formatQuotaLine`
  and the trailing "Quota:" section are deleted; row selection is back to
  the original two-way `r.report ? successRow(r) : errorRow(r)`.
  `tokscale.ts`'s `TokscaleQuotaEntry`/`TokscaleQuotaMetric` types are
  deleted too — nothing parses `tokscale usage`'s JSON output anymore.
  `tokscaleInvocationFor`'s zai handling (empty `clientArgs`, `ZAI_API_KEY`
  env var) is UNCHANGED and still correct — it's still needed for
  `usage/passthrough.ts`'s explicit `ais usage --identity=<zai-id> --tool=zai
  -- usage`, a deliberate, explicit invocation of tokscale's own subcommand
  that's a genuinely different thing from `ais usage`'s own default
  aggregate report auto-fetching and displaying it unasked. Live quota
  percentages have exactly one home now: `ais limits --tool=zai`.
- **New: `identities/zai-auth.ts`'s `readZaiApiKey(configDir)`** — the
  read-side counterpart to `writeZaiAuthFile`, pulling the literal key back
  out of `<configDir>/crush.json`'s `providers.zai.api_key`. Returns
  undefined (not the literal string) for anything that isn't a usable key:
  missing file, missing field, or a value shaped like an env-var reference
  (`"$ZAI_API_KEY"`, valid inside Crush's own config but not something an
  external HTTP caller can resolve) — callers treat that identically to "not
  authenticated yet," same as kimi-limits.ts's missing-credentials path.
- **New: `limits/zai-limits.ts`'s `fetchZaiLimits`**, wired into
  `limits/collect.ts`'s `FETCHERS`. Much simpler than kimi-limits.ts: a
  static API key, not OAuth, so there's no token-refresh flow at all — just
  one GET, mapped into this project's own `LimitWindow` shape (`session`/
  `week` categories for the two `TOKENS_LIMIT` entries; the `TIME_LIMIT` web-
  tools entry is deliberately labeled "web tools"/category "other" rather
  than "month" — it measures a different resource, call counts, and lumping
  it in with token-based monthly windows the way Codex/Grok report them
  would misrepresent it as directly comparable).
- **`usage/tokscale.ts`'s `tokscaleInvocationFor` is now `async`** (it wasn't
  before) — reading the key back out of `crush.json` is unavoidably async
  file I/O, so both call sites (`usage/run.ts`'s `runOne`,
  `usage/passthrough.ts`'s scoped branch) now `await` it. Returns `undefined`
  (same "not supported" contract every other gap already used) when the
  identity has no usable key yet, rather than handing tokscale an empty env
  var.
- **The unscoped "merge every identity into one tokscale process" path
  (`buildMergedExtraDirs`, renamed `buildMergedEnv`) can only ever carry ONE
  zai identity's key** — a hard structural limit, not an oversight: the
  other four tools merge via `TOKSCALE_EXTRA_DIRS`, an additive
  comma-separated list that happily holds N identities at once; zai works via
  a single `ZAI_API_KEY` env var, and only one value can occupy that slot in
  one shared process. With exactly one zai target in the merged set its key
  is included (best-effort, same "surface everything configured" spirit as
  the directory merge); with zero or more than one, zai is dropped from the
  merge silently (logged nowhere differently than any other unsupported-gap
  drop) — a `ais usage --identity=<name> --tool=zai` scoped call always
  works regardless, since that path never merges anything.
- **`ais resume --tool=zai` is still NOT implemented, deliberately, and
  isn't closed by any of the above** — the quota API answers "how much have
  I used," not "what sessions exist to resume." Crush's own session storage
  format remains uninvestigated; closing this gap would need that
  investigation specifically, not another live-API shortcut.
  **Superseded by the 2026-07-18 (later) addendum below** — that
  investigation happened, and it turned up something genuinely different
  from every other tool's storage model.

#### zai/Crush addendum (2026-07-18, later still): `ais resume`, and Crush's per-project (not per-identity) session storage

Directly requested as a follow-up once limits/usage were confirmed working:
"investigate resume." The investigation itself is what closed the gap — the
premise above (a live API can't answer "what sessions exist") is correct,
but the actual blocker (Crush's session storage being unknown) turned out to
be a quick, concrete answer once actually looked for, not an open-ended
unknown.

- **Confirmed live (2026-07-18) by direct SQLite inspection of a real
  `.crush/crush.db` this repo's own `crush` invocations had already
  created**: Crush does NOT store session/message data anywhere under the
  identity's own configDir at all (unlike claude/codex/grok/kimi, which all
  centralize everything there) — it creates a project-LOCAL `.crush/`
  directory inside whatever cwd it's run from, the same "one dotdir per
  project" model `.git` uses. That directory holds `crush.db` (a real
  SQLite file, WAL journal mode — confirmed safe for concurrent reads
  alongside an active writer) with a `sessions` table:
  `id, parent_session_id, title, message_count, cost, updated_at,
  created_at` (plus a few fields this project doesn't need). `title` is a
  real, auto-generated summary of the conversation (e.g. "Say hi in one
  word") — genuinely useful, not a placeholder — EXCEPT a small fraction of
  sessions get the literal placeholder `"Untitled Session"`, treated as "no
  label" the same way kimi's `"New Session"` placeholder is.
  `parent_session_id` is non-null for a sub-agent/child session — excluded
  from `ais resume`'s listing, since a user resuming wants a top-level
  conversation, not an internal sub-task (confirmed by direct testing:
  seeding a synthetic child row and verifying the reader excludes it).
- **A real, confirmed discrepancy in Crush's own schema**: the `sessions`
  table's SQL definition carries an inline comment claiming `updated_at`/
  `created_at` are "Unix timestamp in milliseconds" — they are NOT. Verified
  by converting a real row's value both ways: as milliseconds it lands in
  1970; as SECONDS it lands on today's actual date. Trusted the conversion
  that produced a sane date over the schema's own comment.
- **The missing link tying a project directory back to a specific
  identity**: Crush's own `projects.json` (at `<CRUSH_GLOBAL_DATA>/
  projects.json` — this project's own `CRUSH_GLOBAL_DATA`, i.e.
  `<configDir>/data` since the 2026-07-18 subdir fix above), a plain JSON
  file: `{ projects: [{ path, data_dir, last_accessed }] }`, one entry per
  project directory Crush has ever run in under that identity. This is
  exactly the piece needed: filter this identity's own `projects.json` for
  an entry whose `path` matches the current cwd (same
  `normalizePath`-then-exact-match convention every other reader already
  uses), then open THAT entry's `data_dir/crush.db` directly.
- **New: `resume/zai-resume.ts`'s `readZaiSessions`**, wired into
  `resume/collect.ts`'s `READERS`. Uses Bun's built-in `bun:sqlite` (`import
  { Database } from "bun:sqlite"`, opened `{ readonly: true }`) — zero new
  dependency, since Bun ships SQLite support natively and this project
  already compiles with `bun build --compile`. A `projects.json` entry whose
  `data_dir/crush.db` doesn't exist yet (the directory was only ever used
  for something that doesn't create a session, e.g. `crush dirs`) is
  skipped silently, not an error — same "identity has just never used this
  tool from this cwd" convention every other reader applies. Duplicate
  `projects.json` entries pointing at the same `data_dir` are deduped before
  querying, so a stale re-registration can't double-report sessions.
- **Two real, pre-existing bugs in `resume/launch.ts` found and fixed while
  wiring zai in — both invisible until zai, since every prior tool's
  `realBinaryName` happened to equal its `toolName`, and none had
  `extraEnvVarNames`:**
  1. `resolveRealBinary(session.toolName)` — for zai, `session.toolName` is
     literally `"zai"`, but there IS no binary named "zai" on PATH (the real
     binary is `crush`). Fixed to `resolveRealBinary(cfg.realBinaryName)`,
     a no-op change for claude/codex/grok/kimi (identical either way) but
     load-bearing for zai.
  2. The env injection only ever set `[cfg.envVarName]:
     session.identity.configDir` — never mirrored `cfg.extraEnvVarNames` the
     way `run-wrapper.ts` does. zai needs BOTH `CRUSH_GLOBAL_CONFIG` and
     `CRUSH_GLOBAL_DATA` (at `<configDir>/data`) set correctly, or a resumed
     session would read/write the wrong (or Crush's own unscoped default)
     data directory. Fixed by mirroring the exact same `subdir`-joining
     logic `run-wrapper.ts` already uses.
- **Verified live, end-to-end, twice — the listing AND the actual resume**:
  `ais resume --identity=identity-a --json` correctly listed all 9 real zai
  sessions in this repo's own `.crush/crush.db`, newest-first, with real
  titles as labels. Separately verified the RELAUNCH path's correctness
  (can't drive Crush's interactive TUI in this sandbox, so used `crush run
  --session <id> "what was my very first message?"` with the exact same
  env-var construction `launchResume` builds) — Crush correctly continued
  the exact session `ais resume` had listed, correctly recalling that
  session's actual first message, proving genuine session continuity rather
  than accidentally starting a fresh one.
- **`ais resume`'s `ResumableSession.toolName` union widened to include
  "zai"** (`resume/types.ts`) — `ToolResumeResult.toolName` already included
  it (a `Partial` record already anticipated this gap being filled later).
  No changes needed in `resume/pick.ts`/`resume/report.ts` — both are
  already fully generic over `ResumableSession`/`ToolResumeResult`, with no
  hardcoded per-tool branching to widen.
- **A real, reproduced flake found during this same verification pass, not
  a hypothetical**: opening `crush.db` readonly and immediately querying it
  failed once with "unable to open database file" in the narrow window
  right after this session's own live `crush run --session ...` write had
  just landed on that exact file — succeeded consistently on every retry
  seconds later, and succeeded immediately when opened via a completely
  separate, non-readonly connection at the same moment. WAL mode is
  supposed to let readers proceed alongside a writer without this, but
  empirically there's still a narrow window where it doesn't. Since a user
  running `ais resume` right after finishing a real zai session is exactly
  the moment this is most likely to recur, `zai-resume.ts`'s
  `queryTopLevelSessions` retries up to 3 times with a 100ms delay before
  surfacing a read as a genuine failure — not a blind "retry everything"
  policy, just this specific, observed transient-open failure class.

### ali case study (2026-08-07): Alibaba Cloud Model Studio's Token plan, the second crush-backed tool

`ali` is the sixth wrapped tool and the second fake proxy identity for the
real `crush` binary (github.com/charmbracelet/crush), following the exact
recipe zai's take-3 design (above) already worked out: a self-contained
custom provider entry in `crush.json`, non-interactive auth via a plain API
key, `disable_default_providers` to scope the model picker down to just this
provider's models.

- **What Alibaba's "Token plan" is**: Alibaba Cloud Model Studio (the
  DashScope/Bailian platform) offers an Anthropic-compatible endpoint under
  its Token plan, at
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`.
  Confirmed live (2026-08-07), same proof shape zai's take 3 used: writing a
  self-contained `crush.json` "alibaba" provider entry
  (`type: "anthropic"`, that `base_url`, `disable_default_providers: true`,
  a static `models` array) and running NO `crush login` at all was enough
  for `crush models` to list exactly those models, and for
  `crush run --model alibaba/<id> "..."` to send a REAL request to
  `<base_url>/v1/messages` (rejected only with a genuine Alibaba 401
  (carrying a real `request_id`) for a placeholder key, proving the config
  was actually read and used for the request, not just listed from a static
  catalog.
- **No `discover_models`: a deliberate, confirmed difference from zai's own
  entry, not an oversight.** zai's `writeZaiAuthFile` sets
  `discover_models: true` because Z.ai's endpoint has a real model-list API
  crush can merge live results from. Alibaba's Token plan endpoint has NO
  model-list endpoint at all (only `/v1/messages`), so live discovery would
  simply fail on every launch. `writeAliAuthFile` (`identities/ali-auth.ts`)
  omits the field entirely (not `false`, just absent) and documents why
  inline: the static `ALI_MODELS` list is the ONLY source of truth for this
  provider, never a fallback a live fetch could supersede.
- **The bespoke `ALI_CONFIG_DIR` envVarName is the one genuinely new design
  decision here, not copied from zai.** `ali` is the SECOND tool proxying
  `crush`, and `open.ts`/`resolve.ts` step (b) both identify the active tool
  by `envVarName` (`TOOL_CONFIGS.find((cfg) => process.env[cfg.envVarName])`
  in `open.ts`). If `ALI_CONFIG` reused `CRUSH_GLOBAL_CONFIG` (zai's own
  envVarName), an ali session and a zai session would be indistinguishable
  from each other, the exact collision class zai's OWN take-2 design hit
  when it shared `claude`'s envVarName with `CLAUDE_CONFIG` (see the "zai
  case study, take 2" section above). Fixed the same way take-3's fix for
  that problem worked: `ALI_CONFIG.envVarName` is the bespoke
  `ALI_CONFIG_DIR` (a var `crush` itself never reads), and the real crush
  vars (`CRUSH_GLOBAL_CONFIG`, `CRUSH_GLOBAL_DATA`) are mirrored via
  `extraEnvVarNames` instead (the exact mechanism `extraEnvVarNames` was
  built for in the first place (see `ToolConfig.extraEnvVarNames`'s own doc
  comment in `identities/types.ts`), just serving a second, different reason
  here (avoiding an envVarName collision) than it did for zai (splitting
  config from data). `open.ts`'s `TOOL_CONFIGS` array now lists `ALI_CONFIG`
  BEFORE `ZAI_CONFIG` specifically because of this: an ali session sets BOTH
  `ALI_CONFIG_DIR` and `CRUSH_GLOBAL_CONFIG` (the latter via its own
  extraEnvVarNames), while a zai session sets only `CRUSH_GLOBAL_CONFIG`;
  checking `ALI_CONFIG_DIR` first is what disambiguates the two, and the reverse
  order would misclassify every ali session as a zai one.
  - **Known, accepted residual** (same class as zai take-2's claude-sharing,
    not newly introduced here): a nested bare `zai` launch fired from
    inside an ali session sees `CRUSH_GLOBAL_CONFIG` already set (via ali's
    own extraEnvVarNames) and resolve.ts step (b) resolves it straight to
    the ali identity's configDir instead of prompting fresh. Not
    specifically guarded against, the same accepted risk shape as the
    zai/claude case, not a new hole this design introduces.
- **Limits support is a genuinely LIVE fetch, but via a browser-session
  cookie, not the inference API key — the Token plan has NO key-based quota
  endpoint, confirmed twice independently, not assumed (2026-08-07).** First
  by probing the inference host directly with the real key: only
  `/v1/messages` exists; every plausible usage/quota/models path on the
  token-plan host 404s "Not support", and DashScope's own endpoints reject
  the `sk-sp-...` key outright (it is a separate key namespace). Second, by
  reading CodexBar's (steipete/CodexBar) Token Plan implementation, which
  states it outright: "API-key auth ... not supported", cookie-only. The
  only working route is the Alibaba OneConsole browser gateway
  (`POST bailian-singapore-cs.alibabacloud.com/data/api.json?action=
  IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.
  /tokenplan/personal/api/v2/usage`), authenticated by the console session
  cookies. `limits/ali-limits.ts`'s `fetchAliLimits` implements exactly
  that request (headers, form body, and the `cornerstoneParam`
  client-context object — no secrets, `switchAgent` deliberately omitted,
  all mirroring CodexBar's fetcher one-for-one), and reads the cookie from
  `<configDir>/console-cookie.txt` (a plain-text file the user pastes
  their browser's Cookie header into — browser cookie-store import isn't
  portable across this project's machines, so manual paste is the only
  source; CodexBar supports the identical manual path alongside import).
  Confirmed live: the request round-trips and an expired/absent cookie
  surfaces as an honest "console session expired" unavailable, never a
  crash. Response shape: the outer envelope's `data.DataV2.data.data`
  carries `per5HourPercentage`/`per1WeekPercentage` as 0-1 FRACTIONS
  (unlike zai's 0-100 points — a barely-used account shows ~0.001) plus
  epoch-ms reset times. tokscale integration remains genuinely absent for
  ali: tokscale has no `"ali"`/`"alibaba"` client id AND there's no live
  quota API its own `usage` subcommand could hit as a fallback.
- **Usage and resume both reuse zai's exact local-log mechanism, generalized
  rather than copy-pasted.** Crush tracks real per-session token/message/
  cost data locally (`<project>/.crush/crush.db`) regardless of which
  provider it's pointed at (the same discovery that closed zai's own usage
  gap (see the 2026-07-18 zai/Crush addenda above) applies identically to
  ali. Rather than re-deriving that SQLite aggregation a second time,
  `usage/zai-usage.ts` and the new `usage/ali-usage.ts` are now both thin
  wrappers around a shared `usage/crush-usage.ts`'s `fetchCrushUsage(identity,
  dataSubdir)`; `resume/zai-resume.ts` and the new `resume/ali-resume.ts`
  are likewise thin wrappers around a shared `resume/crush-resume.ts`'s
  `readCrushSessions(toolName, identity, targetCwd, dataSubdir)`. Both zai
  and ali pass `dataSubdir: "data"` (matching their `CRUSH_GLOBAL_DATA`
  subdir; see tool-configs.ts). `resume/launch.ts`'s two zai-era fixes
  (resolving the REAL binary via `cfg.realBinaryName`, not `session.toolName`;
  mirroring `cfg.extraEnvVarNames` with `subdir` support) already generalize
  to ali with zero further changes, since both were written against
  `ToolConfig`, not a zai-specific literal.
- **Sync generalized from zai-only to "any crush-backed tool," not
  duplicated per tool.** The pre-existing sync code (`sync/rsync.ts`,
  `sync/sqlite-merge.ts`, `sync/service.ts`, `sync/watch.ts`) had several
  `scope.cfg.toolName === "zai"` / hardcoded `.zai/identities.json` checks
  that would have silently excluded ali's own project-local `.crush` data,
  `projects.json` exclusion, and SQLite VACUUM-snapshot merge protocol.
  Generalized via a new `CRUSH_BACKED_TOOL_CONFIGS` export in `sync/rsync.ts`
  (every `ToolConfig` with `realBinaryName === "crush"`, currently zai and
  ali) and an `isCrushBacked(cfg)` helper in `sync/service.ts`, rather than
  adding a second parallel `"ali"` check next to every existing `"zai"` one.
  `sqlite-merge.ts`'s `discoverCrushDatabasePaths` now scans EVERY
  crush-backed registry's `identities.json` (previously hardcoded to
  `.zai/identities.json` alone), reusing `rsync.ts`'s own `configHomeRoot()`
  to re-derive each tool's home-relative container directory (".zai",
  ".ali") rather than hardcoding either string a second time. The internal
  SSH protocol commands (`ais sync snapshot-zai`/`merge-zai-snapshot`) keep
  their historical zai-flavored names unchanged; they already operate on
  "every crush database this discovery function finds," so renaming them
  would only churn cross-host compatibility for no behavioral gain; their
  handlers already call the now-generalized `createCrushSnapshotTree`/
  `mergeCrushSnapshotTree` with no args, so ali's databases participate
  automatically.
- **`ais upgrade` keeps distinct `ZAI_CONFIG` and `ALI_CONFIG` specs, but
  deduplicates their identical physical installer.** Both point at
  `@charmland/crush` and the same real `crush` binary. A real upgrade showed
  why two supposedly idempotent npm calls are unsafe: the first installed
  Crush successfully, then the second reran Crush's network-bound
  postinstall and failed on a transient GitHub DNS lookup, turning a
  successful upgrade into an overall failure. `runUpgradeWithDeps` therefore
  caches results by npm package, real binary, script allowlist, and fallback
  arguments. Both installed shims are still detected independently, but one
  physical installer is attempted and counted once; if only one alias is
  installed, that alias still triggers the install normally. The parallel
  runner preserves this structurally rather than by cache timing:
  `planUpgrades` makes the first spec of each identical installer key the
  leader and the rest followers, so the single physical install runs while
  the follower awaits its outcome (success renders the follower as a skipped
  "shares installer with zai" row; failure fails the follower's row without
  counting it twice in the summary).
- **Model list is static/fallback metadata, not independently verified
  per-model figures.** Costs are 0 (plan-included, same convention as
  zai's own `glm-5.2` entry) and context windows/max-tokens are reasonable
  defaults, not confirmed against Alibaba's own published specs for each
  model. This doesn't matter functionally: Alibaba's real endpoint enforces
  its own actual limits server-side regardless of what crush's local
  config claims, the same as zai's own static fallback list.
- **No desktop app, no interactive login, same as zai.** `ali`'s
  `--desktop` is wired up structurally (appName `"Crush"`, same as zai) but
  expected to just fail resolving `/Applications/Crush.app`, and there is no
  browser-OAuth flow of any kind involved in ali's auth (a plain API key in
  a JSON file), so `open.ts`'s Chrome-MCP-redirect mechanism has nothing to
  do for ali either (same as zai's own final state, see "zai case study,
  take 3" above), never re-verified because there's nothing here to verify.
- **Console-cookie auto-refresh post-mortem and hardening (2026-09-10).**
  The user's ali console session expired again despite the AuthRefreshScheduler
  and the host systemd timer. Root cause, three stacked layers, all
  evidence-backed live: (1) Alibaba expired the pod browser's login
  server-side (last successful harvest 2026-09-05 10:30Z; no
  `login_aliyunid_ticket` cookie and the console renders "Log In to Use"
  after navigation today); a pure cookie harvest can never out-live
  Alibaba's login TTL, so an interactive noVNC re-login remains the manual
  step. (2) The auth browser pod's tab sat at `about:blank` after pod
  churn, and `refreshAliAuthSession`'s starting-URL precondition bailed on
  that EVERY tick without ever opening the console itself, so a transient
  tab state permanently bricked the automation with no recovery and no
  alarm. (3) When the tab WAS on an Alibaba page the harvest wrote whatever
  it found and reported success (verified live: 39 logged-out analytics
  cookies stamped over `console-cookie.txt`, including
  `login_aliyunid_csrf`, which exists logged-out). Fix: the refresh now
  navigates to the console itself (self-heals pod restarts), verifies the
  `login_aliyunid_ticket`/`login_aliyunid` cookie BEFORE writing anything,
  and throws `AliAuthRefreshError` (message + remediation hint) instead of
  returning `undefined`. Failure is LOUD: `ais auth refresh` prints the
  error + hint to stderr and exits 1 (the `--quiet` timer still shows in
  journalctl/systemctl), the scheduler logs one stderr line per failure
  with a consecutive-failure count and escalates past 3
  (`ESCALATION_THRESHOLD`), the status endpoint/`ais doctor` (new
  `probeAliDoctor`, `degraded` status) flag it, and
  `ais limits --tool=ali` appends "(last refresh attempt <ts>: <error>)"
  to the expired message via `lastRefreshFailure()`.

