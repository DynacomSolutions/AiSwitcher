# History: retired designs and duplicated sections

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1620-1917 3121-3182). Read before touching this area._

### zai case study, take 1 (2026-07-17) — RETIRED same day, kept for the "why"

**Superseded by "zai case study, take 2" below, a few hours later in the same
day.** Everything in this subsection describes the FIRST design (`zai` proxies
`opencode`) and is no longer how the code works — kept only so the reasoning
that led to it, and the reasoning that overturned it, aren't lost. If you're
looking for how `zai` actually works today, skip to take 2.

Third tool added via the recipe above, and the first that DOESN'T fit it
cleanly — it's a fake proxy identity name for a real CLI (`opencode`) that
has nothing to do with the name "zai" at all, and that real CLI's own config
model doesn't match the "one env var swaps the whole identity" assumption
every other tool relies on. Findings below were verified empirically on this
machine, 2026-07-17 (a mix of live `bunx opencode-ai@latest ...` runs against
the real npm package, on-disk inspection after the user's own real
`opencode auth login`, and source-level research of `anomalyco/opencode`,
formerly `sst/opencode`):

- **What "zai" actually is**: there is no real "zai" CLI. ZAI (Z.ai/Zhipu AI,
  maker of the GLM models) is a *provider* supported natively inside
  OpenCode (github.com/anomalyco/opencode, npm `opencode-ai`, brew
  `opencode`, binary name `opencode`) — provider id literally `"zai"`
  (confirmed in opencode's own `packages/opencode/src/provider/transform.ts`),
  built into its models.dev provider registry, no custom provider JSON
  needed. So `zai --identity=<name> ...` is a normal identity-switching proxy
  in every way that matters to the user, but the binary it ultimately execs
  is `opencode`, configured (via that identity's own auth login) to talk to
  the ZAI provider — hence `ToolConfig.realBinaryName: "opencode"` while
  `toolName` stays `"zai"`.
- **No single config-dir override — CONFIRMED from source
  (`packages/core/src/global.ts`)**: opencode follows the XDG base-dir spec
  directly via the `xdg-basedir` npm package: config under
  `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`; overridable
  instead by the bespoke `OPENCODE_CONFIG_DIR`, which fully replaces just the
  config lookup), but **auth/credentials** (`auth.json`, confirmed on disk at
  `~/.local/share/opencode/auth.json`, mode 0600, immediately after the
  user's own real login) under `$XDG_DATA_HOME/opencode` — a DIFFERENT root,
  independent of the config dir — and cache/state under
  `$XDG_CACHE_HOME`/`$XDG_STATE_HOME` respectively. Full identity isolation
  therefore needs FOUR env vars, not one. Resolved by pointing envVarName
  (`OPENCODE_CONFIG_DIR`, the bespoke one — used as resolve.ts step (b)'s
  "already resolved" signal, same as every other tool's primary var) AND
  `extraEnvVarNames` (`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`) at
  the SAME identity `configDir` value, so config/auth/cache/state for one
  identity all land together under `<configDir>/opencode/` (opencode itself
  always appends that `/opencode` suffix to each XDG var — this one level of
  extra nesting isn't something this project's own code controls) — matching
  every other tool's "one directory = one identity, holds everything" shape
  rather than fragmenting one identity's data across up to four physical
  roots. `run-wrapper.ts` and `launch-desktop.ts` both now mirror
  `extraEnvVarNames` alongside the primary var wherever they inject env —
  every other tool's `extraEnvVarNames` is simply absent, so this is a no-op
  for them.
- **Trade-off accepted, not fully solved**: `XDG_CONFIG_HOME` etc. are
  generic, standards-based env vars plenty of unrelated XDG-aware CLIs read
  too — unlike `KIMI_CODE_HOME`/`GROK_HOME`, a user is somewhat more likely to
  already have one of these set globally for unrelated reasons, which
  resolve.ts step (b) would then (mis)treat as "the zai identity is already
  resolved." This risk is inherent to opencode's own design (no bespoke
  override covers auth/data at all) and isn't something this project's
  wrapper code can close — noted here so it isn't rediscovered as a surprise.
- **Auth — CONFIRMED live**: canonical command is `opencode auth login`
  (`providers login` is the real subcommand; `auth` is a registered top-level
  alias) — interactive only (clack-style prompts for provider then
  key/OAuth), no way to script it non-interactively via flags alone. There is
  no way to preconfigure the ZAI provider from outside opencode's own login
  flow — **the user must run `zai --identity=<name> auth login` (or the
  underlying `opencode auth login` with the right env already set) for EACH
  identity themselves**; this project can wire up the identity/env-var
  plumbing but cannot complete an interactive credential prompt on the user's
  behalf.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): `opencode run [message..]` ("run opencode with a
  message" — opencode `--help`) is the analog of claude's `-p`/codex's
  `exec`/grok's `agent`/kimi's `-p`; `opencode acp` (its own Agent Client
  Protocol server) is the analog of kimi's `acp`. Opencode has no top-level
  `-p`/`--prompt` shorthand outside the `run` subcommand itself — confirmed
  via live `--help`.
- **`SESSION_MARKER_PATTERN` (`src/shared/exec.ts`) strips
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`/`OPENCODE_CLIENT`
  narrowly** (not a blanket `OPENCODE_*` prefix, which would also needlessly
  catch the legitimate `OPENCODE_CONFIG_DIR`/`XDG_*` vars this project itself
  injects — though those get re-applied via `extraEnv` after the strip
  anyway, so a blanket prefix would have been harmless, just needlessly
  wide). Per `anomalyco/opencode` GitHub issue #14532: the opencode desktop
  app sets these three on its own spawned processes for its internal server's
  Basic Auth, and a nested `opencode run` inheriting them enforces auth on
  requests its own client never sends, failing silently — the same
  nested-invocation failure shape as claude/codex's own markers, but (like
  grok's, unlike kimi's) NOT independently reproduced by hand here, only
  sourced from the linked issue.
- **`--id`/`--identity` collision check**: opencode's own `-i`/`--interactive`
  is scoped to the `run` subcommand only, not top-level, so it can't collide
  with our `--id`.
- **Self-updater is `opencode upgrade [target]`, NOT `update`** — confirmed
  live (`opencode update --help` silently falls through to the default TUI
  entrypoint instead of erroring, i.e. "update" isn't recognized as a
  subcommand at all). This broke `upgrade.ts`'s historical assumption that
  every wrapped tool's self-updater is invoked with a literal `"update"` arg.
- **Desktop app**: unlike grok/kimi (confirmed absent), a real `OpenCode.app`
  DOES exist as a Homebrew cask (`opencode-desktop`, artifact `OpenCode.app`)
  — but it wasn't installed on this machine, so `--desktop` for zai is wired
  up structurally (same generic path, appName `"OpenCode"`) but UNVERIFIED
  both on whether the Mach-O binary name inside the bundle actually matches
  and on whether the app respects the injected env vars at all.
- **Resume/doctor support still absent; limits added 2026-09-03**: opencode's
  session storage is a SQLite db (`opencode.db`, confirmed on disk), not the
  JSONL/log formats every existing `resume` reader parses, and it has no
  doctor probe — both remain out of scope. `resume/collect.ts`'s `READERS`
  and `doctor/collect.ts`'s `PROBES` being `Partial` records is precisely so
  a tool can exist in the identities registry before its own
  reader/probe does, degrading to an honest "not implemented yet" result
  instead of a crash. Likewise `ais usage`'s tokscale integration (see the
  design decision above) reports "not supported" for a tool without a
  tokscale client rather than crashing.
- **Limits support, added 2026-09-03**: opencode's auth.json (under the
  identity's own `data/opencode/`) holds one static API credential per
  upstream plan, and the `zai_coding_plan` key is the SAME Z.ai account the
  zai tool queries, so `ais limits` reuses the same quota endpoint
  (`fetchZaiQuotaForKey`). `alibaba_token_plan` is skipped as native-covered
  (the Token plan has no API-key quota endpoint — only ali's console-cookie
  path can answer), and unknown provider ids are ignored rather than guessed
  at. See "provider-first limits for the multi-provider clients" below.
- **No migrate support**: `~/.zai` starts empty, same stance as grok/kimi —
  there's no pre-existing "default" opencode login worth preserving under an
  identity, so `scripts/migrate.ts` was not extended. First identity via
  `ais identities create --tool=zai` or the interactive picker.
- **Ships on every platform** (like grok/kimi, not darwin-gated like
  `open`): `scripts/build.ts`, `scripts/install.ts` (`BINARIES` +
  `backupGroups`), `scripts/backup.ts` (`BACKUP_GROUPS.zai: [".zai"]`),
  `src/installer.ts`'s `TOOLS`, `src/cli/update.ts`'s `MANAGED_BINARIES`, and
  `.github/workflows/release.yml` all include zai. New source files:
  `src/zai.ts` (entrypoint, `runWrapper(ZAI_CONFIG, "OpenCode")`);
  string-literal unions widened across `src/identities/types.ts`,
  `src/shared/{cli-args,resolve-binary,run-wrapper,launch-desktop,exec}.ts`,
  `src/open.ts`, `src/cli/{identities/resolve-tool.ts,update.ts,upgrade.ts,
  usage/*,limits/{types,collect}.ts,resume/{types,collect}.ts}`,
  `src/cli/help.ts`.
- **Chrome (Claude MCP) redirects are wired for wrapped zai sessions too** —
  `src/open.ts`'s `TOOL_CONFIGS` includes `ZAI_CONFIG` — under the SAME
  still-unverified assumptions documented in "Chrome profile per identity"
  below. Never tested for zai/opencode at all (opencode's own login flow
  wasn't driven through this project's `open` shim during this pass — the
  user authenticated directly against opencode's global default location
  before this project's per-identity redirection existed).

### zai case study, take 2 (2026-07-17) — RETIRED same day, kept for the "why"

**Superseded by "zai case study, take 3" below, later the same day.** Everything
in this subsection describes the SECOND design (`zai` proxies `claude`,
redirected via `ANTHROPIC_BASE_URL`) and is no longer how the code works —
kept only so the reasoning that led to it, and the reasoning that overturned
it, aren't lost. If you're looking for how `zai` actually works today, skip
to take 3.

Same day as take 1 above, same afternoon even — the user asked to install
"ZCode" (a name from an earlier, wrong recommendation) and swap `opencode`
for it. Investigating that request is what actually overturned take 1's
whole premise, not a change of requirements.

- **ZCode (zcode.z.ai) turned out to be un-wrappable — CONFIRMED by directly
  reading its docs, not assumed.** It's a desktop-only Electron app (DMG
  download for macOS, "ZCode Agent"/"Goal Mode"/"Remote Control" are all GUI
  features) with NO CLI, headless mode, or scriptable API — checked its own
  "Remote Control" docs page specifically since that sounded most likely to
  expose one, and it's purely a phone-to-desktop QR-code pairing feature, not
  a terminal interface at all. This project's entire wrapper model depends on
  a real binary to shadow on `PATH` and `Bun.spawn` — there is nothing here to
  wrap. (The earlier recommendation that called ZCode "Z.ai's own first-party
  CLI" was wrong — inferred from a search snippet by analogy to Cline/Roo
  Code/OpenCode, never actually verified before being stated. Worth naming
  plainly: it was a real mistake, not a data change, and got caught only
  because the user pushed back on the contradiction.)
- **`@z_ai/coding-helper` (npm, bin `chelper`/`coding-helper`) is Z.ai's
  actual official terminal integration — CONFIRMED by reading its source
  directly** (`dist/lib/claude-code-manager.js` in the published package,
  fetched via `bunx --bun @z_ai/coding-helper@latest`, then located in
  `~/.bun/install/cache/@z_ai/coding-helper@.../dist/`). It is NOT an agent
  CLI — `chelper --help` shows `auth`/`doctor`/`enter`/`init`/`lang`, and its
  own examples include `chelper enter claude-code` ("Interactive Configure
  Claude Code tool") and `chelper auth reload claude` ("Reload plan config to
  Claude Code"). Its entire purpose is configuring OTHER tools — specifically
  the REAL Claude Code CLI — to talk to Z.ai, confirming Z.ai's GLM Coding
  Plan ships an Anthropic-compatible endpoint
  (`https://api.z.ai/api/anthropic`) specifically so Claude Code works as a
  drop-in client with zero code changes on Anthropic's or Claude Code's side.
  This is the same "claude + `ANTHROPIC_BASE_URL`" path independently
  identified (but not yet implemented) before take 1 was ever built — chelper
  is just Z.ai's own official tool for doing that configuration, not a
  reason to build something new.
- **`chelper` writes exactly this, confirmed from source
  (`ClaudeCodeManager.loadGLMConfig`)**: merges into
  `<home>/.claude/settings.json`'s `env` block —
  `ANTHROPIC_AUTH_TOKEN` (the Z.ai API key), `ANTHROPIC_BASE_URL`
  (`https://api.z.ai/api/anthropic` for the global plan, `https://open.bigmodel.cn/api/anthropic`
  for the China plan), `API_TIMEOUT_MS: '3000000'`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1` — and separately ensures
  `<home>/.claude.json` (note: NOT inside the `.claude/` directory — a
  sibling file) has `hasCompletedOnboarding: true`, to skip Claude Code's
  first-run onboarding wizard.
- **`chelper` hardcodes `homedir()` for both paths — CONFIRMED from source
  (`join(homedir(), '.claude', 'settings.json')` /
  `join(homedir(), '.claude.json')`, no env-var override anywhere) — so it
  can't be pointed at a specific identity's directory directly.** Running it
  naively would always write to the REAL top-level `~/.claude` container
  (which this project deliberately keeps generic/unused — see "Disk
  layout"), not any identity. Rather than fighting this (e.g. faking `HOME`
  when spawning it, which would need a `.claude`-subdirectory-under-fake-home
  shape that doesn't match how this project's identity dirs are laid out —
  they ARE the CLAUDE_CONFIG_DIR directly, no extra nesting), this project
  just writes the same two files itself, directly into each zai identity's
  own `configDir` — reusing the exact shape chelper's source revealed, not
  guessed at. `chelper` remains useful as a REFERENCE and for the user's own
  ad-hoc use outside this project, just not as something this project's code
  shells out to.
- **Confirmed Claude Code itself (not just this project's convention)
  redirects BOTH files under `CLAUDE_CONFIG_DIR`** — inspected a real,
  already-in-use claude identity directory
  (`~/.claude/identities/identity-a/`) and found both `settings.json` and
  `.claude.json` living directly there, side by side. This is why zai's
  identity dirs can hold the same two files at the same top level and have
  the real `claude` binary read them correctly once `CLAUDE_CONFIG_DIR`
  points there — nothing project-specific needed beyond what already existed
  for every other claude identity.
- **New `ZAI_CONFIG` shape**: `realBinaryName: "claude"` (not `"opencode"`),
  `envVarName: "ZAI_CONFIG_DIR"` (a bespoke, otherwise-unused var — see next
  bullet for why it can't just be `CLAUDE_CONFIG_DIR`), `extraEnvVarNames:
  ["CLAUDE_CONFIG_DIR"]` (the actual var the real `claude` binary reads).
  `extraEnvVarNames` — built for take 1's XDG multi-var need — turned out to
  be exactly the right mechanism for a completely different reason here, so
  it stayed in `ToolConfig` rather than being removed once take 1's original
  use for it went away.
- **Why `envVarName` can't just be `CLAUDE_CONFIG_DIR` even though the real
  binary IS claude**: `src/open.ts`'s `resolveActiveChromeMcpTarget` picks
  which `ToolConfig` is active by
  `TOOL_CONFIGS.find((cfg) => process.env[cfg.envVarName])` — if `ZAI_CONFIG`
  and `CLAUDE_CONFIG` shared the literal same `envVarName`, this always
  matches `CLAUDE_CONFIG` first (it's earlier in the array), unable to tell a
  zai identity apart from a plain claude one. Giving zai its OWN envVarName,
  with the real var mirrored via `extraEnvVarNames` instead, keeps this
  lookup — and resolve.ts step (b)'s "already resolved" check — unambiguous
  for both ToolConfigs despite sharing a real binary. This is a genuinely NEW
  class of collision take 1 never had (opencode's env vars never overlapped
  with any other tool's).
- **Non-interactive detection, `SESSION_MARKER_PATTERN`, `--desktop`, and
  self-update all collapsed back to "identical to claude"** now that the real
  binary IS claude: `detectNonInteractiveHint` merges zai into claude's own
  `-p`/`--print` branch instead of a separate opencode-flavored one;
  `SESSION_MARKER_PATTERN` no longer needs an `OPENCODE_SERVER_*` entry (the
  existing `CLAUDE` prefix already covers zai's nested-session risk, since
  it's the same binary); `--desktop` now launches `Claude.app` (same appName
  as the primary claude wrapper) instead of a nonexistent `OpenCode.app`
  attempt; and `ais upgrade`'s `WRAPPED_TOOLS` DROPPED its zai entry entirely
  rather than adding one — `CLAUDE_CONFIG`'s own entry already runs
  `claude update`, which updates the exact same binary zai uses, so a
  separate zai entry would just run the identical command twice.
- **Auth is now a one-time file write per identity, not an interactive login
  the user has to redo per identity.** Reused the SAME Z.ai API key value the
  user had already obtained (captured from `opencode`'s own `auth.json`
  before it was retired — a plain API key, not something opencode-specific,
  so it transfers directly into `ANTHROPIC_AUTH_TOKEN`) rather than asking
  the user to obtain a new one. No browser OAuth flow is involved at any
  point in this design (unlike claude's own real login) — it really is just
  an API key in a JSON file — so `src/open.ts`'s Chrome-MCP-redirect
  mechanism (built for auto-opened OAuth links) is expected to simply never
  trigger for zai sessions; left wired up anyway for consistency, not because
  it's known to matter here.
- **`~/.zai` stays its OWN registry, separate from `~/.claude`'s — an
  explicit requirement, not a default this project chose.** A user may want
  e.g. a "identity-a" identity in BOTH: one real, Anthropic-backed (via
  `claude`), one Z.ai-backed (via `zai`) — genuinely different accounts/
  billing that happen to share a project-context name. Merging zai identities
  into `~/.claude/identities.json` would make that impossible (one registry,
  one namespace, `identity-a` could only mean one thing); keeping `~/.zai`
  separate is exactly what makes both coexist.
- **opencode uninstalled** (`brew uninstall opencode`) — Homebrew's own
  autoremove then pruned its now-unneeded dependency closure too (including a
  brew-managed `node`, distinct from the `nvm`-managed one `codex` relies on
  — see the module map above), unprompted but expected default `brew
  uninstall` behavior on this machine, not something this project's tooling
  triggered. Opencode's now-orphaned GLOBAL data dirs
  (`~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode`,
  `~/.local/state/opencode`) were deliberately left alone — uninstalling a
  package doesn't imply deleting a user's data outside this project's own
  `~/.zai` tree, and nothing here depends on them being gone.
- **resume/limits/usage support for zai is STILL not implemented — but the
  reason changed, and the old reasoning (opencode's SQLite format) is no
  longer true.** Since zai's session files are now literally claude's own
  format, `ais resume --tool=zai`/tokscale's claude client could both
  technically work today via the exact same tricks already used for
  `"claude"`. Deliberately still not wired up: tokscale has no `"zai"` client
  id of its own, so the only way to surface zai's data would be under
  tokscale's OWN `"claude"` label — indistinguishably merging real
  Anthropic-billed usage with Z.ai-billed usage in one rollup, which needs to
  be a deliberate, separately-considered choice, not a reflexive add-on to
  this pass. `resume/collect.ts`'s `READERS`/`limits/collect.ts`'s
  `FETCHERS` being `Partial` records still means this degrades to an honest
  "not implemented yet" instead of a crash in the meantime.

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

