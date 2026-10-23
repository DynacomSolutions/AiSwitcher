# AIS-patched Tokscale

This patch targets the unmodified `junhoyeo/tokscale` v4.20.0 release archive
(commit `c1973901fc2f7ba0d134252bfd923c714cc123db`, SHA-256
`73376cdde65268d18de5d319d8cad416d3370101201284f50d573430058dc533`). The
upstream licence is preserved in `LICENSE`.

The patch adds two AIS-only surfaces:

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

The AIS adapter's per-partition capture uses `--client <tool>` plus that
identity's native parser root, clears additive extra roots and isolates
Tokscale settings. It appends `--json` to the returned client arguments and
sets the attempt-unique export path and opaque partition key. For default
OpenCode it points `XDG_DATA_HOME` at the exact default profile's data root.
Z.ai and Alibaba are unsupported for native batch capture and remain
explicitly outside this coverage.

Build and install the patched binary with:

```sh
bash scripts/build-tokscale-ais.sh
```

The helper downloads only the pinned release archive, verifies its checksum and
licence, applies `patches/v4.20.0-ais.patch`, and installs to
`$AIS_TOKSCALE_SHARED_BIN` or `~/.ais/cache/usage/native-tokscale/tokscale`.
Pass an absolute output path as its first argument to build elsewhere. It
removes its temporary source and build tree after completion.
