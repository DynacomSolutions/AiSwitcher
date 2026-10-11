# Codex defaults and backfill lease

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 544-565 689-705). Read before touching this area._

- **Codex user-preference defaults are local-wins; only operational limits are
  authoritative.** The shared Codex defaults projection
  (`src/shared/codex-shared-config.ts`) splits its runtime allowlist in two.
  Operational keys (`model_auto_compact_token_limit`, `tool_output_token_limit`,
  plus the permission defaults) restamp every launch as `-c` invocation
  overrides, even over identity duplicates. User preference keys (`model`,
  `model_reasoning_effort`, `service_tier`) are never sent as `-c` at all: a
  `-c` invocation overlay outranks config.toml at runtime, so any `-c` for
  those keys, even a once-per-first-run seed, made Codex reject the `/model`
  picker's save with "a higher-priority configuration layer overrides the
  saved value" (reported 2026-09-15 as "my Codex default model keeps
  reverting"; PR #44's always-authoritative projection was the original cause
  and PR #72's once-only `-c` seed was not enough). Instead the shared default
  is written into the identity's `config.toml` once, while the key is still
  unset, as an atomic prepend that leaves the file's own formatting and
  comments untouched. From the first local value onward, including one
  written by Codex itself, local wins. The non-OpenAI provider guard still
  skips `model` and `service_tier` entirely, and explicit invocation
  overrides remain last. There is deliberately no global model-setting
  command: remove a local key to re-seed it, or edit the shared
  `~/.codex/config.toml` value to change the default for identities that have
  not chosen yet.

- **Codex's 15-minute rollout-backfill lease must self-heal in the wrapper,
  but only when its SQLite owner is provably gone.** If a backfill worker
  exits before completing its index, persisted `backfill_state` can remain
  `running`. Codex replacement processes wait only
  30 seconds but refuse to reclaim that lease for 900 seconds, producing a
  repeated startup failure even though `PRAGMA quick_check` is `ok` and no
  process has the identity database open. `shared/codex-backfill.ts` runs
  after identity resolution and before every direct Codex launch (including
  `ais resume`): it checks `state_5.sqlite` plus WAL/SHM/journal sidecars with
  `lsof`, falling back to Linux `/proc` when needed. No open owner means AIS
  expires only `updated_at`; it does not delete/rebuild the database, change
  `status`, or discard `last_watermark`. The update includes the observed
  timestamp in its `WHERE` clause, so a worker that checkpoints during the
  ownership probe wins and AIS changes nothing. If ownership cannot be
  verified, AIS also changes nothing. Do not weaken any of those guards just
  to make the repair more eager — a false repair would reintroduce the
  double-backfill race Codex's lease exists to prevent.

