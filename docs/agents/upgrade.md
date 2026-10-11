# ais upgrade

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 929-992). Read before touching this area._

- **`ais upgrade` owns a deterministic real-CLI installation for every
  installed AIS shim.** The old design blindly invoked each real binary's
  supposed `update` subcommand and skipped missing tools. An unsupported
  subcommand can be interpreted as a chat prompt, and a successful updater
  can leave an older binary selected by `PATH`. Neither proves an upgrade.
  Presence of `~/.local/bin/{claude,codex,grok,kimi,zai}` now expresses the
  intended tool set. `upgrade.ts` installs/upgrades Claude Code
  (`@anthropic-ai/claude-code`), Codex (`@openai/codex`), Kimi Code
  (`@moonshot-ai/kimi-code`), and Crush (`@charmland/crush`, the real CLI
  behind `zai`) in the user-owned `~/.ais/npm` prefix (formerly
  `~/.local/share/ais/npm` — see "~/.ais: one consolidated root" below). Grok
  uses xAI's `https://x.ai/cli/install.sh`, which writes to `~/.grok/bin`. AIS
  gives that installer a process-local PATH containing the target directory
  and clears `SHELL`, preventing it from rewriting shell startup files or
  symlinking the real binary over the shim. `resolveRealBinary()` prefers
  those locations, so the upgraded binary wins immediately over stale system
  packages. A native updater is only a fallback when the managed installer is
  unavailable or fails, and is called only after the exact subcommand is found
  as its own command line in `--help`. npm's install-script policy is
  satisfied with narrow per-tool allowlists (Claude's own package; Kimi plus
  `node-pty`; Crush's own package), never
  `--dangerously-allow-all-scripts`. This is distinct from `ais update`, which
  only refreshes this project's shim binaries. For the public npm registry,
  `upgrade.ts` resolves the small `/latest` manifest, pins npm to that exact
  version with `--prefer-online` (sent on every managed install, including the
  `@latest` fallback, so npm's cached packument can never pick yesterday's
  release) and avoids reinstalling only when the package manifest AND the
  managed binary's reported `--version` semver agree with the pinned version.
  A custom
  scoped or default npm registry never triggers a public-registry lookup.
  Exit codes are never treated as evidence on their own (verified live
  2026-09-12: `grok update` exits 0 printing "installed successfully" while
  npm's install-script policy blocked the package postinstall and the binary
  was untouched). After any install, the runner re-probes `--version` and
  parses the first semver it prints (every vendor shape: `2.1.268 (Claude
  Code)`, `codex-cli 0.154.0`, `crush version v0.93.1`, `grok 1.0.25 (sha)
  [stable]`): a manifest that did not move to the pinned version, or a binary
  on the RESOLVED path (what the shim actually execs) still reporting an older
  version than installed, turns the row into an honest FAILED with the reason
  (the latter is PATH shadowing: another install is winning, and reinstalling
  cannot fix it). Grok is checked against xAI's own stable channel
  (`https://x.ai/cli/stable`, GCS mirror fallback: the same two URLs its
  install.sh reads, and the source its updater announces updates from; npm
  knows nothing about it): when `grok update` exits 0 but the version is
  still below the channel, the row falls through to xAI's installer, and if
  the version is STILL short afterwards the row fails with "grok still
  reports X ... channel latest is Y". With the channel unreachable the row
  degrades to before/after version evidence ("already X" for an unchanged
  readable version, mirroring herdr) instead of a fabricated success.
  Since the parallel-status redesign (2026-09), the upgrades themselves run
  CONCURRENTLY: `planUpgrades` checks every shim, then groups specs by
  installer key so identical physical installers (zai/ali) collapse onto one
  leader whose followers await its result, and `runUpgradeWithDeps` starts
  all leaders at once. A tool's failure never aborts its siblings; the
  overall exit code is non-zero when any tool failed, and a cancellation
  exit code (Ctrl-C: 129/130/131/143) still propagates after the in-flight
  installs settle. On a TTY, `runUpgrade` renders a stable one-row-per-tool
  status list (pending/running/done/failed/skipped, spinners via live.ts's
  `withLiveRender`, the same pattern as `ais limits`) driven by the pure
  transition reducer in `cli/upgrade-status.ts`; every installer child runs
  captured (`exec.ts`'s `spawnCaptured`) so npm/Grok noise cannot interleave
  into the frame and is printed tail-truncated only for failed tools. On a
  pipe or CI the same run degrades to plain start/finish lines per tool, so
  logs stay useful without the old scrolling npm output.

