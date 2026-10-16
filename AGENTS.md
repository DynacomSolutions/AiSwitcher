# AiProfileSwitcher

Privacy prevention: never add private real identifiers, identifying home paths,
credentials, or live account/machine captures to fixtures. Use synthetic data
only; each credential-shaped value and provider reset ID must contain its own
`SYNTHETIC_FIXTURE` marker. A marker elsewhere on the line grants no exception;
private-key headers are rejected. Private terms and AIS registries must remain
outside the checkout, including symlink targets (`AIS_PRIVACY_TERMS_FILE`); local
guards also read AIS identity names and aliases. Install composed local guards
with `bun run privacy:install`. Check indexed additions with
`bun run privacy:check --staged --local`; public CI uses
`bun run privacy:check --ci` with event base/head SHAs, or explicitly
`bun run privacy:check --range <base> <head>`. Each incoming commit is checked.

Identifier guard (binding, separate from the privacy check above): no
hostnames, domains, email addresses, IP literals, or identifying home paths
may enter this repository except the reviewed allowlist in
`scripts/identifier-allowlist.ts` (RFC 2606/6761 reserved names, plus the
specific third-party vendor domains this project's code actually calls, each
with its own one-line justification). This applies to every tracked file,
not just diffs: `bun run lint` runs `scripts/identifier-scan.ts --tree`
(hostnames/domains/emails/IPs/home paths) and `scripts/secret-scan.ts --tree`
(gitleaks when present on `PATH`, else a built-in token-shape scanner) across
the whole working tree. The same two checks also run scoped to incoming
commits: `bun run scripts/identifier-scan.ts --staged` /
`--pre-push <remote>` / `--ci`, and the `secret-scan.ts` equivalents. Adding
a new vendor domain means adding a justified entry to
`scripts/identifier-allowlist.ts`, not loosening the scanner. Versioned git
hooks (installed by `bun run privacy:install`, alongside the privacy guard)
run the fast staged-scope checks on pre-commit and the full outgoing-commit
scope plus `bun run typecheck`/`bun run lint` on pre-push; the same checks
also run as a required CI job, so bypassing hooks does not bypass
enforcement. Hooks must never be bypassed (no `--no-verify`); if a check is
wrong, fix the allowlist or the scanner, not the bypass.

## What this is

Thin wrapper executables (`claude`, `codex`, `grok`, `kimi`, `zai`, `ali`, `pi`,
`opencode`) shadow the real CLIs on `PATH` and switch between isolated
"identities" (each with its own config/auth directory) via `--identity=<name>`,
an inherited env var, directory-based detection, or an interactive picker last.
`zai` and `ali` are fake proxy names for the real `crush` CLI (Z.ai and Alibaba
Token plan providers respectively). Plus the `ais` management CLI, console
(`ais web`, `ais tui`) and the `open` shim (darwin only).

## Task protocol

This file is the always-loaded core. Everything else lives in `docs/agents/`.
Before touching an area, read its topic file (index below). Do not relitigate a
design decision without reading why in the topic file first.

## Commands

- `bun install`; `bun test`; `bun run typecheck`; `bun run lint`.
- `bun run build`: `bun build --compile` all eight proxy entrypoints (`claude`,
  `codex`, `grok`, `kimi`, `zai`, `ali`, `pi`, `opencode`) plus `open` (darwin
  only), `ais`, and the installer into `dist/`.
- `bun run backup`: mirrors every tool config dir into the git-managed repo at
  `~/.ais/backups`.
- `bun run migrate`: one-time, DESTRUCTIVE; claude/codex only. Refuses to run
  while a `claude`/`codex` process runs (`pgrep`); run from a plain terminal,
  never inside an agent session. Takes a fresh backup first.
- `bun run install:shims`: backs up, then copies `dist/*` to `~/.local/bin`.
  Open a new terminal (or `hash -r`); for grok and kimi verify `which grok` /
  `which kimi` resolve to `~/.local/bin/`.
- `bun run privacy:install`, `privacy:check`, `identifiers:check`, `secrets:check`:
  see the guards above.

## Layout

`src/identities/` (account resolution; no process/OS concerns), `src/shared/`
(process/OS mechanics; no identity-resolution logic), `src/sync/` (SSH/rsync
sync), `src/server/` (local console API for `ais web`; thin wrappers over the
existing engines; contract in `docs/API.md`), `src/cli/` (the `ais` CLI; no
identity-resolution logic of its own), one entrypoint per tool at `src/<tool>.ts`
(`src/open.ts` darwin only, `src/ais.ts`), `scripts/` (build, install, backup,
migrate), `apps/web` (Vite/React), `apps/tui` (Rust ratatui), `test/`.
Import direction: `shared/run-wrapper.ts` imports `identities/*`, never the
reverse; `cli/*` depends on `identities/*`, never the reverse, and adds no
resolution logic of its own. Full per-file map: `docs/agents/module-map.md`.

## Hard rules (condensed; details and reasons in the topic files)

Identity and launch:
- Retired identities keep their registry entry (name/aliases stay occupied) but
  lose credentials; they are excluded from every selection and live-probe path.
  `unretire` does NOT restore credentials.
- Directory patterns: no wildcard = that exact directory only; a trailing `/*`
  alone means recursive. Longest pattern wins; exact beats recursive; a tie
  between different identities falls to the prompt. Do not swap in a glob library.
- Global memory: `~/.ais/memory/GLOBAL.md` is the sole writable authority, outside
  every sync root and backup group; vendor files are projections only; every tool
  must declare `globalMemoryProjection`. Write via `ais memory add`. Pi management
  subcommands (`install`/`remove`/`uninstall`/`update`/`list`/`config`/`auth`) must
  bypass the projection.
- The wrapper never stays alive as the TUI's parent: after setup it spawns the
  detached `__session-sidecar` (sync watcher, Herdr titles, post-exit sync; never
  touches the terminal), then replaces itself with the real binary via libc
  `execve` (`src/shared/execve.ts`, `session-sidecar.ts`; Linux, and macOS via
  `posix_spawn` SETEXEC). Without
  FFI or on failure it falls back to `Bun.spawn` in `src/shared/exec.ts`
  (inherited stdio, explicit signal relay). Shims install to `~/.local/bin`; the
  real binary is resolved fresh each run, never cached. One compiled binary per
  tool; no argv0 dispatch (the sidecar is re-entered via argv[2] plus an env spec).
- The flag is `--identity` (not `--account`/`--profile`; codex owns `-p/--profile`).
- A nested launch inherits and validates `AI_PROFILE_SWITCHER_SESSION` only
  when the parent and target use the same provider tool. Cross-provider
  launches resolve their own identity while retaining nested-session
  behaviour. The runtime uses `AI_PROFILE_SWITCHER_TOOL` to identify the
  parent provider. The machine-local Bash hook
  `~/.ais/hooks/cross-agent-require-id.*` is outside this repository and
  applies the same provider-scoped rule.
- Codex user-preference keys (`model`, `model_reasoning_effort`, `service_tier`)
  must never be sent as `-c` overrides. Never weaken the Codex backfill lease
  guards (repair only when the SQLite owner is provably gone). Never rewrite a
  live Codex rollout to fix its cwd; use `resume-cwd-overrides.json`.
- `open` shim: darwin only; acts only when `IDENTITY_SESSION_MARKER` (env var
  `AI_PROFILE_SWITCHER_SESSION`) is set; on
  any failure it falls through to plain `open`, loudly, never silently.

Sync, data and upgrades:
- SSH sync never blocks agent startup or keeps a wrapper open (including `ais`
  subcommands: use the detached `startBackgroundProfileSync()`, never `await`
  `automaticSync()`). SSH owns auth (`BatchMode=yes`, `StrictHostKeyChecking=yes`).
  No delete flag; rsync always `--no-owner --no-group --no-perms`; never add a
  generic `*.tmp` exclusion; `configDir` is expanded to absolute at the I/O
  boundary and consumers never see a literal `~`.
- All project-owned data lives under `~/.ais`, with paths from
  `src/shared/ais-home.ts`. Existing env overrides (`AIS_SYNC_CONFIG`,
  `AI_PROFILE_SWITCHER_REAL_BIN_DIR`) skip migration. Never auto-delete old
  backups. Backup commits must use the same pathspec as the staging step.
- `ais upgrade` installs deterministically (managed npm prefix / xAI installer);
  never trust exit codes alone, always re-probe `--version`; never use
  `--dangerously-allow-all-scripts`; native updaters only as capability-checked fallback.
- `ais update` only refreshes this project's shims; `ais upgrade` upgrades real CLIs.

Console, reporting and credentials:
- The console is a thin HTTP surface over the existing engines. Loopback bind only,
  loopback Host check, bearer token or loopback peer, `X-AIS-Console: 1` on every
  mutating method, secrets write-only, file editing confined to whitelisted roots (dual lexical+realpath containment
  checks and pre-edit backups).
  `parseArgs` reads only `--flag=value`.
- Console (WebUI) login flows spawn the REAL binary (`resolveRealBinary`), never the shim.
- Limits and usage are provider-first: group by provider+identity, never by tool.
  ESTIMATES and REAL spend never share a column. A source with nothing to report
  renders no row unless `--tool=` asked for it; failures are honest rows, never
  fabricated zeros (source-only failures: Errors section only).
- `ais usage`: tokscale is not a dependency; `--client` goes AFTER the tokscale
  subcommand; unscoped passthrough must merge identities, not inject nothing;
  breakdown attribution rule is fixed (prompt tokens on conversation, output split
  evenly over a turn's tool calls) and always labelled an estimate.
- One credential per (identity, provider): OAuth copies are views of one logical
  token (freshest wins); pi sync is ADD-ONLY for existing entries; a pool
  identity's refresh token must never fork. The pi single instance never copies
  credentials: it reads the source identity's store per request and writes
  rotations back to that source. Claude swap pools are the deliberate exception:
  the pool's `.credentials.json` mirrors the active member's grant and is
  written back before each swap.
- Spend guard: no override env var or flag; never block on missing data and never
  skip it silently (flag degraded); `mode` in `~/.ais/config/spend-guard.json`
  is the only switch.
- crush-backed tools: never run `crush update-providers` for per-identity scoping;
  `CRUSH_GLOBAL_CONFIG` and `CRUSH_GLOBAL_DATA` must point at different directories.
- OpenCode wrapper never prompts for identity in `run`/`acp`/`serve`; never reuse
  Claude Pro/Max OAuth; never aggregate credentials from unrelated identities
  into one OpenCode profile.
- pi uses its shared single instance when no identity resolves; when active
  pools exist, an unresolved interactive launch offers the identity/pool picker.
  With no pools and no match it still omits `AI_PROFILE_SWITCHER_SESSION`.
- herdr is never bundled or installed by ais; the bridge only calls its CLI and
  never kills or signals herdr processes (except killing our own timed-out CLI
  client spawn).
- Secrets never reach argv, logs or output tails; identify credentials by
  fingerprint only. Never kill processes this project does not own; take no
  unrequested destructive action.
- Account wiring (AWS profiles, Chrome MCP identities) is machine-local config under
  `~/.ais/config/`, never in this public repo.

## Adding another wrapped tool later

A tool is not "added" when it launches; it is added when it is wired everywhere
(CLI subcommands, wrappers, build/install/backup scripts, release workflow and
BOTH docs, in the same change: `AGENTS.md` core, `docs/agents/module-map.md`
and `README.md`). Two gates MUST pass: `test/tool-wiring.audit.test.ts`
(add new integration-point files to its `FILES` list) and an explicit per-tool
decision (wire it, or say in the PR why absent) for the deliberately partial
touchpoints (doctor `PROBES`, `fetchExtraCost`, `cli/limits/*`, `cli/resume/*`,
`cli/auth/*`, `model-pricing.ts`). `bun run typecheck && bun test` must be green,
then run the real command once. Full recipe: `docs/agents/adding-a-tool.md`.

## Touching paths (every `src/` directory maps to at least one entry)

- `src/sync/**`, `src/cli/sync/**`: sync.md
- `src/cli/resume/**`, `src/cli/sessions/**`: sync.md, codex.md, crush-tools.md
- `src/cli/usage/**`: usage-tokscale.md, provider-first.md, crush-tools.md, bedrock-spend.md
- `src/cli/limits/**`: provider-first.md, bedrock-spend.md, crush-tools.md
- `src/server/**`: console-web.md
- `src/spend/**`: bedrock-spend.md
- `src/identities/*auth*`, `src/identities/oauth-*`: provider-first.md, pi.md
- `src/identities/claude-swap*`, `src/identities/pool/**`, `src/cli/claude-swap/**`, `src/cli/swap/**`: claude-swap-pools.md
- `src/identities/**` (rest): identities.md, module-map.md
- `src/pi-extension/**`: pi.md
- `src/shared/**`: wrappers-and-shims.md, module-map.md
- `src/cli/auth/**`: provider-first.md, pi.md
- `src/cli/doctor/**`, `src/cli/identities/**`, other `src/cli/*`: module-map.md
- `src/<tool>.ts`, `src/open.ts`: wrappers-and-shims.md, chrome-open.md

## Topic index (read the file before touching the area)

- Full original command descriptions (test file list, backup dirs, migrate caveats): `docs/agents/commands.md`
- Per-file module map, any unfamiliar code: `docs/agents/module-map.md`
- Identity registry, retirement, dir-pattern matching: `docs/agents/identities.md`
- Global memory projection and git-base landing: `docs/agents/global-memory.md`
- Wrappers, exec, shims, PATH, nested-launch policy: `docs/agents/wrappers-and-shims.md`
- Codex defaults, backfill lease: `docs/agents/codex.md`
- SSH/rsync profile sync, resume cwd overrides: `docs/agents/sync.md`
- `open` shim, Chrome profile per identity: `docs/agents/chrome-open.md`
- `--desktop` launches and spike status: `docs/agents/desktop-apps.md`
- `ais usage`, tokscale, breakdown: `docs/agents/usage-tokscale.md`
- `ais upgrade`/`ais update`: `docs/agents/upgrade.md`
- `~/.ais` root, migration, git-managed backups: `docs/agents/ais-home-backup.md`
- `ais web` console, WebUI logins: `docs/agents/console-web.md`
- Adding a new wrapped tool: `docs/agents/adding-a-tool.md`
- grok and kimi specifics: `docs/agents/tools-grok-kimi.md`
- zai, ali, Crush (current design): `docs/agents/crush-tools.md`
- pi extension, single instance, pi auth: `docs/agents/pi.md`
- OpenCode wrapper: `docs/agents/opencode.md`
- Provider-first limits/usage, OAuth reconcile/refresh: `docs/agents/provider-first.md`
- AWS Bedrock reporting, spend guard: `docs/agents/bedrock-spend.md`
- Claude swap pools: `docs/agents/claude-swap-pools.md`
- Release pipeline, aistui release assets and self-heal: `docs/agents/release.md`
- `ais tui` status page, herdr bridge, `ais herdr`: `docs/agents/tui-herdr.md`
- History, retired designs, duplicated sections (zai takes 1-2): `docs/agents/history.md`
