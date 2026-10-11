# AWS Bedrock reporting and spend guard

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3058-3119 3184-3258). Read before touching this area._

### AWS Bedrock case study (2026-09-10): Budgets for limits, Cost Explorer for usage

Some codex identities don't answer to OpenAI at all: their `config.toml`
sets `model_provider = "amazon-bedrock"` (Bedrock inference auth is a
`bedrock_api_key` in the identity's own auth.json, separate from AWS
account auth). Provider-first reporting means these must render as "AWS
Bedrock" rows, and the only real spend/limit signals are AWS's own
billing-plane APIs:

- **Identity -> AWS profile is machine-local config, never credentials.**
  `identities/aws-profile.ts` resolves, in order: `AWS_PROFILE` in the
  identity's registry `env` (new additive `Identity.env` field), then
  `~/.ais/config/aws-profiles.json` (`{version:1,identities:{<name>:{profile}}}`
  — same shape/spirit as chrome-mcp.json: account wiring never belongs in a
  public repo; absent file = machine isn't set up = "nothing to report",
  malformed file = honest error row). The profile is enriched with
  `region`/`sso_account_id` parsed from `~/.aws/config`, which stays the
  single source of account-id truth. Detection is a sync config.toml probe
  (`isBedrockIdentity`), safe to call from the pending-seed paths.
- **Limits = AWS Budgets** (`limits/aws-bedrock-limits.ts`):
  DescribeBudgets + DescribeBudget per account (the SDK's Budgets list
  operation is old-style "Describe*", there is no ListBudgets command).
  Each COST budget renders one `category: "month"` window: label
  `budget: <name>`, usedPercent = ActualSpend/BudgetLimit (deliberately
  unclamped; renderBar clamps for display), resetsAt derived from the
  budget's TimeUnit — recurring budgets set TimePeriod.End to a 2087
  sentinel, so the period end date is NEVER the reset. Spend over limit is
  the one honest OverageInfo (active, real dollars, real cap).
- **Usage = local estimate in the columns, real Cost Explorer underneath**
  (`usage/aws-bedrock-usage.ts` + `shared/local-spend.ts`, corrected
  2026-09-10 after the conflation regression): a Bedrock row's MESSAGES/
  INPUT/OUTPUT/CACHE READ and EST. COST come from the identity's own
  session logs through the SAME shared readers, period filter and Bedrock
  rate valuation the spend guard uses (month-to-date, local calendar), so
  the two pathways reconcile per identity by construction. The REAL AWS
  figures ride separately in `UsageResult.realCost` (Cost Explorer
  GetCostAndUsage UnblendedCost (Filter SERVICE == "Amazon Bedrock"),
  month-to-date sliced from the DAILY buckets of the unchanged trailing
  3-month window, plus the trailing-window total and the enforced COST
  budget's limit/ActualSpend, AWS Budgets, best-effort) and render as a
  dimmed `└ real AWS month-to-date:` sub-row under the provider row, with
  one trailing real total line beneath TOTAL. The two layers never swap
  places: an estimate column must never carry real spend, nor vice versa
  (the original display stuffed real dollars into EST. COST with zero
  tokens, hiding all local tracking). A Cost Explorer failure degrades
  into `realCost.error` ("unavailable", never a fabricated zero) while
  the local half of the row survives; Cost Explorer serves ONLY from
  us-east-1: force the client region regardless of profile region.
  dailyCostUsd stays a JSON-only real-dollars-by-UTC-day dimension.
- **Auth is the AWS CLI's own SSO chain** (fromIni({profile}) reads
  ~/.aws/sso/cache and auto-refreshes sso-session tokens). An expired
  token cannot be fixed non-interactively — classified via
  `isSsoAuthError` and reported as "run `aws sso login --profile <p>`";
  ais deliberately never attempts the browser flow. Transport blips retry
  3s/8s like every other fetcher (a transient Bun "typo in the url"
  endpoint error was observed live and rides out).
- **Wiring reuses the multi-provider-adapter shape**: the codex entry in
  limits/collect.ts's FETCHERS (and usage/run.ts's runOne + both pending
  seeds) routes Bedrock identities to the AWS fetchers, which stamp
  provider "aws-bedrock" themselves (providerForTool(codex) is "openai",
  wrong by definition here) and return [] for nothing-to-report (no
  budgets, no mapping) unless an explicit `--tool=` asked.

### Spend guard case study (2026-09-10): enforcement, not reporting

The Budgets/Cost Explorer work above only REPORTS spend. The spend guard
(`src/spend/`, `src/server/spend-guard.ts`) is the half that ACTS on it:
when an AWS account's spend hits its Budgets cap, AIS cuts the account off.
Decisions are final by design; the reasoning is recorded here.

- **What enforces.** Two mechanisms, one state. The per-account state
  (budget cap, local estimate, real spend, breached/enforced/degraded) is
  computed by a pure core (`spend/state.ts`) from three signals: the AWS
  Budgets COST budget with the largest limit (the cap is AUTO from AWS;
  there is deliberately no manual cap config), a local token-based estimate
  summed across EVERY identity mapped to the account, and real AWS-reported
  spend (Cost Explorer Bedrock spend plus the budget's own
  CalculatedSpend.ActualSpend). What a breach DOES is decided by the
  machine-local config's `mode` key (`spend/config.ts`,
  ~/.ais/config/spend-guard.json): `"warn"` is the DEFAULT (also when the
  key or the whole file is absent, by owner decision 2026-09-11) and
  surfaces the breach loudly everywhere while refusing nothing and killing
  nobody; `"enforce"` is the original hard stop, preserved exactly. In
  enforce mode the LAUNCH GATE (`spend/gate.ts`, wired in run-wrapper.ts)
  refuses new wrapped sessions on a breached account before any side
  effect, with a full refusal (account, budget, cap, estimate vs real,
  period) and exit 1; in warn mode the same gate prints ONE loud warning
  (account, budget, cap, effective spend, and how to switch) and the launch
  continues. In enforce mode the DAEMON KILLER (`server/spend-guard.ts`,
  default 5-min cycle) terminates ACTIVE wrapped sessions on the TRANSITION
  into breach (first observation counts; a stayed-breached account is not
  re-killed): SIGTERM, 10s grace, SIGKILL, every kill logged loudly and
  exposed on GET /api/spend-guard with the state. In warn mode the killer
  still computes and records every account state and breach transition, but
  the kill action is unreachable (no scan, no signal) and the skip is
  logged. Every surface (DTO, `ais doctor`, `ais limits` notes, WebUI)
  distinguishes BREACHED (warning) from BREACHED (enforced).
- **The local estimate is a direct log reader, not tokscale.** The gate
  must be fast and fully offline: a warm tokscale spawn measured ~2.4s for
  one codex identity and its report has no date filter, so
   `shared/local-spend.ts` (moved there 2026-09-10 so the usage fetcher
   reads through the identical implementation) parses the same session logs
   directly (codex
  rollout JSONL token_count events, claude projects JSONL usage events),
  period-filtered (month-to-date for a MONTHLY budget), valued at Bedrock
  on-demand rates (`model-pricing.ts`; unknown models at the table's
  element-wise MAX, the safe direction). Measured ~0.4s month-to-date per
  codex identity. Gate cost with a fresh cache: one JSON read (<50ms);
  enforcement always runs on LAST-KNOWN state, refreshed by a detached
  `ais __spend_refresh` (or the daemon's cycle) writing
  ~/.ais/cache/spend-guard.json.
- **The staleness contract.** The local estimate is always computable
  offline and is the PRIMARY breach signal (AWS billing lags by hours; it
  is what catches a blown cap first). Real spend blends as
  max(local, real), and only from sources whose fetch SUCCEEDED this
  cycle, so a stale zero can never mask a breach. If a budget LIMIT cannot
  be fetched (SSO expired, API down), the account is UNENFORCED (nothing
  to enforce against) but flagged degraded loudly everywhere: daemon
  status, `ais doctor`, `ais limits` notes, and the WebUI. Never block on
  missing data; never silently skip either.
- **No override.** No env var, no flag, no interactive bypass exists, for
  the gate or the killer. The one switch is deliberate and machine-local:
  `mode` in ~/.ais/config/spend-guard.json ("warn" default, "enforce" to
  restore the hard stop). Editing or removing the budget in AWS (or the
  machine-local identity->profile mapping) is the only other escape, and
  that is accepted.
- **What cannot be enforced.** In-flight requests always complete: the
  killer signals processes and cannot retract a request a model is already
  generating (billed tokens may still land after the cap is hit). The
  estimate is an ESTIMATE: local pricing may differ from real billing
  (cache tiers, >200k-context rates are not modelled), so the gate can
  block slightly early or late; Cost Explorer corrects the blend within
  hours. Sessions a user launches without a wrapper (bare binary, no
  marker env) are invisible to both mechanisms. Other machines' spend on
  the same AWS account is invisible until Cost Explorer reports it; the
  blend covers that gap, but at AWS's reporting lag. And kill coverage
  extends only to wrapped sessions discoverable in /proc (Linux-only
  attribution via the marker env var, same shape as the herdr detection).

