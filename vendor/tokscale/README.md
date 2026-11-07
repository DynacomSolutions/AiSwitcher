# AIS-patched Tokscale

This patch targets the unmodified `junhoyeo/tokscale` v4.20.0 release archive
(commit `c1973901fc2f7ba0d134252bfd923c714cc123db`, SHA-256
`73376cdde65268d18de5d319d8cad416d3370101201284f50d573430058dc533`). The
upstream licence is preserved in `LICENSE`.

The patch adds three AIS-only surfaces:

- A successful local native parse writes a complete JSON batch atomically when
  both `TOKSCALE_AIS_EXPORT_PATH` and `TOKSCALE_AIS_PARTITION_ID` are set. The
  normal `--json` output remains the upstream report. A parse or export error
  returns failure and does not publish a batch.
- `--ais-shared-snapshot <absolute-path>` reads the authoritative AIS manifest
  and never scans raw local sources. All-time token, cost, model, provider and
  client totals come from its generation-matched `aggregateResults` report
  rows. `--json` emits that canonical rollup with `aggregateGeneratedAt`, and
  `--client` filtering is applied to those rows. Date-filtered views use only
  available native messages; undated report costs are never overlaid onto a
  date range. Sessions, projects and date-filtered cost therefore have native
  detail coverage only.

  The TUI reloads the manifest on its refresh interval and user-requested
  reloads. It verifies immutable native batch checksums and generation
  metadata, applies Tokscale's native deduplication and filters, and skips a
  missing or corrupt detail batch while keeping canonical report totals. A
  persistent coverage status gives `aggregateGeneratedAt`, names tools with
  unavailable native detail, and distinguishes all-time report totals from
  native-only detail. A missing or invalid canonical aggregate fails closed.
  The Pi client also honours AIS's existing `PI_CODING_AGENT_DIR` identity
  boundary.

- Warm scans stay incremental. A Claude subagent whose sibling `.meta.json`
  names its `agentType` never reads its parent session, so the parent is no
  longer a cache dependency of that subagent: a long-running parent session no
  longer forces every one of its subagents to be re-parsed on each scan. The
  sidecar stays watched: when it changes or is removed, the parent is probed
  and recorded again, and a subagent without a named type still follows its
  parent. With `TOKSCALE_AIS_STAT_ONLY_CACHE=1`, an exact size and
  nanosecond mtime match is a cache hit without reading the bounded content
  samples, so an unchanged transcript is only stat'ed. Appended Claude
  transcripts resume from their checkpoint and only the new bytes are parsed;
  changed files are re-parsed. Claude's retained history for deleted
  transcripts is unchanged upstream behaviour.

- Resuming an appended Claude transcript reads at most 256 KiB of its prefix
  (`patches/v4.20.0-ais-io.patch`). Upstream re-hashed the whole cached prefix
  on every resume, which re-read multi-GB live sessions on every scan. The
  checkpoint now stores a sampled digest: the prefix length, its first and
  last 64 KiB, and 32 evenly spaced 4 KiB windows between them (every byte
  of a prefix up to 256 KiB). Trade-off: an in-place edit that touches no
  sampled window, keeps the file at least as long and changes its size or
  mtime is resumed instead of re-parsed. Claude Code only appends to a session
  transcript; a rewrite through a new file, a truncation or an edit inside a
  window still forces the full parse. Checkpoints written before this change
  never match the new digest, so each growing transcript is re-parsed once.

- Codex resumes use the same sampled digest under their own domain
  (`patches/v4.20.0-ais-scope.patch`). A plain rollout's fingerprint
  `content_hash` is that digest of the whole file, so it still equals the
  incremental `prefix_hash` when everything was consumed. Upstream read a
  grown rollout whole up to three times per scan (fingerprint, prefix check,
  new fingerprint). Zstd archives keep the full hash. The trade-off is the
  Claude one above; entries written before this change are re-parsed once.

- `TOKSCALE_AIS_CACHE_SCOPE=<lowercase hex>` gives a scan its own message
  cache under `cache/source-message-cache-v2-ais-scope/<scope>/`, with the
  same 256-shard layout. Without it every per-identity export deserialized
  the whole namespace (all identities' Claude or Codex entries) and rewrote
  every shared shard one of its changed entries hashed into. A scoped
  namespace is seeded once: the first scoped scan reads the shared shards,
  records the entries it looks up plus, for Claude, every entry under its
  scan roots (so retained history of deleted transcripts and transcripts the
  directory walk missed are kept), writes those and its own changes to the
  scoped shards and only then publishes `.ais-scope-seeded`. Codex and the
  other namespaces carry only looked-up entries: they retain no history, so
  a missed entry is just re-parsed from the live file later. If the shared
  directory or any shared shard cannot be read, the marker is not published
  and the next scan seeds again. Before the marker the shared shards stay
  authoritative. When an interrupted seed left a scoped copy, the copy with
  the newer source fingerprint wins and absorbs the other's retained
  history; for a deleted source the copy that retains history wins. The
  shared shards are never written by a scoped scan. Invalid values are
  ignored (the scan stays unscoped).

- The export envelope carries `messagesSha256`, the SHA-256 of its `messages`
  array as written. When AIS passes the digest of the batch it already holds
  in `TOKSCALE_AIS_PREVIOUS_MESSAGES_SHA256` and the messages are identical,
  the exporter writes a small `{"unchanged": true, "messagesSha256": ...}`
  envelope (no `complete`, no `messages`, so no batch reader accepts it)
  instead of a second copy of the batch. The `--json` report is printed as
  usual.

- `TOKSCALE_AIS_SEGMENT_DIR=<absolute dir>` makes a changed export segmented
  (`patches/v4.20.0-ais-segments.patch`). The `messages` array is cut into
  contiguous segments, each a JSON array of whole messages stored as
  `<sha256>.json` in that directory, and the export path receives a small
  manifest instead of the batch: `schemaVersion: 2`, `format:
  "ais-segmented-v1"`, `messagesSha256`, `messageCount`, the ordered
  `segments` (`sha256`, `bytes`, `messages`) and `hourly`, Tokscale's own
  hourly rollup of the messages in the export's bucket timezone (so AIS gets
  daily figures without reading the segments). Joining the segments' elements
  in order gives the single-file `messages` bytes exactly, so `messagesSha256`
  and the `unchanged` answer work across both formats. A segment ends at a
  content-defined point (a message whose FNV-1a hash falls in a window
  proportional to its size, once the segment holds 512 KiB; at most 16 MiB,
  about 2 MiB on average), so messages added to one transcript change only
  the segment around them. Segments are written atomically (temporary file,
  fsync, rename; mode 0600 in a 0700 directory) before the manifest. Only segments listed in
  `TOKSCALE_AIS_REUSABLE_SEGMENTS_FILE` (one SHA-256 per line, the ones AIS
  verified on disk) are left unwritten; every other segment is written even
  if a file of that name exists, so a damaged file is never adopted. The
  `--ais-shared-snapshot` reader recognises a segmented manifest, checks every
  segment's size, SHA-256 and message count and caches verified segments, so
  a reload reads only new ones. A damaged or missing segment makes that whole
  partition's native detail unavailable, never partial; a missing one first
  retries against a newer manifest, as a missing batch does.

The AIS adapter's per-partition capture uses `--client <tool>` plus that
identity's native parser root, clears additive extra roots and isolates
Tokscale settings. It appends `--json` to the returned client arguments and
sets the attempt-unique export path and opaque partition key, sets the
message-cache scope to a hash of the tool and the scanned source directory
(so a renamed identity keeps its cache; a scope no live source uses and no
export has used for 30 days is swept), and enables the stat-only warm cache. For default
OpenCode it points `XDG_DATA_HOME` at the exact default profile's data root.
Z.ai and Alibaba are unsupported for native batch capture and remain
explicitly outside this coverage.

Build and install the patched binary with:

```sh
bash scripts/build-tokscale-ais.sh
```

The helper downloads only the pinned release archive, verifies its checksum and
licence, applies `patches/v4.20.0-ais.patch`, `patches/v4.20.0-ais-io.patch`, `patches/v4.20.0-ais-scope.patch` and then `patches/v4.20.0-ais-segments.patch`, and installs to
`$AIS_TOKSCALE_SHARED_BIN` or `~/.ais/cache/usage/native-tokscale/tokscale`.
Pass an absolute output path as its first argument to build elsewhere. It
removes its temporary source and build tree after completion.
