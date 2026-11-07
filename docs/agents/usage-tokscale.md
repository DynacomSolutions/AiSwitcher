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
  - **bunx concurrency race (history):** several concurrent
    `bunx tokscale@latest` processes can fail with `error: Failed to link
    @tokscale/cli: EEXIST` in bunx's global `.bin` link step, even on a warm
    cache (reproduced on bun 1.3.11). Report scans worked around it first by
    serializing bunx, then by spawning the native binary bunx had cached in
    `~/.bun/install/cache/@tokscale/` after a daily `--version` warm-up.
    That machinery was removed on 2026-11-06: every report and daily figure
    now comes from the AIS-patched shared binary's native export (below), so
    no collector path runs PATH/bunx Tokscale. Passthrough execs one process,
    so the race does not arise there. Every remaining Tokscale spawn still
    goes through one process-wide slot (`withTokscaleProcessSlot`) to bound
    memory.
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

- **The usage snapshot collector runs Tokscale exactly once per source: the
  AIS-patched native export (2026-11-05).** Its daily figures (date span,
  per-day tokens and totals) used to come from a second process, an
  `hourly --client <tool> --json` via PATH/`bunx tokscale@latest`: unpatched
  upstream Tokscale with no AIS cache, no stat-only mode and none of the
  warm-scan fixes, re-reading every transcript once per identity. The
  collector now derives them from the export it already reads and validates
  (`dailyUsageFromNativeMessages`, applied in `snapshot.ts`'s
  `savePartition`), mirroring Tokscale 4.20's hourly aggregation: recovery
  daily rows and undated balances skipped, timestamp-less rows keyed by date,
  costs summed per hour in message order.
  - **Bucket timezone: the exporter's config wins.** Hours are keyed in the
    `scanner.bucketTimezone` of the `settings.json` in the TOKSCALE_CONFIG_DIR
    the exporting process ran with (carried as the batch candidate's
    `tokscaleConfigDir`, read after the run so Tokscale's own first-run pin
    is seen). That is the isolated config, not the user's default
    `~/.config/tokscale`: the exporter never reads the default, and the
    batch's own `date` fields and recovery rows were bucketed in the
    isolated zone, so any other file would contradict the batch.
  - **Zone names match chrono-tz, not Intl.** Tokscale parses the name with
    chrono-tz 0.10.4 (case-sensitive IANA names and links); anything else
    (`asia/bangkok`, `+07:00`) means local time. `tokscale-zones.ts` holds
    that crate's name list; regenerate it when the vendored Tokscale moves.
  - `test/fixtures/tokscale-native-daily` (regenerate with its
    `generate.ts` and the patched binary) pins equality with the patched
    binary's own `hourly` over duplicates, the recovery overlay and a DST
    change.

  Report scans have no PATH/bunx fallback (a missing export is an error
  row). PATH/bunx Tokscale remains only for `ais usage <tokscale args>`
  passthrough (other than `tui`).

- **Collector disk I/O: a cycle reads and writes what changed, not the
  history (2026-11-06).** Measured live before this change, a pool cycle read
  about 19 GB (mostly page cache, 1.8 GB from disk) and wrote 0.8 GB, because
  appended multi-GB Claude transcripts were read whole three times. The rules:
  - Swap-pool attribution (`claude-swap/attribution.ts`) keeps a schema-2
    cache: a small index (`<key>.v2.json`) plus one append-only hits log per
    transcript (`<key>.v2.json.d/`). An unchanged transcript is not opened, a
    grown one is read from its last newline, and only new hits are appended.
    Resume safety is a sampled check (same inode, not shorter than the
    offset, which may lie past the pre-read stat size of a file that grew
    mid-read, SHA-256 of the
    first 4 KiB and the 64 KiB before the offset); see `CachedUsageFile` for
    the trade-off. Schema-1 hits of unchanged files are adopted once.
  - Claude checkpoint resumes in the patched Tokscale verify a sampled prefix
    digest (at most 256 KiB read), not a full-prefix hash
    (`vendor/tokscale/README.md`).
  - Each committed batch records `messagesSha256` and its `bucketTimezone`.
    The next export passes the digest; identical messages come back as a
    small `unchanged` envelope, the partition keeps its batch pointer and
    daily figures, and nothing is promoted or read back. The digest is offered
    (and an `unchanged` answer accepted) only while the batch file keeps the
    size and mtime recorded at promotion.
  - Codex Bedrock partitions read their all-time rollouts through a per-file
    record cache (`usage/local-spend/`), keyed on dev, inode, size, mtime and ctime.
  - Each native export passes `TOKSCALE_AIS_CACHE_SCOPE`, a hash of the tool
    and the scanned source directory (`aisTokscaleCacheScope`), so Tokscale
    keeps one message cache per source
    (`isolated-config/cache/source-message-cache-v2-ais-scope/<scope>/`) and
    an export loads and rewrites only its own entries. Keying by directory,
    not identity name, keeps the cache across a rename; cache entries are
    keyed by absolute path, so a new directory could not reuse them anyway.
    Every scoped export stamps its scope directory's mtime; a cycle removes a
    scope only when no live source uses it and it has been idle for 30 days,
    and skips the sweep when target or pool discovery failed or a native
    tool that has identity directories has no identities registry file (a
    missing file loads as an empty list). A tool never used on the host (no
    identity directories) needs no registry. The age floor also protects a second collector that sees
    the same caches under translated paths. Measured live on 7 Nov
    2026 before this change, every Claude export read the whole 611 MB Claude
    namespace and every Codex export the 337 MB Codex one, even for an
    unchanged identity: about 8 GB of the roughly 10 GB a full round read.
    Each scope seeds itself once from the shared shards (see
    `vendor/tokscale/README.md`).
  - Codex resumes and Codex fingerprints use the sampled digest, as Claude
    checkpoints do, instead of hashing the whole rollout.
  - Native batches are segmented (`native-segments.ts`, vendor README). A
    collector export passes `TOKSCALE_AIS_SEGMENT_DIR`
    (`usage/native/<partitionId>/segments/`), so the staged export is a small
    manifest and the messages are content-addressed segments. Measured live
    before this change, the swap-pool batch (about 478 MB) was rewritten and
    read back on every changed cycle: nearly all of the collector's writes,
    about 0.66 MB/s in ~550 MB bursts. On a 119 MB fixture with three growing
    transcripts a changed cycle now writes and reads about 14 MB
    (3 of 42 segments plus a 0.4 MB manifest). The rules:
    - Promotion reads the manifest and only segments it has not verified: a
      segment recorded for the previous batch is trusted while its file keeps
      the size, mtime, ctime and inode recorded then (ctime cannot be set
      back, so damage with a restored mtime is still caught); any other is
      read and must match its size, SHA-256, message count and parse as
      message objects. Segment files are 0600 in a 0700 directory.
    - The exporter may skip writing only segments AIS lists as reusable, and
      AIS lists them only when the committed manifest and every one of its
      segments are intact. One damaged or missing segment means no list and
      no `unchanged` digest, so the next export rewrites every segment (a
      full rebuild); a manifest naming a damaged segment fails promotion and
      the prior batch stays.
    - Daily figures come from the manifest's `hourly` (Tokscale's own
      rollup), not from the messages.
    - Crash safety: segments are published before their manifest and are
      only removed by the collector's collection pass, so a cycle that dies
      leaves the committed manifest and all its segments valid.
    - Collection keeps every segment named by a retained batch (listed, the
      two latest generations, anything inside the 10-minute reader grace) and
      any unnamed segment younger than 2 hours, the staging lifetime, since an
      export in flight names its new segments only in a staged manifest; if a
      retained manifest cannot be read, nothing is removed. Exporter
      temporaries older than 2 hours go too.
    - Migration: a single-file batch stays valid and is kept while its
      messages are unchanged (the digest is the same in both formats). The
      first changed export writes a full segment set, and the single-file
      generation ages out under the usual two-generation rule. Opencode and
      Pi captures (`captureNativeBatch`) still write single-file batches.
    - Still open: the Grok reader re-reads its whole session tree (about
      0.9 GB per round) while a session is active, and a segment damaged in
      place with its size, mtime and ctime unchanged (not possible through
      ordinary writes) would be caught by the TUI reader's checksum, not by
      the collector; and the registry check cannot see identities whose
      config directory lies outside the tool's identities root.
  - Totals stay those of a cold scan: every shortcut is either exact (an
    unchanged file, an append of whole lines, byte-identical messages) or
    falls back to the full read.

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

