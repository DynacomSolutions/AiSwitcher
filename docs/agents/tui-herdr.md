# ais tui status page, herdr bridge, ais herdr

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 3317-3341 3594-3713). Read before touching this area._

### `ais tui` status page (2026-09-10)

- Tab 1 (Status) leads with an "Identity cost and limits" panel: one row per
  identity and provider, merged live from `/api/limits` + `/api/usage`. It
  follows the provider-first views rule: the tool never appears; a Pi/OpenCode
  identity contributes one row per upstream provider it actually answers for.
- Columns: IDENTITY, PROVIDER (with the limits fetch-state glyph: `●` live,
  `○` cached, `✗` unavailable), EST $, REAL $, LIMITS (worst window as a
  gauge), RESETS (the worst window's scheduled reset, plus a blocking note
  like "credits depleted" and any `manualReset.availableCount` credits),
  ERROR. The full per-window detail stays on the Limits and Usage tabs.
- The EST/REAL split is the real-vs-estimate distinction, preserved: EST $ is
  tokscale's token-estimate valuation of local token counts (never billed);
  REAL $ is provider-reported billed spend from `extraCost`/`overage`
  (`spentUsd`, or the provider's own status wording when no figure exists;
  `-` when the provider has no overage concept at all). AWS Bedrock rows
  feed the same column from the usage payload's `realCost` (Cost Explorer
  month-to-date + the enforced budget's limit, rendered `$actual/$limit`);
  only an ANSWERED query maps, so an errored real fetch never renders as a
  confirmed zero.
- Polling reuses the shared per-endpoint loops: status/processes 3s,
  limits/usage 60s (server caches 45s); `r` on the status tab refreshes all
  four sources. Scan requests use a per-endpoint client timeout (50s limits,
  70s usage) that outlasts the console's server-side scan budget, so a
  cold-cache poll is waited out rather than aborted mid-scan.

## herdr metadata bridge (2026-09-10, task-herdr-bridge)

`src/server/herdr-bridge.ts` feeds per-pane AIS limit data to herdr's
sidebar. herdr is a third-party binary: the bridge ONLY CALLS its CLI
(`herdr pane list`, `herdr pane process-info`, `herdr pane
report-metadata`) and never kills, restarts, or signals any herdr process
(killing our own timed-out CLI client spawn is the sole exception; it is
not a herdr session process).

Per cycle (default 60s, floor 15s, machine-local
`~/.ais/config/herdr-bridge.json` = `{ enabled, intervalS, categories,
push }`): run `herdr pane list`; for every pane herdr itself reports an
AGENT for, resolve `pane process-info` and read `/proc/<pid>/environ` of
the foreground group (plus the shell pid as last resort) with the exact
shared rules of the /proc scanner (`parseIdentityEnviron` in
server/processes.ts): only panes carrying `AI_PROFILE_SWITCHER_SESSION`
attribute, to the marker's identity name. Environment contents are never
logged. Limits for exactly those identities come from the SAME isolated
scan pathway the `/api/limits` route uses (`runScanIsolated("limits")`,
plus a 45s per-identity cache in the bridge).

Token contract (names are literal, `$` included, because herdr requires
custom tokens to start with `$`; pushed per pane via
`herdr pane report-metadata <pane_id> --source ais --token NAME=VALUE ...
--seq N --ttl-ms 3x-interval`):

- `$ais_identity`: identity label (the marker value).
- `$ais_session` / `$ais_week` / `$ais_month`: rounded 0-100 percent,
  omitted when the provider has no such window or the category is not in
  `config.categories` (default `["session","week"]`). When several
  providers report the same category for one identity, the MAX wins (the
  sidebar shows the window that would block).
- `$ais_limits`: compact summary of whichever configured categories have
  data, e.g. `s:18% w:42%`.
- A pane whose identity has NO window data gets NO tokens at all (herdr
  elides empty tokens); its previous tokens expire via the TTL, so stale
  panes clear themselves.

State machine (GET /api/herdr-bridge, WebUI dashboard card): `disabled`
(config off; the scheduler still answers) / `idle` (herdr not running;
retried every cycle) / `pending` (herdr lacks `pane report-metadata`) /
`active` (pushes happen). Capability detection is BEHAVIOURAL, never
version parsing: a `herdr pane report-metadata --help` probe classifies
supported vs pending. While pending the probe re-runs every cycle, so
upgrading herdr flips the bridge to active automatically within one
interval, zero config change and no daemon restart. If a real push fails
in an unsupported shape, the bridge drops to pending once (then stays
active-with-error instead of oscillating). Observed live 2026-09-10: this
machine's herdr 0.8.2 build ALREADY ships `pane report-metadata` (the
sidebar tokens work landed before the 0.9.0 version bump), so a fresh
bridge lands in `active`, not `pending`; the pending path remains for
older builds. `push: false` in the machine config suppresses the writes
only (attribution, limits and probe still run); `AIS_HERDR_BRIDGE=0`
removes the scheduler entirely.

## `ais herdr` wrapper (2026-09-11, task-ais-herdr-wrapper)

`src/cli/herdr.ts` + `apps/tui/src/overview.rs` implement the user-facing
wrapper: `ais herdr` opens a dedicated `ais-herdr` tmux session with the
REAL herdr client on the LEFT pane and `aistui --overview` on the RIGHT
pane, landing focus on herdr. The overview is a MODE of aistui (same
binary, `--overview` argv flag), not a second binary: a compact,
width-responsive single screen (per identity: estimated cost, session/week
(/month) limit bars, next reset, spend-guard breach marker) that highlights
the identities whose herdr panes are open on the left, driven by
`/api/herdr-bridge` (`agent` + the `focused` flag herdr itself reports; the
focused pane's identity gets the strongest marker).

- **herdr is never bundled, vendored, or installed by ais.** The wrapper
  only LOCATES the user's own binary through `resolveHerdrBinary()`
  (shared/herdr-bin.ts: AIS_HERDR_BIN override > PATH > ~/.local/bin/herdr)
  and executes it; a missing herdr is a clear error pointing at
  `ais upgrade`, which (see below) upgrades herdr only when herdr is
  already installed. herdr updates therefore stay fully independent.
- **Session semantics.** `ais-herdr` exists -> attach (never duplicate);
  `--new` kills and recreates; `--panel-width=N` (16..80, default 42)
  sizes the right pane via `split-window -l`; `--panel-cmd=<cmd>` replaces
  the panel command for power users; `--raw` execs plain herdr with no
  wrapper at all; `--tmux-socket=<name>` / `AIS_TMUX_SOCKET` runs the whole
  thing on an isolated tmux server (how the live verification below ran
  without touching the user's session); stdin that is not a TTY creates
  the session detached and prints the attach command instead of attaching
  (scripting/headless use).
- **Nesting guard.** Running tmux inside a herdr pane (herdr panes carry
  `HERDR_*` env vars, verified live: HERDR_PANE_ID, HERDR_WORKSPACE_ID)
  or inside another tmux (`TMUX`) is refused with a `--force` escape
  hatch; nested pane-managers are a foot-gun.
- **Honest failure display.** The window sets `remain-on-exit on`, so a
  dead herdr client (e.g. `--remote` against a host without herdr) keeps
  its last output visible instead of vanishing with the pane.
- **Console credentials never touch argv.** AIS_CONSOLE_URL /
  AIS_CONSOLE_TOKEN reach the right pane through `tmux set-environment`
  (session env, inherited by panes spawned afterwards), the same
  never-print-the-token discipline as everywhere else.
- **Remote mode.** `--remote=<ssh-target>` runs `herdr --remote <target>`
  on the left (herdr's own documented form, verified against 0.8.2). The
  right panel then defaults to LOCAL ais data with
  `AIS_OVERVIEW_BRIDGE=off`: the local bridge describes LOCAL panes, which
  are not the ones on screen, so highlighting from it would be fabricated.
  `--remote-ais` additionally mirrors the remote machine's console: the
  hidden `ais __herdr_panel --remote=<target>` subcommand (running INSIDE
  the right pane, so the tunnel's lifetime is exactly the pane's) reads
  the remote's `~/.ais/web/server.json` over ssh (BatchMode + strict host
  key checking, same discipline as sync), starts `ssh -N -L
  127.0.0.1:<free>:127.0.0.1:<remote-port>`, verifies the tunnelled
  console answers, and execs `aistui --overview` against it with the
  remote token. ANY failure (no server.json, ssh refused, tunnel dead)
  tears the tunnel down and falls back to the LOCAL console with
  AIS_OVERVIEW_NOTE explaining it - the panel never fakes a remote view,
  and the bridge stays off in that case for the same
  wrong-highlight-source reason as above.
- **`ais upgrade` herdr row.** `UpgradeDeps.herdrBinary()` (the same
  shared resolver) decides whether a `herdr` row exists at all: absent
  binary -> no row, no install. Present -> the row runs the native
  `herdr update` (captured output like every other installer child;
  herdr 0.8.2's updater has no --yes-style flag and does not prompt) with
  `--version` captured before/after, reporting "already X" / "X -> Y" /
  a generic "updated" when versions cannot be read. It joins the
  existing parallel status list, its failures surface through the same
  onFailure report path, and it counts into the same summary.

