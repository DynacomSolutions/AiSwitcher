# Claude swap pools

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3260-3285). Read before touching this area._

### Claude swap pools (2026-10-09, task claude-swap-pool)

Opt-in credential swap, kept out of every normal launch path. `Identity.swapPool
{accounts, active?, disallowed?, auto?, thresholdPercent?}` (registries stay
version 1; sync merge in `src/sync/registry.ts` unions `accounts`, primary wins
the rest) marks a claude identity as a pool: its configDir is the one shared
Claude folder, and members (other claude identities) keep their own configDir
as the per-account vault. Modules: `identities/swap-pool.ts` (pure helpers and
member validation), `claude-swap-lock.ts` (Claude Code's mkdir locks),
`claude-swap.ts` (write-back, credential and `oauthAccount` copy, ledger at
`~/.ais/state/claude-swap.jsonl`), `claude-usage-api.ts` (one
`GET /api/oauth/usage` per member), `claude-swap-ops.ts` (headroom choice,
`swapIfLimited` with a ledger-based 10 min cooldown), `claude-swap-launch.ts`
(4s bounded shim pre-launch check), `claude-swap-hook.ts` (optional
StopFailure/rate_limit hook), `server/claude-swap-auto.ts` (daemon poll,
AIS_CLAUDE_SWAP=0 opts out, `GET /api/claude-swap`), `cli/claude-swap/`.
Refresh integration: `oauth-refresh.ts` treats the pool's `.credentials.json`
as another store of the ACTIVE member's grant (write-through, freshest pick,
converge) and never refreshes the pool identity itself, so the rotating
refresh token never forks. Usage attribution: the pool is its own row in
`ais usage` (tokscale scans by configDir); `ais claude-swap usage` attributes
each transcript message to the member active at its timestamp per the ledger
(approximate: one active member per pool at any instant). Missing oauthAccount
on a member leaves the pool's previous one in place with a note; an
unattributable live pool grant is never destroyed (a 0600 `.pre-swap.bak` is
kept).


### Provider-neutral core and adapters (task provider-pools)

The pool logic is split into a provider-neutral core in `src/identities/pool/`
and per-tool adapters. Core: `swap-pool.ts` (registry helpers, moved from
`identities/swap-pool.ts`, which re-exports), `ledger.ts` (per-tool JSONL
`~/.ais/state/<tool>-swap.jsonl`; claude stays exactly `claude-swap.jsonl`),
`swap.ts` (`performPoolSwap`: validate, adapter swap, persist `active`, ledger),
`ops.ts` (`chooseBest`, `swapIfLimited`, 10 min cooldown, `poolStatus`,
`swapToNext`), `launch.ts` (`poolLaunchCheck`), `scheduler.ts`
(`PoolSwapScheduler`: daemon loop over every registered adapter's registry),
`registry.ts` (`adapterFor(tool)`, `allAdapters()`). An adapter
(`pool/adapter.ts` `PoolAdapter`) supplies only `tool`, `config`, `liveSwap`,
`hasCredentials`, `swapCredentials` (write-back plus atomic copy) and
`fetchUsage`. `pool/claude-adapter.ts` wraps the existing `claude-swap.ts` I/O;
`claude-swap-ops.ts`, `claude-swap-launch.ts` and `server/claude-swap-auto.ts`
remain as thin Claude bindings so callers and tests are unchanged. The shim
(`shared/run-wrapper.ts`) and the daemon (`server/serve.ts`) go through the
core; `AIS_CLAUDE_SWAP=0` drops claude and `AIS_POOL_SWAP_<TOOL>=0` drops any
other tool from the daemon loop. No other adapter exists yet.
