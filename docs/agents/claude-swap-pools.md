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


### Codex adapter and `liveSwap: false` (tasks 43 and 44)

`pool/codex-adapter.ts` (registered in `pool/registry.ts`) pools Codex
identities. The pool is a codex identity with `swapPool`; its configDir is the
shared `CODEX_HOME`; members are other codex identities (ChatGPT logins only,
see `codexMemberProblem`: API-key, Bedrock and logged-out identities are
rejected) whose own `auth.json` is the per-account vault. Helpers for the file
shape are in `identities/codex-auth.ts`. The account is `tokens.account_id`
cross-checked with the `https://api.openai.com/auth`.chatgpt_account_id claim
of the access token (id token as fallback); when both exist and differ the file
is "hybrid" and is never trusted or attributed.

Why `liveSwap: false` (Codex 0.145.0 source): `auth.json` is loaded once at
startup and cached; it is reloaded only on a proactive refresh or a 401. A
refresh first checks the file's account and fails permanently ("account
mismatch") if it is another account; the 401 path skips that guard; the
refreshed tokens are persisted over the file with no account check and no
cross-process lock; writes truncate in place (readers can see empty or partial
files); the `chatgpt-account-id` header comes from memory. A running session
therefore cannot follow a swap and must relaunch or `codex resume`.

Policy (owner decision): swap anyway. Auto swap only fires when the active
account is at its limit, so those sessions are stuck regardless; new launches
get the new account. The core calls the optional `notifySwapped(pool, from, to)`
after the ledger append (non-fatal); the Codex one counts running codex
processes whose `CODEX_HOME` is the pool dir (`/proc/<pid>/environ`, own user,
never kills anything), logs `codex-swap: account swapped to X; relaunch or
"codex resume" in N running sessions`, and returns `{sessions}`, which
`performPoolSwap` puts on `SwapResult.runningSessions` for the manual-swap
warning (the CLI side is task 45).

Swap (`swapCredentials`, under the pool lock and the pool dir's
`.oauth_refresh.lock`): write the pool grant back to the member whose vault
holds the SAME account id when its `last_refresh` (else token iat/exp) is newer,
never to another account; an unattributable or hybrid pool file is kept as a
0600 `auth.json.pre-swap.bak`; the target's `auth.json` is written atomically
(0600, temp plus rename, all its keys kept), then re-read and verified by
account id (restored on mismatch).

Heal (`heal(pool, members)`, optional adapter hook; the scheduler calls it every
tick for `liveSwap: false` adapters, before the swap check, even with auto off,
under the pool lock): after one re-read 200 ms later (a writer may be
mid-truncate) it restores the active member's vault into the pool when the file
is empty, partial, unparsable or token-less; when it holds another account it
captures those tokens into the member that owns the account if newer (else a
0600 `auth.json.pre-heal.bak` for a non-member) and restores the active one;
a hybrid file gets a `.pre-heal.bak` and is restored. A refresh-during-swap
race (the old session rewrites A's newer tokens after a swap to B) ends with A's
vault updated and B restored.

Core changes that came with it: `performPoolSwap` holds a pool-level lock
(`pool/lock.ts`, `<poolDir>/.ais-pool.lock`, taken before any provider lock)
across registry re-read, guard (cooldown and "active unchanged" re-check from
`swapIfLimited`), credential swap, `active` persist and ledger append, so two
concurrent swappers produce one ledger event. Scheduler deps are keyed per tool
(`perTool`). `oauth-refresh.ts` gates pool behaviour on `adapterFor(tool)`: the
pool identity is never refreshed (outcome `no-grant`, "refreshed through that
member"), and a member's refresh writes through to the pool copy only while that
member is active and the pool holds the same account (`poolRegistryPath` is the
test hook; `claudeRegistryPath` stays the claude alias). Daemon opt-out for
codex: `AIS_POOL_SWAP_CODEX=0`.


### CLI and surfaces (task 45)

`ais swap <tool> status|to|next|allow|disallow|auto|usage|pool create|hook`
lives in `src/cli/swap/dispatch.ts` (`runSwapCommand(tool, ...)`, driven by
`adapterFor(tool)`); `ais claude-swap` is `runClaudeSwapCommand`, the same
function bound to claude (same output, flags, exit codes). `hook` is
Claude-only. Codex `to`/`next` print `SwapResult.runningSessions`; codex
`pool create` validates members with `codexMemberProblem`. `usage` goes
through `claude-swap/attribution.ts` `poolMemberUsageSplit(..., {tool})`:
claude reads `projects/`, codex reads `sessions/**/rollout-*.jsonl`
`token_count` events; both attribute by `activeMemberAt` on the tool's ledger.
`ais limits` mirrors a pool row to its active member of the SAME tool.
