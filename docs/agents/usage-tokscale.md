# ais usage, tokscale and breakdown

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 763-928). Read before touching this area._

- **`ais usage` (per-identity/provider token usage via tokscale) is a new
  `ais` subcommand, not another proxy binary.** The proxy pattern
  (`claude`/`codex`/`grok`/`kimi`/`zai`/`open`) exists for tools where exactly
  one identity is active per invocation — resolve it, swap in one (or, for
  zai, a few — see "zai case study") env var(s), exec once.
  tokscale's job is the opposite shape: survey many identities/providers in
  one report, which the "resolve one identity" model can't express. `ais`
  already does this kind of cross-identity, read-only work generically
  (`ais identities list`/`show` already loop over every tool's registry), so
  `ais usage` (`src/cli/usage/`) is a small extension of that, not a new
  category of tool.
  - **Per-tool scoping:** codex/grok/kimi need
    nothing extra — tokscale itself reads `CODEX_HOME`/`GROK_HOME`/
    `KIMI_CODE_HOME`, the exact env vars this project already redirects per
    identity. claude is the odd
    one out: tokscale hardcodes `<home>/.claude/projects` with no
    `CLAUDE_CONFIG_DIR`-equivalent override anywhere in its source, so
    `tokscaleInvocationFor()` (`src/cli/usage/tokscale.ts`) instead sets
    `TOKSCALE_EXTRA_DIRS=claude:<identity's configDir>/projects` — an
    additive extra scan root tokscale supports without symlinks. Its default
    scan root remains active, so the top-level `~/.claude/projects` must be
    empty to avoid including unrelated sessions.
  - **bunx concurrency race, also found empirically, not in any doc:** when
    tokscale isn't already on `PATH` and runs via `bunx tokscale@latest`,
    firing several of those processes at once — the natural way to query N
    identities concurrently — can fail with `error: Failed to link
    @tokscale/cli: EEXIST`. A one-shot "warm the cache first, then
    parallelize" attempt did NOT fix it (reproduced the same failure on an
    already-warm cache); the race is in bunx's global `.bin` link step
    itself, not just the first-ever download — re-confirmed still
    reproducible on bun 1.3.11 (8 parallel warm invocations, 2/8 failed)
    right before the cached-binary redesign, so it is NOT something a bun upgrade
    quietly fixed. The earlier design worked around it by fully serializing
    every tokscale invocation whenever `resolveTokscaleCommand()` resolved
    to `bunx` (parallelizing only when tokscale was on `PATH`). That was
    correct but made the aggregate report crawl. The cached-binary design
    (`resolveTokscaleCachedBinary()` in `src/cli/usage/tokscale.ts`)
    avoids that race: bunx's own install
    already materializes tokscale's real per-platform native binary at
    `~/.bun/install/cache/@tokscale/cli-<os>-<arch>-<libc>@<ver>/bin/tokscale`,
    so after a one-time `bunx tokscale@latest --version` warm-up per CLI
    run (`ensureTokscaleCacheFresh()`, itself serialized through a tiny
    bunx promise-queue since it IS a bunx call), every actual scan spawn
    goes DIRECTLY at that cached binary (`runTokscaleProcess`) — no bunx,
    no `.bin` link step, and no bunx link race. Independently, every
    tokscale invocation is serialized through a process-wide slot so native
    scans and bunx fallback cannot fan out memory use across targets.
    Candidates are probed for actual executability
    (`spawnSync --version`) not just file existence, so a wrong-libc or
    corrupt cache entry falls through to the next variant or ultimately to
    the old serialized-bunx fallback; the resolution result is memoized
    per process. If tokscale's own bunx/npm packaging changes its cache
    layout later, re-verify `findCachedTokscaleBinary` still finds the
    real binary before trusting the cached-binary path.
  - tokscale is deliberately not a `package.json` dependency of this project
    (see `resolveTokscaleCommand()`) — it ships heavy platform-specific
    native optional-deps that don't belong bundled into a thin-wrapper
    project's own install; `Bun.which("tokscale")` first, `bunx` on demand
    otherwise.
  - **The aggregate report alone wasn't "full tokscale capability"** — the
    first cut only exposed the JSON summary table, not the TUI/`graph`/
    `monthly`/`hourly`/`pricing`/`report`/`wrapped`/social commands tokscale
    actually has. Fixed by adding `ais usage [--identity=] [--tool=]
    <tokscale args>` passthrough (`src/cli/usage/passthrough.ts`), which
    `execReal`s the real tokscale process with full stdio inheritance (so the
    interactive TUI's raw-mode terminal handling works) instead of capturing
    stdout for JSON parsing. Scoped to exactly one identity when `--identity=`
    is given (an interactive/streaming invocation can't run once per identity
    and merge results the way the JSON report can; ambiguous `--identity`
    matches require `--tool=` to disambiguate, same rule as
    `resolveMutationTarget`) — see the next two bullets for what "unscoped"
    actually means and why a literal `--` turned out not to be required.
  - **"--identity omitted" must NOT mean "no env injection at all" — that
    was the first cut and it was wrong.** tokscale's own bare defaults
    resolve to this project's top-level `~/.claude`/`~/.codex`/`~/.grok`/
    `~/.kimi-code` containers, which are deliberately empty of real session
    data (every real identity's data lives one level down, in
    `identities/<name>/` — see
    "Disk layout"). An unscoped passthrough with no env injection therefore
    showed next to nothing, defeating the entire point of "show me
    everything" commands like `tui`. Fixed by merging every configured
    identity (optionally narrowed by `--tool=`) into one `TOKSCALE_EXTRA_DIRS`
    value (`buildMergedExtraDirs()` in `src/cli/usage/tokscale.ts`) and
    running a single tokscale process — confirmed empirically that
    `TOKSCALE_EXTRA_DIRS` accepts multiple comma-separated entries, including
    several for the same client id, and that a merged value surfaces every
    identity/provider's data simultaneously with correct per-client totals.
    Building an extra-dir entry needs the SAME final relative path tokscale's
    own env-var resolution appends (`.../projects` for claude, `.../sessions`
    for codex, grok, and kimi — see `EXTRA_DIR_RELATIVE`), not just the
    identity's bare `configDir`. One real limitation this doesn't solve:
    tokscale itself has no "identity"/"account" concept for claude, grok, or
    kimi (only client/model/workspace/session) — merging several identities'
    data means
    tokscale sees one undifferentiated pool of e.g. claude sessions, not
    N separate accounts. `--group-by workspace,model` is the closest
    tokscale-native approximation (each identity's projects tend to live
    under distinct directories) but it's a correlation, not a first-class
    field — don't oversell this as true per-account breakdown in future docs.
  - **A literal `--` before the tokscale args turned out not to be required
    — first cut demanded it, second pass removed that friction.**
    `splitPassthroughArgs()` (`src/cli/usage/dispatch.ts`) now triggers
    passthrough on either an explicit `--` OR the first token that isn't one
    of `ais usage`'s own recognized flags (`identity`, `tool`, `json`) —
    whether that's a bare tokscale subcommand (`tui`, `monthly`) or one of
    tokscale's own flags (`--group-by`, `--client`). Deliberately does NOT
    just split on "the first bare positional token": a tokscale flag that
    takes a space-separated value (`--group-by workspace,model`) has its
    VALUE as a bare token, and treating that value as "the start of a
    subcommand" would silently produce a broken command — the fix instead
    checks the FLAG NAME against a small fixed whitelist of `ais`'s own three
    flags, so any `--xxx` we don't recognize (regardless of what follows it)
    immediately starts passthrough, not just bare words. `--` is still fully
    supported for `ais usage -- --json` (tokscale's own `--json` flag,
    distinct from ais's own `--json` aggregate-mode flag, which would
    otherwise win by default when typed bare).
  - **zai has no tokscale integration at all.** Its real binary, `crush`
    (github.com/charmbracelet/crush), has an as-yet-uninvestigated
    session-storage format, and tokscale (github.com/junhoyeo/tokscale, a
    third-party project) has no `"zai"`/`"crush"` client id of its own
    regardless — not a gap this project's own env-var-mapping trick can
    close the way it did for claude. `tokscaleInvocationFor()`
    returns `undefined` for `"zai"` and every caller (`run.ts`'s `runOne`,
    `passthrough.ts`) reports "not supported" for that target instead of
    crashing; `buildMergedExtraDirs()` silently drops zai targets from the
    merged `TOKSCALE_EXTRA_DIRS` value rather than erroring the whole
    unscoped passthrough over one unsupported tool.
  - **`--client` must come AFTER the tokscale subcommand, not before —
    confirmed by direct testing, undocumented in tokscale itself.**
    `tokscale --client claude models` silently ignores the filter (every
    other clients' data can leak into the report);
    `tokscale models --client claude` scopes correctly. Root-level
    invocations with no subcommand accept either order fine. So
    `runPassthrough()` always appends `clientArgs` (`--client <tool>`) AFTER
    the caller's own tokscale args, never before — the exact inverse of what
    would seem natural, and easy to get wrong again if this ever gets
    refactored without re-reading why.

- **`ais usage breakdown` answers WHAT consumed the tokens, per tool call
  (2026-09-10).** tokscale aggregates per model; breakdown.ts
  (`src/cli/usage/breakdown.ts`) re-reads the same local logs one level
  deeper: built-in tool calls, MCP servers rolled up to `mcp:<server>` with
  per-tool detail, edit/write tools grouped as kind "edit", and a
  "conversation" row. Only claude and codex have readers (their logs carry
  both per-turn token usage and tool-call names); every other tool answers
  an explicit `unavailable` reason (grok's history names calls but has zero
  usage fields; kimi/Crush/pi/opencode store message or session totals
  without per-call attribution) — never fabricated rows. **The attribution
  rule is one convention and must stay consistent:** prompt-side tokens
  (input + cache read + cache write) price the turn's context, so they
  always land on the conversation row; output tokens split EVENLY across
  the turn's tool calls (claude: the message's `tool_use` blocks; codex:
  the response items buffered per `turn_context`), and a turn with no calls
  keeps its output on conversation. The logs simply do not record per-call
  usage, so this is a heuristic and every surface labels it an estimate:
  costs use CHAT_MODEL_PRICES (models.dev list rates,
  identities/model-pricing.ts) under the same estimate-only convention as
  the report's EST. COST, unpriced models are listed in `notes`, and
  nothing is ever presented as real billed spend. Scans stream line by line
  with the spend-guard's file pruning (listRecentFiles), run in the
  isolated scan worker behind `/api/usage/breakdown` (60s server cache,
  240s child ceiling; a 12GB codex store needs minutes), and the CLI is
  `ais usage breakdown [identity] [--tool=] [--days=30] [--json]`.

