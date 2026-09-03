# AiProfileSwitcher

Thin wrapper executables (`claude`, `codex`, `grok`, `kimi`, `zai`, `ali`, `pi`, `opencode`) that
shadow the real Claude Code / Codex / Grok / Kimi Code / Pi CLIs on `PATH` (`zai`
and `ali` are the two exceptions, see below) and let you switch between
multiple isolated "identities" (each with its own config/auth directory) via
an explicit `--identity=<name>` flag, an inherited env var, automatic
directory-based detection, or an interactive picker as a last resort.
`zai` and `ali` are not real CLIs' shims: both are fake proxy identity names
this project invents for the real `crush` CLI (github.com/charmbracelet/crush,
a multi-provider terminal coding agent by Charm), `zai` configured to talk
to the ZAI/Z.ai provider, `ali` configured to talk to Alibaba Cloud Model
Studio's Token plan (see the "zai case study", now on its third design, and
the "ali case study" below for why each needed its own design rather than
following the recipe as-is.

## Module boundaries

```
src/
  identities/          the account-resolution engine — no process/OS concerns
    types.ts            Identity / IdentitiesFile / ToolConfig / ResolveOptions
    store.ts             load/validate/atomic-persist identities.json
    match.ts              directory-pattern grammar + specificity-scored matching,
                         isValidIdentityKey() (name/alias grammar)
    chrome-profile.ts       resolveChromeProfile(): override > identity-default chain (see below)
    tool-configs.ts          CLAUDE_CONFIG/CODEX_CONFIG/GROK_CONFIG/KIMI_CONFIG/ZAI_CONFIG/
                             ALI_CONFIG/PI_CONFIG, the one source of truth for each tool's
                             identitiesJsonPath, shared by claude.ts/codex.ts/grok.ts/kimi.ts/
                             zai.ts/ali.ts/open.ts/cli/*. ZAI_CONFIG/ALI_CONFIG both carry
                             realBinaryName ("crush", since neither "zai" nor "ali" is a real
                             binary) and extraEnvVarNames (crush splits config from
                             session/model-cache data (see "zai case study" below); ali's
                             own envVarName is bespoke too, to disambiguate from zai; see
                             "ali case study")
    zai-auth.ts             writeZaiAuthFile(): read-modify-write into a zai identity's own
                             <configDir>/crush.json with its "zai" provider entry — the
                             non-interactive auth this design's whole existence depends on
    ali-auth.ts              writeAliAuthFile(): the same read-modify-write trick for ali's
                             "alibaba" provider entry, see "ali case study" below
    pi-auth.ts               one-shot, secret-silent import of the six provider-specific
                             AIS identities plus OpenCode Go into one Pi auth.json; also translates ali's
                             Crush model catalogue into Pi's models.json
    resolve.ts             resolveIdentity(): the flag > env > dir-match > prompt/error chain
    prompt.ts               @clack/prompts picker + create-new-identity flow
    errors.ts                typed IdentityResolutionError subclasses
  shared/              process/OS mechanics — no identity-resolution logic
    resolve-binary.ts    find the REAL claude/codex/grok/kimi/open/crush/pi binary,
                        self-recursion guard. Takes a `realBinaryName`, not a `toolName` —
                        zai's real binary is "crush", not "zai"
    exec.ts               Bun.spawn passthrough, signal relay, exit-code parity;
                          also defines IDENTITY_SESSION_MARKER (see below)
    cli-args.ts            strip --identity=/--desktop, detect non-interactive intent
                          (per-tool: claude's -p/--print, codex's `exec` subcommand,
                          grok's -p/--single or `agent` subcommand, kimi's -p/--prompt
                          or `acp` subcommand, zai's `run` subcommand, Pi's print/package modes)
    codex-backfill.ts      pre-launch recovery for Codex's orphaned state-DB
                          backfill lease; preserves its checkpoint and never
                          resets a database still owned by a live process
    launch-desktop.ts       best-effort --desktop launch (see below); also mirrors
                          extraEnvVarNames for tools (zai) that need more than one
    run-wrapper.ts          wires the above together; shared by all eight proxy entrypoints;
                          also mirrors ToolConfig.extraEnvVarNames onto the spawned
                          child alongside the primary envVarName
    global-memory.ts       owns `~/.ais/memory/GLOBAL.md` and projects it through each
                          tool's mandatory native memory channel without creating a
                          second writable store
  sync/                SSH/rsync profile and usage-data synchronisation — machine-local
                          remote config, portable ~/ registries, staged additive exchange,
                          inter-process lock, and debounced/final reconciliation
  server/              the local console API behind `ais web` — thin HTTP wrappers around
                          the EXISTING engines (store/actions, limits fetchers, usage
                          aggregation, resume readers, zai/ali auth writers), no new
                          identity logic; contract documented in docs/API.md
    app.ts                 Hono app assembly: every /api route, static serving of
                           apps/web/dist (hand-rolled, cwd-independent), uniform HttpError
                           mapping; createApp(deps) is fully injectable for tests
    serve.ts               Bun.serve wiring + server.json lifecycle (pid/port/token) +
                           findDistDir() discovery of the built WebUI
    guard.ts               request hardening: loopback Host allowlist (DNS-rebinding),
                           bearer-token OR loopback-peer auth, X-AIS-Console required on
                           every mutating method (CSRF guard, see design decisions)
    state.ts               ~/.ais/web/server.json read/write/clear + token generation
    expensive.ts           PollCache (TTL + in-flight dedupe) shared by the limits/usage
                           endpoints so BOTH frontends' live polling never hammers
                           upstream provider APIs; also maps query params onto the
                           ParsedArgs["flags"] shape the collectors already read
    processes.ts           /proc scan for running agent CLIs, attributed to identities via
                           IDENTITY_SESSION_MARKER in each process's environ
    registries.ts          registry listing + all mutations via cli/identities/actions.ts's
                           pure functions + store.ts atomic save; optional apiKey at create
                           time forwarded to writeZaiAuthFile/writeAliAuthFile
    auth.ts                per-identity auth health probes (file presence + shape only,
                           never secret values) and fix actions: zai/ali key writes,
                           ali console-cookie paste, kimi token refresh (reuses
                           fetchKimiLimits's refresh-on-expiry path), interactive login
                           spawned into a detected terminal emulator with the identity env
    files.ts               whitelisted-root file browsing/editing (~/.ais, tool containers,
                           registered configDirs): dual lexical+realpath containment guards,
                           REPRODUCIBLE_JUNK_DIR_NAMES-filtered listings, 2 MB text cap,
                           binary sniffing, atomic writes with pre-edit backups under
                           ~/.ais/web/file-backups/
  cli/                 the `ais` management CLI — no identity-resolution logic of its own
    dispatch.ts          top-level subcommand routing + uniform error->exit-code handling
    args.ts                minimal argv parser: positionals + --flag=value/--flag
    errors.ts               CliUsageError — bad flags/args, distinct from identities/errors.ts
    version.ts               `ais version` (reads package.json)
    help.ts                   `ais help` / bare `ais` / `--help`/`-h`
    update.ts                 `ais update`: re-downloads whichever of claude/codex/grok/kimi/
                             zai/ali/pi/open/ais are already in ~/.local/bin, via installer.ts's
                             downloadAssetAtomic
    upgrade.ts                 `ais upgrade`: ensures every installed AIS shim has its real
                             CLI installed/upgraded — Claude/Codex/Kimi/Crush/Pi in AIS's
                             user-owned npm prefix, Grok through xAI's official release
                             installer; capability-checked native updaters are only
                             fallbacks. Distinct from `ais update`, which refreshes this
                             project's own shims
    sync/dispatch.ts           `ais sync list|add|remove|now`; SSH aliases come from
                               ~/.ais/config/sync-v2.json and auth stays entirely in SSH config
    identities/
      actions.ts             pure (file: IdentitiesFile, ...) => void mutations — the only
                             place identity-mutation business logic lives outside identities/*
      resolve-tool.ts          --tool flag parsing + auto-resolve-when-unambiguous lookup,
                             written generically over N registries (TOOL_CONFIGS), not a
                             hardcoded claude/codex pair
      dispatch.ts               routes `ais identities <action> ...` to actions.ts
      list.ts show.ts create.ts chrome-overrides.ts   thin CLI-facing wrappers
    usage/
      tokscale.ts               tokscaleInvocationFor(): per-tool env-var mapping to scope
                               tokscale (github.com/junhoyeo/tokscale) at one identity's
                               data, + TokscaleReport/TokscaleEntry (its --json shape) +
                               resolveTokscaleCommand() (PATH, else bunx)
      pi-usage.ts providers.ts    recursive Pi JSONL usage reader + canonical upstream-provider
                               aliases; copied/forked messages are deduplicated before aggregation,
                               party members are provider-attributed, and native CLI bridges are marked
      run.ts                     collectTargets() (--tool/--identity filtering, every match
                               across registries — not an ambiguity error, unlike
                               resolve-tool.ts's resolveMutationTarget) + provider-first
                               native/Pi aggregation and CLI-bridge double-count prevention
      report.ts                   formatUsageReport(): provider-labelled table + trailing Errors section
      passthrough.ts               runPassthrough(): full tokscale (tui/graph/monthly/...) via
                               `-- <args>`, execReal'd with full stdio inheritance, scoped to
                               zero or exactly one identity — never "every identity" (see below)
      dispatch.ts                  splitPassthroughArgs() (raw "--" split, unit-testable
                               without touching execReal's process.exit) + routes `ais usage
                               [--identity=] [--tool=] [--json | -- <tokscale args>]`
    limits/
      dispatch.ts               `ais limits [identity] [--tool=] [--json] [--cached]
                                [--watch] [--interval=<s>]` — live/cached provider quota per
                                identity per PROVIDER (the views are provider-first; the tool is
                                collection provenance); identity is a positional, not --identity=
      collect.ts report.ts bar.ts watch.ts bucket.ts types.ts
                                per-target collection (each fetcher returns ONE RESULT PER
                                PROVIDER) + provider+identity aggregation across sources +
                                aligned table/bar report grouped by provider + --watch loop
      pi-limits.ts opencode-limits.ts
                                the multi-provider clients' adapters — one Pi/OpenCode identity
                                becomes several provider rows (see "provider-first limits for
                                the multi-provider clients" below); both thread an
                                `explicitTool` flag so an explicit `--tool=` question always
                                gets an answer row while an unscoped report omits
                                nothing-to-report sources
      claude-limits.ts codex-limits.ts grok-limits.ts kimi-limits.ts zai-limits.ts
                                ali-limits.ts
                                per-tool quota fetchers — kimi-limits.ts is a genuinely LIVE
                                fetch (GET api.kimi.com/coding/v1/usages with the OAuth token
                                from credentials/kimi-code.json, refreshing expired tokens via
                                auth.kimi.com), unlike grok's log-scrape — see the kimi case
                                study. zai-limits.ts is also a genuinely live fetch (GET
                                api.z.ai/api/monitor/usage/quota/limit with the static key from
                                that identity's own crush.json — no OAuth/refresh needed,
                                unlike kimi) — see the 2026-07-18 zai/Crush addendum.
                                ali-limits.ts is live too but is the odd one out: the Token
                                plan has NO API-key quota endpoint (probed live), so it hits
                                Alibaba's OneConsole gateway with a pasted console-session
                                cookie from <configDir>/console-cookie.txt — see the ali
                                case study. kimi/zai both expose a per-credential entry point
                                (fetchKimiUsageForCredentials / fetchZaiQuotaForKey) so the
                                pi/opencode adapters can reuse the same live reads against the
                                SAME accounts' credentials stored in their own auth files
    resume/
      dispatch.ts               `ais resume [<session-id>] [--identity=] [--tool=] [--json]` —
                               per-cwd resumable-session tree + interactive picker + relaunch
      collect.ts pick.ts report.ts label.ts launch.ts types.ts
      claude-resume.ts codex-resume.ts grok-resume.ts kimi-resume.ts zai-resume.ts
                               per-tool session readers — kimi-resume.ts reads kimi's own
                               session_index.jsonl (+ each session's state.json for
                               label/timestamps) rather than walking the one-way-hashed
                               sessions/wd_<slug>_<hash>/ buckets — see the kimi case study.
                               zai-resume.ts reads Crush's own project-LOCAL `.crush/crush.db`
                               (bun:sqlite) via that identity's projects.json — the only tool
                               whose sessions live outside its own configDir entirely — see the
                               2026-07-18 zai/Crush addendum
    web.ts                   `ais web start|stop|status|open [--port=] [--foreground]`:
                           lifecycle for server/*'s console daemon. Default spawns a
                           DETACHED child re-invoking this same entrypoint with the hidden
                           --serve-internal flag (works compiled AND dev: [Bun.main] alone
                           when self, [process.execPath, Bun.main] under the bun runtime);
                           fails fast if the child exits before its own pid appears in
                           server.json and answers a health probe, so a stale daemon
                           holding the port can never masquerade as a successful start.
                           NOTE parseArgs only reads --flag=value; "--port 1234" would
                           silently become port=true + positional "1234"
    tui.ts                   `ais tui`: ensures the console server is up (reads
                           ~/.ais/web/server.json), then execs the ratatui binary from
                           $AIS_TUI_BIN > ~/.local/bin/aistui > apps/tui/target/release/
                           aistui, passing AIS_CONSOLE_URL/AIS_CONSOLE_TOKEN via env
  claude.ts            entrypoint: ToolConfig for claude, calls runWrapper
  codex.ts             entrypoint: ToolConfig for codex, calls runWrapper
  grok.ts              entrypoint: ToolConfig for grok, calls runWrapper
  kimi.ts              entrypoint: ToolConfig for kimi, calls runWrapper
  zai.ts               entrypoint: ToolConfig for zai (ZAI_CONFIG), calls runWrapper —
                       the real binary it resolves and execs is `crush`, not `zai`
  pi.ts                entrypoint: ToolConfig for Pi, isolates its complete profile with
                       PI_CODING_AGENT_DIR and calls runWrapper
  open.ts              entrypoint (darwin only): shadows `open`, redirects links to a
                       Chrome profile (see below)
  ais.ts               entrypoint: the `ais` CLI, calls cli/dispatch.ts's runCli
  shared/
    ais-home.ts             the one source of truth for every path under the
                            consolidated ~/.ais tree this project's OWN tooling
                            owns (backups, sync's local cache/staging, the
                            managed npm prefix, sync config) — see "~/.ais:
                            one consolidated root" below
    migrate-ais-home.ts       self-healing, idempotent relocation of that data
                            from its old scattered locations (~/.cache/ais,
                            ~/.config/ais, ~/.local/share/ais/npm) into ~/.ais,
                            called at the top of run-wrapper.ts and cli/
                            dispatch.ts on every invocation
    reproducible-paths.ts     REPRODUCIBLE_JUNK_DIR_NAMES — directory names
                            with no restore/sync value (caches, clones, logs,
                            worktrees, ...), shared between SSH sync's own
                            exclude list (sync/rsync.ts) and the git-managed
                            backup's (scripts/backup.ts), so the two can't
                            silently drift apart
scripts/
  backup.ts            mirrors every real config dir into a single persistent
                       git repo at ~/.ais/backups and commits whatever changed
                       — see "~/.ais: one consolidated root" below
  migrate.ts            one-time, interactive, moves existing dirs into identities/<name>/
                        (claude/codex only — see "Adding another wrapped tool later")
  build.ts               bun build --compile for claude/codex/grok/kimi/zai/ali/pi/ais (+ open, darwin only)
  install.ts              backup + copy compiled binaries to ~/.local/bin
```

`identities/*` and `shared/*` never import from each other in the wrong
direction: `shared/run-wrapper.ts` imports `identities/*`, never the reverse.
`cli/*` follows the same rule relative to `identities/*` — it depends on
`identities/*`, never the reverse, and adds no identity-resolution logic of
its own (every `ais identities` mutation is I/O glue in `cli/identities/*`
around `identities/store.ts`'s existing load/save/validate). This keeps the
resolution engine pure and unit-testable (see `test/`) without any
process/TTY/filesystem mocking beyond a plain `ResolveDeps` object.

## Key design decisions (don't relitigate without reading why first)

- **Directory-pattern grammar is intentionally stricter than a standard glob
  dialect.** A `directories` entry with no wildcard matches only that exact
  directory (no implicit recursive/prefix matching). An entry must end in a
  literal `/*` to mean "this directory and everything beneath it, recursively."
  Libraries like picomatch/minimatch treat a bare trailing `*` as single-level
  only — adopting that as-is would have silently broken this project's
  matching semantics, so `src/identities/match.ts` hand-rolls the grammar
  instead. Tie-break when multiple identities' patterns match the same cwd:
  most-specific (longest) pattern wins; an exact match always outranks a
  recursive match anchored at the same directory; a true tie between two
  *different* identities falls through to the interactive prompt.
- **Global memory belongs to AIS, never a vendor identity or the AIS git
  repository.** `~/.ais/memory/GLOBAL.md` is the sole writable authority and
  is deliberately outside every SSH profile-sync root and git-managed backup
  group. `run-wrapper.ts` projects it at launch through the mandatory
  `ToolConfig.globalMemoryProjection`: Claude append-system-prompt file,
  Codex developer instructions, Grok rules, Kimi global AGENTS discovery, Pi
  append-system-prompt file, OpenCode runtime config content, or Crush global
  context paths. Any vendor file or config entry created for compatibility is
  a projection only. `ais memory add` is the cross-agent write API. Adding a
  tool without declaring a projection is a type error.
- **No `execve`-style process replacement.** Bun has no non-experimental
  primitive for true process-image replacement, so `src/shared/exec.ts` uses
  `Bun.spawn` with full fd inheritance (`stdio: ["inherit","inherit","inherit"]`)
  plus explicit signal relay (SIGINT/SIGTERM/SIGHUP/SIGQUIT/SIGTSTP) and
  exit-code/signal-code mirroring. This is the same model nvm/asdf/direnv-style
  shims use. The one accepted gap: an uncatchable SIGKILL sent to the wrapper
  itself orphans the child rather than killing it too.
- **Shims install to `~/.local/bin`, not a dedicated shim directory.** It's
  already ahead of both the real `claude` (Homebrew, `/opt/homebrew/bin`) and
  real `codex` (nvm bin dir) on `PATH`, and is already the convention for
  dropping compiled CLI tools on this machine — so installing there needs zero
  shell-rc edits. `src/shared/resolve-binary.ts` first checks AIS's managed
  real-CLI directory (`~/.ais/npm/bin`, formerly `~/.local/share/ais/npm/bin`
  — see "~/.ais: one consolidated root" below), then the conventional
  Grok/Kimi installer directories where relevant, then strips the shim
  directory from inherited `PATH` (compared by realpath, not string match)
  and does a fresh `Bun.which` lookup. It never caches an install-time path:
  Homebrew, npm, and vendor upgrades can move a real binary without the
  wrapper being reinstalled. Preferring the managed directory also makes an
  `ais upgrade` take effect in the current shell instead of rediscovering an
  older `/usr/bin` binary.
  **This "zero shell-rc edits" assumption does NOT hold for grok**: the
  official Grok CLI installer appends its own `export PATH="$HOME/.grok/bin:
  $PATH"` line to the shell rc (confirmed in this repo's dev machine's
  `~/.zshrc`, added *after* the `~/.local/bin` export), which puts the real
  `~/.grok/bin/grok` ahead of our shim on `PATH` — our `grok` shim gets
  installed but never actually intercepts anything until the user manually
  reorders their shell rc (move the `~/.grok/bin` PATH line above the
  `~/.local/bin` one, or re-export `~/.local/bin` after it). This is a
  real, observed gap, not a hypothetical — always tell the user about it when
  wiring up grok, and check `which grok` resolves to `~/.local/bin/grok`
  after `bun run install:shims`. The same gap is CONFIRMED for kimi
  (2026-07-17): Kimi Code's installer wrote
  `export PATH="/Users/<username>/.kimi-code/bin:$PATH"` at `~/.zshrc`:166-167,
  likewise *after* the `~/.local/bin` export — same reorder fix, and check
  `which kimi` resolves to `~/.local/bin/kimi`. Unlike grok there was no
  pre-existing symlink at `~/.local/bin/kimi` (checked). See the kimi case
  study below.
- **Independent compiled binaries per tool, not one dispatch-by-name
  binary.** Inside a `bun build --compile` executable, `process.argv[0]` is
  always the literal string `"bun"` and `import.meta` paths are virtual
  bundle paths — argv0-based name dispatch (the pattern used by many Go/Rust
  multi-call binaries) is unreliable here. `src/claude.ts`, `src/codex.ts`,
  `src/grok.ts`, `src/kimi.ts`, and `src/zai.ts` are separate entrypoints that
  all import the same `src/shared/*` modules; `bun build --compile`
  bundles/tree-shakes each independently.
- **`--identity`, not `--account` or `--profile`.** Codex already has an
  unrelated native `-p/--profile <name>` (layers `$CODEX_HOME/<name>.config.toml`
  on the *same* identity — a config variant, not an account switch). Using a
  different flag name avoids the collision entirely.
- **A nested claude/codex/grok/kimi/zai launch with no `--id` auto-inherits the parent
  session's identity — it is never rejected for merely omitting the flag.**
  `resolveNestedIdentity()` (`src/shared/cli-args.ts`), called from
  `run-wrapper.ts` before `resolveIdentity()`, only rejects a nested launch
  that EXPLICITLY names a *different* identity than
  `AI_PROFILE_SWITCHER_SESSION` — that's the actual cross-identity-pollution
  case. The first cut of this (commit `75053ce`, 2026-07-14) got this
  backwards: it treated a bare, unqualified nested launch (no `--id` at all)
  as an error too, on the theory that every nested caller should be taught to
  pass `--id` explicitly. In practice this broke every real nested caller at
  once — a whole ecosystem of downstream launchers (a `codex-review` shim,
  several dispatch/start/brainstorm/revise launcher scripts, and a
  `claude agents --json` liveness poll) — none of which know or care
  about identities, and none of which should have to. Corrected the same day
  after the user pointed out the contradiction directly: enforcement that
  requires patching every downstream caller across every repo isn't
  "enforced," it's a landmine. The companion Bash-level hook,
  `~/.ais/hooks/cross-agent-require-id.sh` /`.py` (wired into every identity's
  settings.json/hooks.json as "everywhere" enforcement — NOT part of this
  repo, lives in the shared `~/.ais/` tree), encodes the identical policy
  independently at the Bash-tool-call layer and
  was fixed in lockstep — a bare nested launch is not a violation there
  either; only an explicit, mismatched `--id=` is. The two enforcement points
  (this repo's own runtime check, and the Bash-command-level hook) are
  deliberately redundant (defense in depth — the hook catches it before a
  process even spawns; the runtime check catches anything that reaches the
  binary some other way) but MUST be kept in sync — this incident is exactly
  what happens when they drift.
- **SSH sync is a direct home-to-home merge, not a password protocol.**
  `~/.ais/config/sync-v2.json` (formerly `~/.config/ais/sync-v2.json` — see
  "~/.ais: one consolidated root" below) contains validated SSH config
  aliases only; SSH
  owns authentication and always runs with `BatchMode=yes` plus
  `StrictHostKeyChecking=yes`. A top-level wrapper resolves locally and spawns
  the real agent first, then starts full reconciliation in a detached AIS
  worker. Ordinary profile/session mutations use detached workers with a
  three-second debounce, and the final post-exit reconciliation is detached
  too. No
  automatic SSH, rsync, dedupe, or lock wait may block agent startup or keep
  the wrapper open after the child exits. `ais resume` follows the same rule.
  Nested wrappers do not start another full reconciliation. No delete
  flag is used: a stale/offline host must never erase a healthy profile.
  Every exchange deduplicates by the native stable session ID within one
  identity; matching IDs in different identities are never treated as
  interchangeable. Legacy top-level stores are associated only when cwd rules
  or one unambiguous identity make that safe. JSONL copies merge as an
  append-only multiset union (copied events count once and divergent events
  survive), and registry conflicts semantically union identities/list fields.
  Automatic reconciliation never prunes a live path; only explicit
  `ais sync dedupe` may move redundant same-identity paths to
  `~/.ais/remote-cache/dedupe-backups/` (formerly
  `~/.cache/ais/dedupe-backups/`). Pulls and pushes both land in isolated
  incoming trees; the receiver merges from staging, so rsync never overwrites
  a live history. Staging uses checksummed `--compare-dest=../../../..`
  against the receiver's live home, so the isolated tree contains only
  byte-different files rather than another multi-gigabyte profile copy.
  Non-mergeable file conflicts retain the losing bytes.
  `ais sync dedupe [--dry-run] [--json]` exposes the same local invariant.
  `ais sync recover [--dry-run] [--json]` additively restores histories and
  missing sidecars from retained pre-fix conflict/dedupe archives without
  deleting those archives.
  Standard absolute home paths in registries become portable `~/...` paths so
  `/Users/<name>`, `/home/<name>`, and `/root` interoperate.
  `loadIdentitiesFile()` expands every loaded `configDir` back to an absolute
  path at the I/O boundary; usage/resume/limits and other consumers rely on
  that invariant and must never receive a literal `~` path.
  Process locks and every live SQLite main/WAL/SHM/journal file stay local.
  Zai's machine-local `projects.json` is excluded, while registered
  home-relative project `.crush` data is included because its usage/session
  database lives outside the identity configDir. Crush databases transfer only
  as SQLite `VACUUM INTO` snapshots, then upsert by row ID; duplicate session
  counters use `MAX`, never addition. Browser profiles, plugin/marketplace
  caches and clones, dependency trees, logs/debug output, worktrees, generated
  media, shell snapshots, and mutable/rebuildable SQLite databases are also
  excluded: they are machine-specific/reproducible and made the first real
  dry-run scan 13.6 GB/352,562 files, including macOS artefacts that must not
  land on Linux.
  Never restore a generic `*.tmp` rsync exclusion: Grok URL-encodes working
  directories as session bucket names, and a real cwd ending in `.tmp` caused
  24 complete session subtrees to be skipped. Rsync's own atomic staging is
  the protection for temporary transfer state.
  Rsync must always use `--no-owner --no-group --no-perms`: the first live
  Mac-to-root transfer preserved UID/GID/mode onto `/root` on remote2/remote3 and made
  sshd `StrictModes` reject the unchanged authorised key. Do not weaken that
  cross-host metadata boundary. Exit 24 is a normal live-tree race; retry once,
  then accept it because deletes are intentionally not propagated. Remote AIS
  commands share rsync's ControlMaster so verification reuses its authenticated
  connection. Sync config version 2 marks this ownership-safe merge protocol
  and deliberately lives in `sync-v2.json`. Already-running v1 wrappers keep
  reading a separate valid-but-empty `sync.json`; they neither emit repeated
  unsupported-version warnings nor revive the pre-fix transport. New binaries
  can still read/migrate a v1 document when an explicit `AIS_SYNC_CONFIG` path
  points at one, but always save version 2.
  Automatic failures warn and continue; explicit `ais sync now` failures are
  hard errors.
- **Never rewrite a live Codex rollout just to repair its recorded cwd.** A
  restored process may still hold that JSONL open, so replacing it can split
  future events onto an unlinked inode and lose history. Put an explicit,
  stable-session-ID correction in
  `~/.ais/config/resume-cwd-overrides.json` instead. The version-1 shape is
  `{ "version": 1, "sessions": { "codex": { "<session-id>":
  "/absolute/project/path" } } }`. `ais resume` treats the corrected path as
  authoritative: the session appears in that project and no longer leaks
  into its wrongly recorded cwd. Missing, malformed, relative-path, and
  unknown-tool entries are ignored so this repair file can never break the
  normal picker.
  **Regression, caught and fixed 2026-07-23: `ais limits`/`ais usage`/
  `ais identities`/`ais doctor` hung forever, sometimes, because `cli/
  dispatch.ts`'s top-level `runCli` directly `await`ed `automaticSync()`
  in-process** — the exact blocking SSH/rsync/lock-wait work this same bullet
  says must never happen, reintroduced one layer up from where the three
  commits above had already fixed it for `run-wrapper.ts`/`resume/launch.ts`.
  Whichever invocation won the sync lock race did the full two-way
  reconciliation against every configured remote (`remote1`/`remote2`/`remote3` on this
  machine) synchronously, so a slow or unreachable host meant that `ais`
  invocation itself hung; a losing invocation happened to return fast (lock
  already held, `waitForLock` defaults to `false`), which is why the bug was
  intermittent rather than constant and easy to miss in a single manual test.
  There was also a second, always-redundant `await automaticSync()` after the
  command ran — dead for `usage`/`sync`, whose switch cases `return` early
  and skip it, and pointlessly duplicated work for every other sync-aware
  command. Fixed by replacing both with a single call to the same detached
  `startBackgroundProfileSync()` (`sync/background.ts`) `run-wrapper.ts`
  already uses, spawning `ais sync background` and returning immediately
  regardless of remote latency — and, since a detached job can keep running
  well after the CLI command that triggered it has already printed its
  output and exited, a stderr line (`--json` output stays clean) now always
  announces it, rather than reconciliation silently continuing in the void
  with no way for the user to know it's still going.
- **Codex's 15-minute rollout-backfill lease must self-heal in the wrapper,
  but only when its SQLite owner is provably gone.** Confirmed on `remote1`
  with Codex 0.144.6 (2026-07-22): a new 255 MB `state_5.sqlite` indexed
  14,436 of 37,514 rollout files, its worker exited, and the persisted
  `backfill_state` remained `running`. Codex replacement processes wait only
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
- **Chrome-profile-per-identity is implemented as a PATH shim (`open`), not a
  Claude Code/Codex/Grok/Kimi Code setting.** Checked docs.claude.com and the
  Codex CLI config reference (2026-07-06): neither tool exposes a `BROWSER`
  env var, a settings.json key, or a pre-open hook for controlling
  auto-opened links (e.g. the `/login` OAuth flow) — grok's `login`
  subcommand (OAuth via auth.x.ai) and kimi's OAuth flow (auth.kimi.com) were
  not separately checked for an equivalent lever, but are assumed to have the
  same gap by default. The only viable lever is the same PATH-shim trick this
  project already uses for `claude`/`codex`/`grok`/`kimi` themselves, applied
  to `open` (macOS's URL-opening command): `src/open.ts`
  installs to `~/.local/bin/open`, ahead of `/usr/bin/open` on `PATH`. Only
  built/shipped for darwin (`scripts/build.ts`/`scripts/install.ts`/
  `src/installer.ts`/the release workflow all gate it out elsewhere) —
  there's no equivalent bare `open` command on Linux to fall back to for
  passthrough, so shipping it there would turn ordinary `open <file>` calls
  into hard crashes instead of transparent passthrough.
- **The redirect target is the identity's own isolated Chrome (Claude MCP)
  instance, not a real daily-driver Chrome profile — this was a real, shipped
  design mistake, caught and fixed 2026-07-14, not a rename for its own
  sake.** The original cut launched the REAL `Google Chrome.app`
  (`CHROME_APP_NAME = "Google Chrome"`) with `--profile-directory=<value>`,
  and `identities.json` stored a real Chrome profile-directory string per
  identity (`chromeProfile: "Profile 3"`). This was live and even had
  plausible-looking values already set in Codex's and Grok's `identities.json`
  (`chromeProfile: "identity-a"`) — which turned out to be pointing at a
  folder that happened to exist on disk but was registered in Chrome's own
  `Local State` as `"Your Chrome"`, an empty, never-logged-into placeholder,
  not any real account. Confirmed by direct inspection (`Local State`'s
  `profile.info_cache`) that the actually-correct real profiles were
  elsewhere entirely (e.g. `Profile 2` = "the intended work profile", the real
  logged-in account) — i.e. even a "fix" that pointed at the real Chrome
  correctly would still have been touching the user's actual daily-driver
  browsing profiles for an automated CLI login flow, not something isolated.
  Also confirmed by bundle-ID inspection (`CFBundleIdentifier`:
  `com.google.Chrome` for real Chrome vs `com.google.Chrome.claude-mcp` for
  `Chrome (Claude MCP).app`) that `open -a "Google Chrome"` can **never**
  resolve to the MCP-dedicated copy — the two are registered as completely
  separate apps to LaunchServices, so no amount of retargeting the profile
  *string* could have redirected into Chrome (Claude MCP); only changing
  which *app* gets launched could. Redesigned so `open <url>` instead targets
  the SAME per-identity Chrome (Claude MCP) instance the `chrome-devtools`
  MCP server already uses (see "Chrome profile per identity" below) — no
  per-identity config value is needed any more for the default case, since
  the active identity's own name is enough; `chromeProfile` was dropped from
  `Identity` entirely, and `ChromeProfileOverride.chromeProfile` (a raw
  Chrome profile string) was renamed to `.targetIdentity` (an identity name
  to borrow that identity's Chrome (Claude MCP) instance instead).
- **`open`'s activation check is a dedicated marker env var
  (`IDENTITY_SESSION_MARKER` / `AI_PROFILE_SWITCHER_SESSION`, `src/shared/exec.ts`),
  not `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`/`KIMI_CODE_HOME`
  directly.** First cut of
  this feature keyed `open`'s activation off "is `CLAUDE_CONFIG_DIR`/
  `CODEX_HOME` present in my environment" — but `resolve.ts` step (b)
  explicitly treats an already-set env var as a legitimate, permanent,
  deliberate power-user override (e.g. exported once in a shell rc), not just
  something inherited from a nested subagent. Keying off the env var alone
  meant a shell with `CLAUDE_CONFIG_DIR` pinned that way would redirect
  *every* `open` call in that shell — `gh pr view --web`, `git`, unrelated
  scripts — not just ones claude/codex/grok/kimi actually triggered.
  `run-wrapper.ts` now sets a second, dedicated marker (via `execReal`'s
  `extraEnv`, so it only ever lands on the child process the wrapper itself
  spawns) alongside the resolved config-dir env var; `open.ts` requires the
  marker before doing anything, making "only ever changes behavior for
  descendants of our own claude/codex/grok/kimi wrapper" actually true
  instead of just documented. `open.ts`'s `resolveActiveChromeProfile()`
  loops over an array of all four `ToolConfig`s (`TOOL_CONFIGS` in
  `src/open.ts`, distinct from the same-named export in
  `src/cli/identities/resolve-tool.ts`) rather than branching on two
  hardcoded env vars, so a fifth tool only needs appending to that array.
  See "Chrome profile per identity" below for the (still) unverified spike
  outcome this doesn't cover.
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
  - **Per-tool scoping trick, confirmed empirically (2026-07-13) against real
    identity data, not assumed from tokscale's README:** codex/grok/kimi need
    nothing extra — tokscale itself reads `CODEX_HOME`/`GROK_HOME`/
    `KIMI_CODE_HOME`, the exact env vars this project already redirects per
    identity (kimi's entry in that list is confirmed from tokscale's README
    `--client` list and its sessions scanner, 2026-07-17 — not yet
    re-verified against real per-identity kimi data the way claude/codex
    were). claude is the odd
    one out: tokscale hardcodes `<home>/.claude/projects` with no
    `CLAUDE_CONFIG_DIR`-equivalent override anywhere in its source, so
    `tokscaleInvocationFor()` (`src/cli/usage/tokscale.ts`) instead sets
    `TOKSCALE_EXTRA_DIRS=claude:<identity's configDir>/projects` — an
    additive extra scan root tokscale does support. Verified this correctly
    isolates one identity's data with **no symlinks**: ran it against two
    different real identities back to back and got genuinely different
    totals each time (not stale/cached), and confirmed the top-level
    `~/.claude` container this project uses has no `projects/` of its own, so
    tokscale's still-active default scan root contributes nothing to
    double-count. The originally-considered fallback (tokscale's `--home
    <fake-home>` flag + a symlink farm) turned out to be unnecessary and was
    dropped.
  - **bunx concurrency race, also found empirically, not in any doc — and
    the fix went through two designs; the current one (2026-08-07) is
    "bypass bunx for the actual calls," not "serialize the calls":** when
    tokscale isn't already on `PATH` and runs via `bunx tokscale@latest`,
    firing several of those processes at once — the natural way to query N
    identities in parallel — can fail with `error: Failed to link
    @tokscale/cli: EEXIST`. A one-shot "warm the cache first, then
    parallelize" attempt did NOT fix it (reproduced the same failure on an
    already-warm cache); the race is in bunx's global `.bin` link step
    itself, not just the first-ever download — re-confirmed still
    reproducible on bun 1.3.11 (8 parallel warm invocations, 2/8 failed)
    right before the redesign below, so it is NOT something a bun upgrade
    quietly fixed. The FIRST design worked around it by fully serializing
    every tokscale invocation whenever `resolveTokscaleCommand()` resolved
    to `bunx` (parallelizing only when tokscale was on `PATH`). That was
    correct but made the aggregate report crawl — every target paid ~2 tokscale
    scans (main report + hourly/daily) strictly one after another, so a
    12-target run took over a minute. The CURRENT design
    (`resolveTokscaleCachedBinary()` in `src/cli/usage/tokscale.ts`)
    sidesteps the race instead of throttling around it: bunx's own install
    already materializes tokscale's real per-platform native binary at
    `~/.bun/install/cache/@tokscale/cli-<os>-<arch>-<libc>@<ver>/bin/tokscale`,
    so after a one-time `bunx tokscale@latest --version` warm-up per CLI
    run (`ensureTokscaleCacheFresh()`, itself serialized through a tiny
    bunx promise-queue since it IS a bunx call), every actual scan spawn
    goes DIRECTLY at that cached binary (`runTokscaleProcess`) — no bunx,
    no `.bin` link step, no race, and therefore full parallelism across
    all targets even without tokscale on `PATH`. Measured on this machine:
    74s (serial bunx) -> 15.7s first run (includes the warm-up) -> ~6.5s
    warm, all 12 targets. Candidates are probed for actual executability
    (`spawnSync --version`) not just file existence, so a wrong-libc or
    corrupt cache entry falls through to the next variant or ultimately to
    the old serialized-bunx fallback; the resolution result is memoized
    per process. If tokscale's own bunx/npm packaging changes its cache
    layout later, re-verify `findCachedTokscaleBinary` still finds the
    real binary before trusting the parallel path.
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
    other client's data leaks into the report, reproduced directly: a
    claude-only identity's `models` passthrough showed Gemini entries too);
    `tokscale models --client claude` scopes correctly. Root-level
    invocations with no subcommand accept either order fine. So
    `runPassthrough()` always appends `clientArgs` (`--client <tool>`) AFTER
    the caller's own tokscale args, never before — the exact inverse of what
    would seem natural, and easy to get wrong again if this ever gets
    refactored without re-reading why.

- **`ais upgrade` owns a deterministic real-CLI installation for every
  installed AIS shim.** The old design blindly invoked each real binary's
  supposed `update` subcommand and skipped missing tools. `remote1` disproved both
  assumptions on 2026-07-21: Codex 0.118.0 had no `update` command, treated
  the positional word as a chat prompt, and returned exit code 0 after Ctrl+C;
  Claude's updater reported success while leaving the old `/usr/bin/claude`
  selected. That produced a false-success loop rather than an upgrade.
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
  only refreshes this project's shim binaries.

- **`~/.ais` is the one consolidated root for every directory this project's
  own tooling creates and manages — not `~/.local/bin` (the shims
  themselves, deliberately excluded — see above), and not four unrelated
  scattered locations.** Before 2026-07-23 this project's own data lived at
  `~/.ai-switcher-backups` (backup archives), `~/.cache/ais` (SSH sync's
  local staging/conflict/dedupe trees and lock file), `~/.config/ais`
  (`sync-v2.json`), and `~/.local/share/ais/npm` (the managed real-CLI npm
  prefix `ais upgrade` installs into) — four top-level directories for one
  project's own state, none of them named after the project in a way that
  made "what is this and can I delete it" obvious, and none of it living
  anywhere near the pre-existing, separately-managed `~/.ais/hooks` /
  `~/.ais/skills-shared` / `~/.ais/AGENTS.md` / `~/.ais/STANDING-DEFAULTS.md`
  cross-tool shared infrastructure this project's tooling already reads.
  Requested directly by the user (the immediate trigger was replacing
  `scripts/backup.ts`'s tar.gz-per-run design, which grew without bound,
  with a git-managed repo — see the next bullet — but the consolidation
  request explicitly generalized to "all ais data" going forward), and
  implemented as `src/shared/ais-home.ts`: one function per concern
  (`aisBackupsDir`, `aisRemoteCacheDir`, `aisConfigDir`, `aisNpmDir`,
  `aisManifestPath`), each just `~/.ais/<subdir>`, so every consumer
  computes the SAME path instead of five files independently hardcoding
  `.cache`/`ais`/`.config` segments (which is exactly how the old locations
  drifted into being unrelated top-level directories with no shared
  convention in the first place).
  - **`~/.local/bin` (the shims + `ais` itself) is explicitly NOT part of
    this consolidation.** Those need to be on `PATH` with zero shell-rc
    edits — see "Shims install to ~/.local/bin, not a dedicated shim
    directory" above — which is a PATH-discoverability requirement, not a
    "where does this project keep its data" question. `ais-home.ts`'s own
    doc comment states this explicitly so it isn't relitigated.
  - **Existing env-var overrides are still first-class and skip automatic
    migration entirely** — `AIS_SYNC_CONFIG` and
    `AI_PROFILE_SWITCHER_REAL_BIN_DIR` continue to mean exactly what they did
    before; a user who's already pointed either at a custom location owns
    that choice, and the consolidation only changes the DEFAULT.
  - **Self-healing migration, not a one-time interactive script.**
    `scripts/migrate.ts`'s own precedent (manual, interactive,
    `pgrep`-guarded) is deliberately heavier because it restructures LIVE
    identity data with real running-process risk; this consolidation moves
    comparatively low-risk cache/config/npm-prefix directories, and — unlike
    `~/.claude`/`~/.codex`, which this developer's own machine and every
    `remote1`/`remote2`/`remote3` remote already have real data in — needs to migrate
    transparently on EVERY machine this project runs on, local or remote,
    without requiring separate manual intervention on each one. `src/shared/
    migrate-ais-home.ts`'s `migrateLegacyAisHome()` is called at the very
    top of both `run-wrapper.ts`'s `runWrapper()` and `cli/dispatch.ts`'s
    `runCli()` — the only two entrypoints anything under the old locations
    could be read from — and is a handful of `lstat` calls (cheap, no-op)
    once a machine has already migrated. It never throws: a migration
    failure must not block an actual `claude`/`ais` invocation, so failures
    are caught and logged loudly (`console.error`, matching the open.ts
    precedent of "always loudly, never silently") rather than swallowed —
    code downstream only ever reads the NEW location from here on, so a
    silently-failed migration would otherwise look like the data just
    vanished.
  - **The remote-cache migration additionally checks its own `sync.lock`
    for a still-live PID before anything else** — a cheap, precise,
    purpose-built fast path ahead of the general open-file check below, for
    exactly the case where an in-flight sync (started by a pre-migration
    binary, still reading/writing paths under the OLD `.cache/ais` tree)
    makes renaming the directory out from under it the wrong call.
  - **Adversarial review (2026-07-23, before this was ever run on a real
    machine) caught two real bugs and one real gap in the first cut of
    `migrate-ais-home.ts`, all confirmed by direct reproduction, not just
    read-through — worth recording so they aren't reintroduced:**
    1. **No liveness guard at all on the npm-prefix (or config) migration —
       only remote-cache had one.** The npm prefix is exactly the one
       target with a plausible real long-running writer: `ais upgrade`'s
       `installNpmTool()` (`cli/upgrade.ts`) runs a network-bound
       `npm install --global --prefix ...` directly into it. Reproduced:
       a background writer simulating an in-flight `npm install` raced a
       concurrent migration and failed partway (ENOENT) once the rename
       fired mid-write. There is no existing lock-file convention for an
       npm install the way `sync.lock` exists for sync, and — critically —
       an OLD (pre-this-change) binary's already-running upgrade has no way
       to know about any NEW lock convention this diff could introduce, so
       a lock file could only ever protect NEW-binary-vs-NEW-binary races,
       not the actual one-time deploy-transition race that matters. Fixed
       generically instead: `hasLiveOpenOwner(dir)` (lsof `+D <dir>`, with
       the same Linux `/proc/*/fd` fallback `codex-backfill.ts` uses for
       its own liveness check) scans for ANY process with an open file
       handle anywhere under the legacy directory, and is applied inside
       `migrateDir()` for all three targets uniformly — this works
       regardless of which binary version the writer is, since it doesn't
       depend on the writer knowing about a convention at all. Deliberately
       differs from `codex-backfill.ts`'s own stricter default (there,
       "cannot verify" means don't touch): here, "cannot verify" (neither
       `lsof` nor `/proc` available) means proceed anyway, since an
       interrupted `npm install --global` self-heals on the next
       `ais upgrade` retry, unlike a wrongly-repaired Codex backfill lease
       which risks silent data loss — the stakes don't justify permanently
       blocking this migration on a machine with neither tool.
    2. **`migrateDir()`'s own `pathExists` → `rename` sequence is a TOCTOU
       under concurrent invocation, and the loser logged an alarming false
       "failed to migrate" diagnostic** even when a sibling process had
       already completed the exact same migration a moment earlier.
       Reproduced directly (two concurrent `migrateLegacyAisHome()` calls):
       final on-disk state was always correct (rename is atomic per-call,
       so the loser can only fail cleanly, never corrupt anything) but the
       loser's caught `ENOENT` was unconditionally logged as a failure —
       contradicting its own "loud, never silent" intent by firing just as
       loudly for a completely benign race as for a real one. This project
       spawns detached background sync workers on nearly every invocation
       (see the SSH sync bullet above), so overlapping
       `migrateLegacyAisHome()` calls are a realistic, routine occurrence,
       not an edge case. Fixed: on a caught `rename()` failure, re-check
       whether `target` now exists and `legacy` is now gone — if so, some
       other process already finished this migration, so return silently
       instead of logging a failure.
    3. **Confirmed NOT a bug, despite looking like the highest-stakes
       possible issue**: `MANAGED_REAL_BIN_DIR` (`resolve-binary.ts`) is a
       module-level `const`, computed once at import time — but it's a pure
       string built from `homedir()`, doing zero filesystem I/O, so there is
       no stale pre-migration value for import timing to lock in. The actual
       filesystem lookup (`Bun.which`) happens live, inside
       `resolveRealBinary()`, which both `run-wrapper.ts` and
       `cli/dispatch.ts` call strictly after `await migrateLegacyAisHome()`
       in the same function. Reproduced directly (fresh process, synthetic
       pre-migration `HOME`, migrate then immediately resolve) to be sure
       rather than trusting the read-through.
    - **One residual, understood, and NOT fully closable-by-code risk
      remains, accepted rather than solved**: the npm-prefix race in
      finding 1 above is fundamentally a one-time OLD-binary-vs-NEW-binary
      deploy-transition hazard — once `~/.ais/npm` exists (whether migrated
      or created fresh there), `migrateDir`'s own early-return guard makes
      every future call an instant no-op, so this can only ever occur in
      the narrow window of a machine's very first upgrade to a binary built
      from this change, and only if an OLD binary's `ais upgrade` happens
      to still be mid-`npm install` at that exact moment. `hasLiveOpenOwner`
      closes this for any writer using a CURRENT (this-change-or-later)
      binary, and narrows the OLD-binary case considerably (it still
      detects the old binary's own open file handles as a live owner, since
      lsof doesn't care which code wrote them) — but a truly watertight
      close would require the OLD binary to already know about a
      convention it necessarily predates, which is not something code
      shipped today can retroactively guarantee. Before deploying this to
      any machine (this one, or `remote1`/`remote2`/`remote3` later), check for an
      in-flight `ais upgrade`/`npm install --prefix .../ais/npm` first
      (e.g. `pgrep -f 'npm install.*ais'`) rather than relying on the code
      alone.
  - **The backup root is NOT auto-migrated — it's a clean-slate mechanism,
    not a location this project's old tar.gz snapshots could sensibly move
    into.** Pre-existing archives at `~/.ai-switcher-backups/*` are left
    exactly where they are, untouched, for manual reference/cleanup; the
    tool simply stops writing there and starts writing to
    `~/.ais/backups` instead (see the next bullet). Don't build automatic
    deletion of the old archives without being asked — they're the user's
    last several backups.
  - `scripts/install.ts`'s own manifest (`~/.local/bin/.ais-manifest.json`
    -> `~/.ais/manifest.json`) is migrated separately, inline in that
    script, rather than through `migrateLegacyAisHome()` — that script is
    dev-tooling only (never compiled into a shipped binary, run only via
    `bun run scripts/install.ts` from a checked-out clone), so it doesn't
    need the general self-healing mechanism every wrapper/`ais` invocation
    goes through.

- **The git-managed backup repo replaces tar.gz-per-run because git's
  content-addressable object store, not just a new destination directory,
  is what actually keeps the size down.** `scripts/backup.ts`'s old design
  wrote a fresh, independent `~/.ai-switcher-backups/<timestamp>/*.tar.gz`
  tree on every `install`/`update`/`migrate` run, and nothing ever pruned
  old ones — confirmed on this developer's own machine, which had
  accumulated eight separate timestamped snapshot trees before this change.
  The new design (`runBackup()`) mirrors each backed-up directory into a
  single persistent working tree at `~/.ais/backups` via `rsync -a --delete
  --delete-excluded` (replacing tar's "always a fresh full copy" with "the
  working tree always exactly matches the live source, minus excludes"),
  then `git add -A` + commit whatever changed since the LAST backup. Two
  backups taken minutes apart — the common case around an install/update —
  therefore cost close to nothing beyond the first, since git stores each
  distinct blob once no matter how many commits reference it; an empty diff
  (nothing changed) is detected via `git diff --cached --quiet` and produces
  no commit at all, rather than an empty one. `git gc --auto --quiet` runs
  after every commit to keep loose objects packed/delta-compressed rather
  than accumulating unbounded — cheap (near-instant) when under gc's own
  auto-threshold, so it's safe to call unconditionally every run rather than
  needing its own scheduling logic.
  - **Reproducible/machine-local junk is excluded via rsync, sharing
    `REPRODUCIBLE_JUNK_DIR_NAMES` (`src/shared/reproducible-paths.ts`) with
    SSH sync's own `TRANSIENT_EXCLUDES`** (`sync/rsync.ts`) — one list, not
    two independently-maintained ones that could silently drift apart the
    same way the old scattered `~/.ais`-adjacent paths did. `node_modules`,
    marketplace/browser caches, logs, worktrees, and similar have zero
    restore value and were the biggest driver of the old design's
    unbounded growth.
  - **Unlike SSH sync, SQLite/session databases are deliberately NOT
    excluded.** Sync excludes live databases because it has its own
    VACUUM-based snapshot+merge protocol specifically to avoid corrupting a
    live WAL-mode file (see the zai/Crush addenda above) — a backup has no
    equivalent merge step, it just wants a full-fidelity point-in-time copy,
    and excluding the actual session/auth data would defeat the entire
    point of a pre-install/pre-update/pre-migrate safety net. This carries
    the same small, already-accepted risk of copying a database mid-write
    that the old tar-based backup always had (tar had no special handling
    for this either) — no worse than before, just not improved on either.
  - **Local-only git identity, never the user's global gitconfig.** The
    repo gets `user.name`/`user.email` and `commit.gpgsign=false` set
    LOCALLY (`git config`, no `--global`) the first time it's initialised —
    this repo is a storage engine for automated snapshots, not a place for
    human commits, so it must never depend on the user's global identity
    being configured, and gpg-signing (which could hang an automated
    `install`/`update` waiting on a passphrase prompt if the user's global
    config demands signing) is deliberately disabled for it specifically,
    without touching that global setting for the user's actual project
    repos.
  - **`runBackup()`'s return type and every one of its four call sites
    (`migrate.ts`, `scripts/install.ts`, `src/installer.ts`, `src/cli/
    update.ts`) are unchanged** — it still returns `Promise<string>`, now
    the persistent repo path instead of a fresh per-run directory. Every
    caller already just logs whatever path it returns, so none needed a
    diff at all.
  - **Adversarial review (2026-07-23) caught a real bug before this ever
    ran for real: `git commit` had no pathspec, so it committed the WHOLE
    index, not just the groups this run staged.** `git add -A -- ...mirrored`
    and `git diff --cached --quiet -- ...mirrored` were both already
    correctly scoped to the groups touched THIS run — but a bare
    `git commit` after them commits everything currently staged, including
    leftover staged content from an earlier, interrupted broad run (e.g. a
    crash between `install.ts`'s `git add` and `git commit` for one group,
    followed by a later, narrower `install:shims` run for a different
    group). Reproduced directly: staging drift on an untouched directory
    got silently swept into an unrelated group's commit, mislabeled and
    stale. Fixed by passing the identical `-- ...mirrored` pathspec to
    `git commit` too — confirmed via reproduction that `git commit -- 
    <pathspec>` commits only the matching changes and correctly leaves
    other staged content still staged for a future run, rather than losing
    or misattributing it.
  - **Two more real bugs surfaced only by actually deploying this to a real
    machine (2026-07-23), after the adversarial review above had already
    passed — neither was reproducible in a clean test sandbox:**
    1. **`mirrorInto()` treated ANY non-zero rsync exit as fatal, including
       exit 23 ("partial transfer due to error").** This real machine has a
       genuinely permission-denied file under `~/.codex/backups/` (a
       pre-existing artefact of an earlier incident, its own filename
       literally containing `.ais-unreadable-backup-`), and hitting it
       aborted the ENTIRE backup instead of mirroring everything else — the
       exact same "BSD tar continues past an unreadable file, only the exit
       code says something was skipped" shape backup.ts's OLD tar-based
       design explicitly tolerated (see its own historical doc comment).
       The first cut of the rsync-based rewrite regressed this: it was
       strictly LESS tolerant of real-world unreadable files than the
       design it replaced. Fixed by treating exit 23 as a warning (mirror
       still produced, continue) and reserving a hard failure for any
       other exit code.
    2. **`resolveRealBinary()` had no fallback to the LEGACY npm-prefix
       location, and the deferred-migration window this creates is not
       actually rare.** The migration-safety review's own reproduction
       focused on an in-flight `npm install` being corrupted by a racing
       rename; it didn't surface the separate, more mundane consequence of
       `hasLiveOpenOwner()` correctly deferring for an entirely different,
       completely safe reason — a currently-running `claude`/`codex`/
       `crush` process simply having its own already-loaded binary file
       open (read-only execution, not a write in progress at all).
       Confirmed live: with `~/.local/share/ais/npm` still holding several
       real open file handles (this very machine's own running Claude
       Code/Codex sessions, including the one that authored this change),
       `resolveRealBinary("claude")` resolved to `~/.nvm/versions/node/
       .../claude` — an unrelated nvm-installed copy — instead of erroring
       OR finding the real managed install, because the code had stopped
       checking the old location at all. Fixed by adding
       `LEGACY_MANAGED_REAL_BIN_DIR` (the old `~/.local/share/ais/npm/bin`)
       as an unconditional extra fallback in `preferredDirs`, checked right
       after the current location — cheap when absent, and correctly
       resolves to the real managed binary for as long as the deferred
       migration hasn't relocated it yet.
  - **Observed live during this same deployment, understood and NOT a bug
    to fix: two concurrent `ais sync background` workers, one still
    running the OLD binary (writing to `~/.cache/ais`, including its own
    `sync.lock`) and one running the NEW binary (writing to
    `~/.ais/remote-cache`, including a SEPARATE `sync.lock`), briefly
    active at the same time against the same configured remotes.**
    Replacing `~/.local/bin/ais` mid-flight doesn't affect an
    already-running process using the old inode (standard POSIX rename-
    over-a-running-executable semantics), so an old-binary background sync
    already in flight keeps running to completion on its own old code/
    paths while new invocations start using the new ones — the two don't
    share a lock during this transition, since they resolve to different
    default lock paths. Not corrective action here: forcibly killing a
    process this project doesn't own violates this repo's own standing
    rule against unrequested destructive actions, and the existing sync
    design already tolerates concurrent/overlapping runs by construction
    (isolated per-operation incoming trees with random UUIDs, append-only
    JSONL merging, conflict-archive retention) — this is at most some
    redundant SSH round-trips during the one-time transition, not a
    correctness risk, and stops recurring the moment the last old-binary
    background worker exits.

- **The console (`ais web` + `ais tui`) is a thin HTTP surface over the
  existing engines, not a second brain.** Every data endpoint delegates to
  the same functions the CLI uses (store/actions for registry mutations, the
  limits FETCHERS, usage/run.ts's provider-first aggregation, resume's
  READERS, zai-auth/ali-auth for key writes), so a behaviour fixed once is
  fixed for CLI, web, and TUI together. The two frontends (apps/web: Vite +
  React + shadcn/ui + TanStack Query; apps/tui: Rust ratatui) are LIVE views:
  both poll on documented intervals (docs/API.md), which is why
  server/expensive.ts exists — a TTL + in-flight-dedupe cache so N polling
  clients share one upstream fetch instead of hammering provider quota APIs.
  Security model, decided up front because this server can write real
  identity state: binds loopback only; Host header must be loopback-shaped
  (DNS-rebinding guard); requests authenticate via the per-boot bearer token
  in ~/.ais/web/server.json OR by being loopback peers; every mutating method
  additionally requires `X-AIS-Console: 1`, a custom header cross-site pages
  cannot attach without a CORS preflight this server never answers (this is
  the CSRF story); secrets are WRITE-ONLY through the API (keys/cookies can
  be set, never read back); file editing is confined to whitelisted roots
  with dual lexical+realpath containment checks and pre-edit backups. The
  server code follows the repo's test-injection convention (`configs =
  Object.values(TOOL_CONFIGS)` parameters everywhere) so tests exercise the
  real mutation paths against synthetic temp-dir registries and can never
  touch a live home. Two gotchas are load-bearing: cli/args.ts's parseArgs
  reads ONLY `--flag=value` (a space-separated value silently degrades into a
  boolean flag plus stray positional — bit once already during the daemon
  spawn work), and identities/match.ts's expandPath resolves bare relative
  paths against process.cwd(), which is registry-storage semantics and
  therefore deliberately NOT used for user-supplied paths inside the files
  API (there, relative means "relative to the selected root").

## Adding another wrapped tool later

**A tool is not "added" when it launches — it is added when it is wired
everywhere.** Registering a new `toolName` in `TOOL_CONFIGS` is an
all-or-nothing commitment: the CLI's subcommands (`usage`, `limits`,
`doctor`, `resume`, `identities`), the wrappers, the build/install/backup
scripts, the release workflow, and BOTH docs must all learn about the new
tool in the same change. Half-wired tools ship runtime crashes to users —
opencode was registered without any usage-pipeline wiring and every
unscoped `ais usage` died on `provider.trim` (2026-09-03, fixed in the
same commit series that added this rule).

Two gates enforce this — both MUST pass before the change is done:

1. `test/tool-wiring.audit.test.ts` fails the suite when a registered tool
   is missing from any file that must name every tool (the usage pipeline,
   build scripts, release workflow, docs, ...). If you are adding a NEW
   kind of integration point to the codebase, add its file to the audit's
   `FILES` list in the same change.
2. The deliberate-partial touchpoints (doctor `PROBES`, `fetchExtraCost`,
   `cli/limits/*`, `cli/resume/*`, `cli/auth/*`, `model-pricing.ts`) degrade
   gracefully instead of crashing, so the audit cannot force them. They
   still require an explicit decision per tool: either wire the new tool in
   or note in the PR why it is intentionally absent. "I didn't know it
   existed" is not an absent-state rationale — that is how the opencode
   usage crash happened.

The recipe:

1. Add a new `ToolConfig` (toolName, realBinaryName, envVarName,
   globalMemoryProjection, identitiesJsonPath, identitiesRootDir) in a new
   entrypoint file, following
   `src/claude.ts`/`src/codex.ts`/`src/grok.ts`. `realBinaryName` is usually
   just `toolName` again — it's a separate field only because a wrapper's own
   name doesn't have to match the real CLI it proxies (see the "zai case
   study" below for why: `zai` proxies `crush`, a real CLI with no
   relationship to the name "zai" at all). If the new tool's real binary
   needs more than one directory redirected for full identity isolation (no
   single "one env var swaps everything" override — again, see zai/crush),
   add `extraEnvVarNames` too.
2. Call `runWrapper(cfg, appNameForDesktopLaunch)` — everything in
   `src/identities/*` and `src/shared/*` is already tool-agnostic and reusable
   as-is, EXCEPT `src/shared/cli-args.ts`'s `detectNonInteractiveHint()`,
   which hand-codes each tool's actual non-interactive flag/subcommand shape
   (there's no way to infer this generically — read the new tool's own
   `--help` output, don't guess) and a few string-literal unions
   (`ToolConfig.toolName`/`realBinaryName`/`envVarName` in
   `src/identities/types.ts`, `resolveRealBinary()`'s `name` param and
   `resolveAppBundleBinary()`'s `appName` param in
   `src/shared/resolve-binary.ts`, `runWrapper()`'s `appName` param,
   `update.ts`'s `MANAGED_BINARIES`, and `upgrade.ts`'s `UPGRADE_SPECS`) that
   need the new tool's literal added to their union/list. Give the new upgrade
   spec a deterministic installer; a native updater may be retained as a
   fallback only when its exact command is capability-checked through
   `--help` before invocation.
3. Add a build target in `scripts/build.ts`, an install entry in
   `scripts/install.ts` (both the `BINARIES` list and, if the tool owns a
   config directory, the `backupGroups` filter), a backup group in
   `scripts/backup.ts`, an entry in `src/installer.ts`'s `TOOLS`, and a build+
   upload step in `.github/workflows/release.yml`.
4. Add the new `ToolConfig` to `src/cli/identities/resolve-tool.ts`'s
   `TOOL_CONFIGS` map (everything downstream — `toolConfigFromFlag`,
   `resolveMutationTarget`'s ambiguity handling, `ais identities list`/`show`
   — is written generically over `Object.keys(TOOL_CONFIGS)`, not a hardcoded
   pair, so nothing else in `cli/*` needs touching) and to `src/open.ts`'s
   `TOOL_CONFIGS` array (chrome-profile-per-identity support).
5. **Wire the CLI subcommand surface.** `ais identities` is generic (step 4
   covers it); nothing else is:
   - `usage`: `src/cli/usage/providers.ts` (`providerForTool` MUST gain an
     exhaustive case — with `noImplicitReturns` on, omitting it is a compile
     error; plus `PROVIDER_ALIASES`/`PROVIDER_LABELS` entries if the tool
     reports provider names of its own),
     `src/cli/usage/tokscale.ts` (`tokscaleInvocationFor` — again exhaustive),
     and `src/cli/usage/run.ts` (the `runOne` dispatch and the
     `fetchTokscaleDailyUsage` client union).
   - `limits`: a fetcher in `src/cli/limits/` wired into collect.ts's
     `FETCHERS` map (1:1 tools wrap their single-result fetcher via
     `singleToolFetcher`; multi-provider clients return one result per
     provider they can answer for and thread `explicitTool` honestly), or a
     deliberate no-op (the map is `Partial` on purpose — a tool missing from
     it degrades to an honest "no limits fetcher implemented" row).
   - `doctor`: a probe in `src/cli/doctor/collect.ts`'s `PROBES` or a
     deliberate absence (it reports "unavailable" rather than crashing).
   - `resume`: a reader in `src/cli/resume/` or a deliberate absence.
   - `auth` (only if the tool has credentials worth importing): a case in
     `src/cli/auth/`.
   - `providers` (upstream APIs, distinct from tools — e.g. adding a new
     upstream an existing multi-provider client can talk to): alias + label
     entries in `usage/providers.ts`, and a pricing entry in
     `identities/model-pricing.ts` if the upstream charges per token.
6. **Check the new tool's own installer for a PATH-ordering conflict AND a
   pre-existing symlink at the shim destination** before assuming "install to
   `~/.local/bin`" is sufficient — see the two grok bullets under "Key design
   decisions" above for real instances of both: some CLI installers append
   their own `export PATH=...` line to the user's shell rc that can end up
   ahead of `~/.local/bin` (silently making the new shim dead weight), AND/OR
   may have already symlinked `~/.local/bin/<tool>` to their own real binary
   (`ls -la ~/.local/bin/<tool>` — if it's a symlink, `scripts/install.ts`/
   `src/installer.ts` now unlink it first before writing, so this is handled
   generically, but confirm it rather than assuming). Verify with
   `which <tool>` after `bun run install:shims`, not by assumption.
7. Update this file's module tree/design-decision bullets and README.md to
   mention the new tool everywhere claude/codex/grok are currently listed
   together — grep for the two tools you just added alongside to find every
   spot. (The audit test enforces the docs mention every registered tool at
   all; only you can make the mentions *accurate*.)
8. Prove it: `bun run typecheck && bun test` MUST be green — that includes
   `test/tool-wiring.audit.test.ts` (the mechanical gate) and
   `test/cli/usage/providers.test.ts`'s "every registered tool maps to a
   defined provider" loop. Then run the real command once
   (`ais usage`, plus whichever subcommands you wired) — the audit proves
   wiring exists, only execution proves it works.

Note: `src/open.ts` does NOT follow this recipe — it isn't a `ToolConfig`
proxy for another AI CLI, it's a narrower always-transparent-by-default
system-utility shim (see "Chrome-profile-per-identity" design decision above).
Don't reach for the steps above if you're adding another shim in that same
category; follow `src/open.ts`'s shape instead.

### grok case study (2026-07-13)

Concrete example of the above, since grok was the first tool actually added
via this recipe after it was written:

- **`GROK_HOME`** (config-dir env var) was not documented in `grok --help` —
  found via `strings ~/.grok/bin/grok | grep -i grok_home` (turned up
  `$GROK_HOME/trace-exports/...` in a `--help` string for an unrelated flag)
  and cross-checked against `grok inspect`'s "Config Sources" output, which
  confirmed `~/.grok/config.toml` as the default. Default config dir is
  `~/.grok`, matching `~/.claude`/`~/.codex`'s convention.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): grok has `-p`/`--single <PROMPT>` (prints one
  response and exits, like claude's `-p`) AND a `grok agent ...` subcommand
  family ("Run Grok without the interactive UI", the direct analog of
  `codex exec`) — so grok's detection checks both, unlike claude/codex which
  each only need one check.
- **`SESSION_MARKER_PATTERN`** (`src/shared/exec.ts`) was extended to strip
  `GROK_*` env vars defensively, by analogy to the confirmed claude/codex
  nested-session hang — NOT independently reproduced for grok. If a future
  bug report describes grok hanging when invoked from inside an agentic
  session, this is already covered; if grok legitimately needs one of its own
  `GROK_*` env vars passed through from the parent shell, this pattern is the
  first place to check.
- **No desktop app**: no `grok app` subcommand exists (unlike codex) and no
  `/Applications/Grok.app` bundle was found on the machine this was built on.
  `--desktop` is still wired up structurally for grok (same generic code path
  as Claude) for consistency, but is expected to just fail resolving the app
  bundle — this is the one part of the recipe that turned out to have nothing
  real to attach to.
- **The PATH-ordering gap** (see "Key design decisions" above) was discovered
  by inspecting the dev machine's actual `$PATH` output and `~/.zshrc`, not
  assumed — always verify this per-tool rather than trusting the
  `~/.local/bin`-is-already-first assumption that held for claude/codex.
- **grok's own installer had already symlinked `~/.local/bin/grok ->
  ~/.grok/bin/grok`** (and `~/.local/bin/agent -> ~/.grok/bin/agent`) before
  this project ever touched it — `ls -la ~/.local/bin` showed this on the dev
  machine. That collided badly with `scripts/install.ts`'s/`src/installer.ts`'s
  original `copyFile`/`Bun.write` calls: both follow a destination symlink
  and overwrite whatever it points at rather than replacing the symlink
  itself (confirmed empirically — `copyFile(src, dest)` onto a symlinked
  `dest` silently rewrites the symlink's *target* file's contents). Installing
  our `grok` shim would therefore have silently overwritten the REAL
  `~/.grok/bin/grok` binary with our thin wrapper — not merely "the shim
  doesn't intercept anything" like the PATH-ordering gap above, but active
  corruption of the user's real install. Fixed by unlinking the destination
  path first (`rm(dest, { force: true })`) in both `scripts/install.ts` and
  `src/installer.ts`'s `downloadAsset` before writing — this is a general
  fix (protects claude/codex too, if either's real binary is ever symlinked
  at its own shim path for some reason), not grok-specific, but it was grok's
  installer that actually triggered it. `ais update`'s
  `downloadAssetAtomic` was already safe (temp file + `rename()`, which
  replaces the directory entry rather than writing through it) — this bug
  only affected first-time `bun run install:shims` / the standalone
  installer.

### kimi case study (2026-07-17)

Second tool added via the recipe above. All findings below were verified
empirically on this machine, 2026-07-17:

- **Real binary and config root**: `~/.kimi-code/bin/kimi` (v0.26.0,
  Bun-compiled). Config root is `~/.kimi-code` (config.toml, credentials/,
  sessions/, session_index.jsonl, ...) — NOT `~/.kimi`, which is the legacy
  kimi-cli, a different product.
- **`KIMI_CODE_HOME`** (config-dir env var) was not documented in
  `kimi --help` — found via `strings` on the binary (turned up
  `KIMI_CODE_HOME`/`KIMI_CODE_HOME_ENV`), then confirmed live:
  `KIMI_CODE_HOME=/tmp/... kimi doctor` looks for `config.toml`/`tui.toml`
  under the override. Same discovery method as `GROK_HOME`.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): kimi has `-p`/`--prompt <prompt>` ("Run one
  prompt non-interactively and print the response" — the analog of claude's
  `-p`, but note kimi's `-p` is `--prompt`, NOT `--print`) AND an `acp`
  subcommand (ACP server over stdio, the analog of `grok agent`) — so kimi's
  detection checks both.
- **`SESSION_MARKER_PATTERN` (`src/shared/exec.ts`) deliberately does NOT
  strip `KIMI_*`** — the opposite of grok's defensive strip. Checked live
  from inside a running kimi session's own Bash tool (`env`): kimi injects
  NO `KIMI_*` env vars into its tool-spawned environment at all, so there is
  no nested-session marker to strip (unlike claude/codex, whose markers
  caused real hangs, and unlike grok, which was stripped defensively without
  a live session to inspect). A blanket `KIMI_*` strip would only eat a
  user's legitimately exported `KIMI_API_KEY`/`KIMI_BASE_URL`. If nested kimi
  launches ever hang in future, this is the first place to revisit.
- **The PATH-ordering trap is the same class as grok's, and CONFIRMED on
  this machine**: kimi's installer wrote
  `export PATH="/Users/<username>/.kimi-code/bin:$PATH"` at `~/.zshrc`:166-167,
  *after* the `~/.local/bin` export — putting the real binary AHEAD of our
  shim, so the `kimi` shim installs fine but intercepts nothing until the
  user reorders their shell rc (move the `~/.kimi-code/bin` line above the
  `~/.local/bin` export, or re-export `~/.local/bin` after it). Verify with
  `which kimi` → `~/.local/bin/kimi` after `bun run install:shims`. Contrast
  with grok: there was NO pre-existing symlink at `~/.local/bin/kimi`
  (checked) — the unlink-first protection added for grok wasn't needed here,
  but stays generic.
- **Self-updater**: `kimi upgrade` (aliased `kimi update`) exists in
  `kimi --help`, but `ais upgrade` now installs Kimi's managed npm package;
  the native command is only a capability-checked fallback.
- **No desktop app**: no `kimi app` subcommand and no
  `/Applications/Kimi*.app` bundle on this machine (checked 2026-07-17).
  `--desktop` is wired up structurally (same generic
  `runWrapper`/`launchDesktopApp` path) but is expected to just fail
  resolving the app bundle — verified negative 2026-07-17; same caveat as
  grok about re-verifying if the user installs a Kimi desktop app later.
- **Session storage layout drives `src/cli/resume/kimi-resume.ts`'s shape**:
  kimi keeps its own resume index at `<configDir>/session_index.jsonl` — one
  JSON object per line, `{sessionId, sessionDir, workDir}` — plus a
  per-session `state.json` (`{title, createdAt, updatedAt, ...}`) for
  label/timestamps. Reading the index beats walking
  `sessions/wd_<slug>_<hash>/` buckets whose names are a one-way slug+hash of
  the cwd (not reversible). The placeholder title "New Session" counts as no
  label. Relaunch via `kimi --session <id>` (kimi's `-S, --session [id]`).
- **`ais limits` for kimi is a genuinely LIVE fetch** (unlike grok's
  log-scrape): `GET https://api.kimi.com/coding/v1/usages` with the OAuth
  access token from `<configDir>/credentials/kimi-code.json`; expired tokens
  are refreshed via `POST https://auth.kimi.com/api/oauth/token` (kimi-code's
  public OAuth client id — the same refresh-and-persist the kimi CLI itself
  and tokscale both do; persisted back to the credentials file atomically).
  Response = `limits[]` duration-windowed quotas (a 300-minute = 5h session
  window, confirmed live) plus a top-level weekly `usage` quota (resetTime
  exactly 7 days out). Endpoint and response shape confirmed live against the
  real account 2026-07-17; flow cross-checked against tokscale's kimi quota
  fetcher (`crates/tokscale-cli/src/commands/usage/kimi.rs`). Under
  `--cached`, kimi reports "not available" like claude/codex (no offline
  cache).
- **tokscale/`ais usage`**: kimi works exactly like codex/grok — tokscale's
  kimi client (client id `kimi`, confirmed in tokscale's README `--client`
  list and its sessions scanner, 2026-07-17) reads `KIMI_CODE_HOME` and scans
  `<home>/sessions` — the same env var this project redirects per identity.
  `EXTRA_DIR_RELATIVE` for kimi is `sessions`. Not yet re-verified against
  real per-identity kimi data the way claude/codex were.
- **Disk layout / migrate**: `~/.kimi-code/identities.json` +
  `~/.kimi-code/identities/<name>/`, same container pattern as the others.
  `scripts/migrate.ts` was intentionally NOT extended (same stance as grok):
  the existing `~/.kimi-code` default-login content stays at the container
  level and is simply not part of any identity; first identity via
  `ais identities create --tool=kimi` or the picker. `scripts/backup.ts`
  group: `kimi: [".kimi-code"]`.
- **Ships on every platform** (like grok, not darwin-gated like `open`):
  `scripts/build.ts`, `scripts/install.ts`, `src/installer.ts`'s `TOOLS`,
  `src/cli/update.ts`'s `MANAGED_BINARIES`, and
  `.github/workflows/release.yml` all include kimi. New source files:
  `src/kimi.ts` (entrypoint, `runWrapper(KIMI_CONFIG, "Kimi")`),
  `src/cli/resume/kimi-resume.ts`, `src/cli/limits/kimi-limits.ts`;
  string-literal unions widened across `src/identities/types.ts`,
  `src/shared/{cli-args,resolve-binary,run-wrapper,launch-desktop}.ts`,
  `src/open.ts`, `src/cli/{identities/resolve-tool.ts,update.ts,upgrade.ts,
  usage/*,limits/*,resume/*}`, `src/cli/help.ts`.
- **Chrome (Claude MCP) redirects work for wrapped kimi sessions too** —
  `src/open.ts`'s `TOOL_CONFIGS` includes kimi — under the SAME two
  still-unverified assumptions documented in "Chrome profile per identity"
  below (that the real kimi binary shells out to bare `open` via PATH, and
  that the invocation shape is bare `open <url>`). Never re-verified for
  kimi; the real binary IS Bun-compiled, so the circumstantial evidence for
  assumption 1 is the same strength as claude's.

### zai case study, take 1 (2026-07-17) — RETIRED same day, kept for the "why"

**Superseded by "zai case study, take 2" below, a few hours later in the same
day.** Everything in this subsection describes the FIRST design (`zai` proxies
`opencode`) and is no longer how the code works — kept only so the reasoning
that led to it, and the reasoning that overturned it, aren't lost. If you're
looking for how `zai` actually works today, skip to take 2.

Third tool added via the recipe above, and the first that DOESN'T fit it
cleanly — it's a fake proxy identity name for a real CLI (`opencode`) that
has nothing to do with the name "zai" at all, and that real CLI's own config
model doesn't match the "one env var swaps the whole identity" assumption
every other tool relies on. Findings below were verified empirically on this
machine, 2026-07-17 (a mix of live `bunx opencode-ai@latest ...` runs against
the real npm package, on-disk inspection after the user's own real
`opencode auth login`, and source-level research of `anomalyco/opencode`,
formerly `sst/opencode`):

- **What "zai" actually is**: there is no real "zai" CLI. ZAI (Z.ai/Zhipu AI,
  maker of the GLM models) is a *provider* supported natively inside
  OpenCode (github.com/anomalyco/opencode, npm `opencode-ai`, brew
  `opencode`, binary name `opencode`) — provider id literally `"zai"`
  (confirmed in opencode's own `packages/opencode/src/provider/transform.ts`),
  built into its models.dev provider registry, no custom provider JSON
  needed. So `zai --identity=<name> ...` is a normal identity-switching proxy
  in every way that matters to the user, but the binary it ultimately execs
  is `opencode`, configured (via that identity's own auth login) to talk to
  the ZAI provider — hence `ToolConfig.realBinaryName: "opencode"` while
  `toolName` stays `"zai"`.
- **No single config-dir override — CONFIRMED from source
  (`packages/core/src/global.ts`)**: opencode follows the XDG base-dir spec
  directly via the `xdg-basedir` npm package: config under
  `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`; overridable
  instead by the bespoke `OPENCODE_CONFIG_DIR`, which fully replaces just the
  config lookup), but **auth/credentials** (`auth.json`, confirmed on disk at
  `~/.local/share/opencode/auth.json`, mode 0600, immediately after the
  user's own real login) under `$XDG_DATA_HOME/opencode` — a DIFFERENT root,
  independent of the config dir — and cache/state under
  `$XDG_CACHE_HOME`/`$XDG_STATE_HOME` respectively. Full identity isolation
  therefore needs FOUR env vars, not one. Resolved by pointing envVarName
  (`OPENCODE_CONFIG_DIR`, the bespoke one — used as resolve.ts step (b)'s
  "already resolved" signal, same as every other tool's primary var) AND
  `extraEnvVarNames` (`XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`) at
  the SAME identity `configDir` value, so config/auth/cache/state for one
  identity all land together under `<configDir>/opencode/` (opencode itself
  always appends that `/opencode` suffix to each XDG var — this one level of
  extra nesting isn't something this project's own code controls) — matching
  every other tool's "one directory = one identity, holds everything" shape
  rather than fragmenting one identity's data across up to four physical
  roots. `run-wrapper.ts` and `launch-desktop.ts` both now mirror
  `extraEnvVarNames` alongside the primary var wherever they inject env —
  every other tool's `extraEnvVarNames` is simply absent, so this is a no-op
  for them.
- **Trade-off accepted, not fully solved**: `XDG_CONFIG_HOME` etc. are
  generic, standards-based env vars plenty of unrelated XDG-aware CLIs read
  too — unlike `KIMI_CODE_HOME`/`GROK_HOME`, a user is somewhat more likely to
  already have one of these set globally for unrelated reasons, which
  resolve.ts step (b) would then (mis)treat as "the zai identity is already
  resolved." This risk is inherent to opencode's own design (no bespoke
  override covers auth/data at all) and isn't something this project's
  wrapper code can close — noted here so it isn't rediscovered as a surprise.
- **Auth — CONFIRMED live**: canonical command is `opencode auth login`
  (`providers login` is the real subcommand; `auth` is a registered top-level
  alias) — interactive only (clack-style prompts for provider then
  key/OAuth), no way to script it non-interactively via flags alone. There is
  no way to preconfigure the ZAI provider from outside opencode's own login
  flow — **the user must run `zai --identity=<name> auth login` (or the
  underlying `opencode auth login` with the right env already set) for EACH
  identity themselves**; this project can wire up the identity/env-var
  plumbing but cannot complete an interactive credential prompt on the user's
  behalf.
- **Non-interactive detection** (`detectNonInteractiveHint` in
  `src/shared/cli-args.ts`): `opencode run [message..]` ("run opencode with a
  message" — opencode `--help`) is the analog of claude's `-p`/codex's
  `exec`/grok's `agent`/kimi's `-p`; `opencode acp` (its own Agent Client
  Protocol server) is the analog of kimi's `acp`. Opencode has no top-level
  `-p`/`--prompt` shorthand outside the `run` subcommand itself — confirmed
  via live `--help`.
- **`SESSION_MARKER_PATTERN` (`src/shared/exec.ts`) strips
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`/`OPENCODE_CLIENT`
  narrowly** (not a blanket `OPENCODE_*` prefix, which would also needlessly
  catch the legitimate `OPENCODE_CONFIG_DIR`/`XDG_*` vars this project itself
  injects — though those get re-applied via `extraEnv` after the strip
  anyway, so a blanket prefix would have been harmless, just needlessly
  wide). Per `anomalyco/opencode` GitHub issue #14532: the opencode desktop
  app sets these three on its own spawned processes for its internal server's
  Basic Auth, and a nested `opencode run` inheriting them enforces auth on
  requests its own client never sends, failing silently — the same
  nested-invocation failure shape as claude/codex's own markers, but (like
  grok's, unlike kimi's) NOT independently reproduced by hand here, only
  sourced from the linked issue.
- **`--id`/`--identity` collision check**: opencode's own `-i`/`--interactive`
  is scoped to the `run` subcommand only, not top-level, so it can't collide
  with our `--id`.
- **Self-updater is `opencode upgrade [target]`, NOT `update`** — confirmed
  live (`opencode update --help` silently falls through to the default TUI
  entrypoint instead of erroring, i.e. "update" isn't recognized as a
  subcommand at all). This broke `upgrade.ts`'s historical assumption that
  every wrapped tool's self-updater is invoked with a literal `"update"` arg.
- **Desktop app**: unlike grok/kimi (confirmed absent), a real `OpenCode.app`
  DOES exist as a Homebrew cask (`opencode-desktop`, artifact `OpenCode.app`)
  — but it wasn't installed on this machine, so `--desktop` for zai is wired
  up structurally (same generic path, appName `"OpenCode"`) but UNVERIFIED
  both on whether the Mach-O binary name inside the bundle actually matches
  and on whether the app respects the injected env vars at all.
- **Resume/doctor support still absent; limits added 2026-09-03**: opencode's
  session storage is a SQLite db (`opencode.db`, confirmed on disk), not the
  JSONL/log formats every existing `resume` reader parses, and it has no
  doctor probe — both remain out of scope. `resume/collect.ts`'s `READERS`
  and `doctor/collect.ts`'s `PROBES` being `Partial` records is precisely so
  a tool can exist in the identities registry before its own
  reader/probe does, degrading to an honest "not implemented yet" result
  instead of a crash. Likewise `ais usage`'s tokscale integration (see the
  design decision above) reports "not supported" for a tool without a
  tokscale client rather than crashing.
- **Limits support, added 2026-09-03**: opencode's auth.json (under the
  identity's own `data/opencode/`) holds one static API credential per
  upstream plan, and the `zai_coding_plan` key is the SAME Z.ai account the
  zai tool queries, so `ais limits` reuses the same quota endpoint
  (`fetchZaiQuotaForKey`). `alibaba_token_plan` is skipped as native-covered
  (the Token plan has no API-key quota endpoint — only ali's console-cookie
  path can answer), and unknown provider ids are ignored rather than guessed
  at. See "provider-first limits for the multi-provider clients" below.
- **No migrate support**: `~/.zai` starts empty, same stance as grok/kimi —
  there's no pre-existing "default" opencode login worth preserving under an
  identity, so `scripts/migrate.ts` was not extended. First identity via
  `ais identities create --tool=zai` or the interactive picker.
- **Ships on every platform** (like grok/kimi, not darwin-gated like
  `open`): `scripts/build.ts`, `scripts/install.ts` (`BINARIES` +
  `backupGroups`), `scripts/backup.ts` (`BACKUP_GROUPS.zai: [".zai"]`),
  `src/installer.ts`'s `TOOLS`, `src/cli/update.ts`'s `MANAGED_BINARIES`, and
  `.github/workflows/release.yml` all include zai. New source files:
  `src/zai.ts` (entrypoint, `runWrapper(ZAI_CONFIG, "OpenCode")`);
  string-literal unions widened across `src/identities/types.ts`,
  `src/shared/{cli-args,resolve-binary,run-wrapper,launch-desktop,exec}.ts`,
  `src/open.ts`, `src/cli/{identities/resolve-tool.ts,update.ts,upgrade.ts,
  usage/*,limits/{types,collect}.ts,resume/{types,collect}.ts}`,
  `src/cli/help.ts`.
- **Chrome (Claude MCP) redirects are wired for wrapped zai sessions too** —
  `src/open.ts`'s `TOOL_CONFIGS` includes `ZAI_CONFIG` — under the SAME
  still-unverified assumptions documented in "Chrome profile per identity"
  below. Never tested for zai/opencode at all (opencode's own login flow
  wasn't driven through this project's `open` shim during this pass — the
  user authenticated directly against opencode's global default location
  before this project's per-identity redirection existed).

### zai case study, take 2 (2026-07-17) — RETIRED same day, kept for the "why"

**Superseded by "zai case study, take 3" below, later the same day.** Everything
in this subsection describes the SECOND design (`zai` proxies `claude`,
redirected via `ANTHROPIC_BASE_URL`) and is no longer how the code works —
kept only so the reasoning that led to it, and the reasoning that overturned
it, aren't lost. If you're looking for how `zai` actually works today, skip
to take 3.

Same day as take 1 above, same afternoon even — the user asked to install
"ZCode" (a name from an earlier, wrong recommendation) and swap `opencode`
for it. Investigating that request is what actually overturned take 1's
whole premise, not a change of requirements.

- **ZCode (zcode.z.ai) turned out to be un-wrappable — CONFIRMED by directly
  reading its docs, not assumed.** It's a desktop-only Electron app (DMG
  download for macOS, "ZCode Agent"/"Goal Mode"/"Remote Control" are all GUI
  features) with NO CLI, headless mode, or scriptable API — checked its own
  "Remote Control" docs page specifically since that sounded most likely to
  expose one, and it's purely a phone-to-desktop QR-code pairing feature, not
  a terminal interface at all. This project's entire wrapper model depends on
  a real binary to shadow on `PATH` and `Bun.spawn` — there is nothing here to
  wrap. (The earlier recommendation that called ZCode "Z.ai's own first-party
  CLI" was wrong — inferred from a search snippet by analogy to Cline/Roo
  Code/OpenCode, never actually verified before being stated. Worth naming
  plainly: it was a real mistake, not a data change, and got caught only
  because the user pushed back on the contradiction.)
- **`@z_ai/coding-helper` (npm, bin `chelper`/`coding-helper`) is Z.ai's
  actual official terminal integration — CONFIRMED by reading its source
  directly** (`dist/lib/claude-code-manager.js` in the published package,
  fetched via `bunx --bun @z_ai/coding-helper@latest`, then located in
  `~/.bun/install/cache/@z_ai/coding-helper@.../dist/`). It is NOT an agent
  CLI — `chelper --help` shows `auth`/`doctor`/`enter`/`init`/`lang`, and its
  own examples include `chelper enter claude-code` ("Interactive Configure
  Claude Code tool") and `chelper auth reload claude` ("Reload plan config to
  Claude Code"). Its entire purpose is configuring OTHER tools — specifically
  the REAL Claude Code CLI — to talk to Z.ai, confirming Z.ai's GLM Coding
  Plan ships an Anthropic-compatible endpoint
  (`https://api.z.ai/api/anthropic`) specifically so Claude Code works as a
  drop-in client with zero code changes on Anthropic's or Claude Code's side.
  This is the same "claude + `ANTHROPIC_BASE_URL`" path independently
  identified (but not yet implemented) before take 1 was ever built — chelper
  is just Z.ai's own official tool for doing that configuration, not a
  reason to build something new.
- **`chelper` writes exactly this, confirmed from source
  (`ClaudeCodeManager.loadGLMConfig`)**: merges into
  `<home>/.claude/settings.json`'s `env` block —
  `ANTHROPIC_AUTH_TOKEN` (the Z.ai API key), `ANTHROPIC_BASE_URL`
  (`https://api.z.ai/api/anthropic` for the global plan, `https://open.bigmodel.cn/api/anthropic`
  for the China plan), `API_TIMEOUT_MS: '3000000'`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1` — and separately ensures
  `<home>/.claude.json` (note: NOT inside the `.claude/` directory — a
  sibling file) has `hasCompletedOnboarding: true`, to skip Claude Code's
  first-run onboarding wizard.
- **`chelper` hardcodes `homedir()` for both paths — CONFIRMED from source
  (`join(homedir(), '.claude', 'settings.json')` /
  `join(homedir(), '.claude.json')`, no env-var override anywhere) — so it
  can't be pointed at a specific identity's directory directly.** Running it
  naively would always write to the REAL top-level `~/.claude` container
  (which this project deliberately keeps generic/unused — see "Disk
  layout"), not any identity. Rather than fighting this (e.g. faking `HOME`
  when spawning it, which would need a `.claude`-subdirectory-under-fake-home
  shape that doesn't match how this project's identity dirs are laid out —
  they ARE the CLAUDE_CONFIG_DIR directly, no extra nesting), this project
  just writes the same two files itself, directly into each zai identity's
  own `configDir` — reusing the exact shape chelper's source revealed, not
  guessed at. `chelper` remains useful as a REFERENCE and for the user's own
  ad-hoc use outside this project, just not as something this project's code
  shells out to.
- **Confirmed Claude Code itself (not just this project's convention)
  redirects BOTH files under `CLAUDE_CONFIG_DIR`** — inspected a real,
  already-in-use claude identity directory
  (`~/.claude/identities/identity-a/`) and found both `settings.json` and
  `.claude.json` living directly there, side by side. This is why zai's
  identity dirs can hold the same two files at the same top level and have
  the real `claude` binary read them correctly once `CLAUDE_CONFIG_DIR`
  points there — nothing project-specific needed beyond what already existed
  for every other claude identity.
- **New `ZAI_CONFIG` shape**: `realBinaryName: "claude"` (not `"opencode"`),
  `envVarName: "ZAI_CONFIG_DIR"` (a bespoke, otherwise-unused var — see next
  bullet for why it can't just be `CLAUDE_CONFIG_DIR`), `extraEnvVarNames:
  ["CLAUDE_CONFIG_DIR"]` (the actual var the real `claude` binary reads).
  `extraEnvVarNames` — built for take 1's XDG multi-var need — turned out to
  be exactly the right mechanism for a completely different reason here, so
  it stayed in `ToolConfig` rather than being removed once take 1's original
  use for it went away.
- **Why `envVarName` can't just be `CLAUDE_CONFIG_DIR` even though the real
  binary IS claude**: `src/open.ts`'s `resolveActiveChromeMcpTarget` picks
  which `ToolConfig` is active by
  `TOOL_CONFIGS.find((cfg) => process.env[cfg.envVarName])` — if `ZAI_CONFIG`
  and `CLAUDE_CONFIG` shared the literal same `envVarName`, this always
  matches `CLAUDE_CONFIG` first (it's earlier in the array), unable to tell a
  zai identity apart from a plain claude one. Giving zai its OWN envVarName,
  with the real var mirrored via `extraEnvVarNames` instead, keeps this
  lookup — and resolve.ts step (b)'s "already resolved" check — unambiguous
  for both ToolConfigs despite sharing a real binary. This is a genuinely NEW
  class of collision take 1 never had (opencode's env vars never overlapped
  with any other tool's).
- **Non-interactive detection, `SESSION_MARKER_PATTERN`, `--desktop`, and
  self-update all collapsed back to "identical to claude"** now that the real
  binary IS claude: `detectNonInteractiveHint` merges zai into claude's own
  `-p`/`--print` branch instead of a separate opencode-flavored one;
  `SESSION_MARKER_PATTERN` no longer needs an `OPENCODE_SERVER_*` entry (the
  existing `CLAUDE` prefix already covers zai's nested-session risk, since
  it's the same binary); `--desktop` now launches `Claude.app` (same appName
  as the primary claude wrapper) instead of a nonexistent `OpenCode.app`
  attempt; and `ais upgrade`'s `WRAPPED_TOOLS` DROPPED its zai entry entirely
  rather than adding one — `CLAUDE_CONFIG`'s own entry already runs
  `claude update`, which updates the exact same binary zai uses, so a
  separate zai entry would just run the identical command twice.
- **Auth is now a one-time file write per identity, not an interactive login
  the user has to redo per identity.** Reused the SAME Z.ai API key value the
  user had already obtained (captured from `opencode`'s own `auth.json`
  before it was retired — a plain API key, not something opencode-specific,
  so it transfers directly into `ANTHROPIC_AUTH_TOKEN`) rather than asking
  the user to obtain a new one. No browser OAuth flow is involved at any
  point in this design (unlike claude's own real login) — it really is just
  an API key in a JSON file — so `src/open.ts`'s Chrome-MCP-redirect
  mechanism (built for auto-opened OAuth links) is expected to simply never
  trigger for zai sessions; left wired up anyway for consistency, not because
  it's known to matter here.
- **`~/.zai` stays its OWN registry, separate from `~/.claude`'s — an
  explicit requirement, not a default this project chose.** A user may want
  e.g. a "identity-a" identity in BOTH: one real, Anthropic-backed (via
  `claude`), one Z.ai-backed (via `zai`) — genuinely different accounts/
  billing that happen to share a project-context name. Merging zai identities
  into `~/.claude/identities.json` would make that impossible (one registry,
  one namespace, `identity-a` could only mean one thing); keeping `~/.zai`
  separate is exactly what makes both coexist.
- **opencode uninstalled** (`brew uninstall opencode`) — Homebrew's own
  autoremove then pruned its now-unneeded dependency closure too (including a
  brew-managed `node`, distinct from the `nvm`-managed one `codex` relies on
  — see the module map above), unprompted but expected default `brew
  uninstall` behavior on this machine, not something this project's tooling
  triggered. Opencode's now-orphaned GLOBAL data dirs
  (`~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode`,
  `~/.local/state/opencode`) were deliberately left alone — uninstalling a
  package doesn't imply deleting a user's data outside this project's own
  `~/.zai` tree, and nothing here depends on them being gone.
- **resume/limits/usage support for zai is STILL not implemented — but the
  reason changed, and the old reasoning (opencode's SQLite format) is no
  longer true.** Since zai's session files are now literally claude's own
  format, `ais resume --tool=zai`/tokscale's claude client could both
  technically work today via the exact same tricks already used for
  `"claude"`. Deliberately still not wired up: tokscale has no `"zai"` client
  id of its own, so the only way to surface zai's data would be under
  tokscale's OWN `"claude"` label — indistinguishably merging real
  Anthropic-billed usage with Z.ai-billed usage in one rollup, which needs to
  be a deliberate, separately-considered choice, not a reflexive add-on to
  this pass. `resume/collect.ts`'s `READERS`/`limits/collect.ts`'s
  `FETCHERS` being `Partial` records still means this degrades to an honest
  "not implemented yet" instead of a crash in the meantime.

### zai case study, take 3 (2026-07-17): Crush, a real multi-provider CLI

Same day as takes 1 and 2, later still — surfaced by the user actually
*using* a take-2 zai identity and noticing Claude Code displayed "Opus" even
though the account was GLM-backed ("Claude code says opus when the models
are GLM"), then, when told this was inherent to piggybacking on Claude
Code's own client, pushing back with "is OpenCode really our only/best
option?" — a fair challenge take 2 itself never re-litigated once take 1 was
abandoned.

- **Take 2's actual flaw, confirmed by reasoning about the integration
  shape, not observed as a bug in this project's own code**: Z.ai's Anthropic-
  compatible endpoint (what take 2 relies on) transparently remaps whatever
  model alias Claude Code sends (e.g. "opus") to a GLM model server-side —
  but Claude Code's own UI has no visibility into that remap, so it keeps
  showing its own Anthropic alias regardless of what actually answered. This
  is inherent to "reuse an existing client's protocol compatibility layer,"
  not something fixable by writing different config — the only fix is
  wrapping a client that is ACTUALLY aware it's talking to Z.ai/GLM.
- **Re-evaluated take 1's own original blocker (interactive-only opencode
  auth) instead of assuming it still held** — and it didn't: opencode's real
  auth file (`$XDG_DATA_HOME/opencode/auth.json`,
  `{"zai": {"type": "api", "key": "..."}}`) can be written directly with zero
  `opencode auth login` ever run, confirmed live (no prior investigation had
  actually tried this — take 1 accepted the interactive-only conclusion from
  reading opencode's own CLI surface, not from testing whether the
  underlying credential file itself was writable).
- **Didn't stop at re-confirming opencode — checked Z.ai's own docs for
  every terminal tool it officially supports**, not just the one already
  tried: `docs.z.ai/devpack/tool/*` lists Droid, Crush, Goose, OpenClaw, and
  OpenCode as officially documented CLI integrations (distinct from IDE
  extensions like Cline/Roo/Kilo). Ruled out: Droid needs an interactive
  Factory-account browser login even for BYOK; Goose has no dedicated Z.ai
  provider (open feature request); Aider's GLM support is
  inconsistent/community-patched, not officially documented by Z.ai at all.
- **Crush (github.com/charmbracelet/crush) chosen over OpenCode** — both
  are real, genuinely multi-provider CLIs that display the actual model
  (not a translated alias), and both can be configured non-interactively.
  Crush's edge: its own config format is a plain, Z.ai-documented JSON file
  (`crush.json`, not something reverse-engineered from a compiled binary the
  way opencode's `auth.json` shape had to be), its config isolation needs
  only 2 env vars (`CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA`) vs opencode's
  4-way XDG spread, and it's actively shipping (backed by Charm, v0.85.0
  released the day before this was written).
- **Confirmed live, not assumed from Z.ai's docs alone** (2026-07-17,
  `crush@0.85.0`): `crush dirs` reflects `CRUSH_GLOBAL_CONFIG`/
  `CRUSH_GLOBAL_DATA` overrides correctly. Writing a plain `crush.json` with
  a `"zai"` provider entry (`id`/`name`/`base_url`/`api_key`) and running NO
  `crush login` was enough for `crush run "..." --model zai/glm-4.6` to
  attempt a REAL request to Z.ai's endpoint — rejected only for an invalid
  placeholder key (`unauthorized: token expired or incorrect`), proving the
  config was actually read and used for the request. This mattered because
  `crush models` alone is NOT sufficient proof: it lists every `zai/glm-*`
  model unconditionally even with a completely empty/absent config — it's
  Crush's own static catalog, not evidence of a working, configured
  provider. Z.ai's own doc sample for Crush also omits the `models` array
  every other provider's example includes; empirically this turned out not
  to matter (the "zai" provider was already known to Crush's own catalog),
  but that was a real, flagged unknown going in, not assumed away.
- **New `ZAI_CONFIG` shape**: `realBinaryName: "crush"`, `envVarName:
  "CRUSH_GLOBAL_CONFIG"`, `extraEnvVarNames: [{ name: "CRUSH_GLOBAL_DATA",
  subdir: "data" }]` (the `subdir` form — see the 2026-07-18 addendum below
  for why a bare shared value, which is what this originally shipped as,
  turned out to be wrong). Crush's real binary name is unique among this
  project's five ToolConfigs (unlike take 2, which shared `claude` with the
  primary claude wrapper and needed a bespoke `envVarName` purely to avoid
  `open.ts`'s envVarName-based lookup colliding with `CLAUDE_CONFIG`) — one
  less moving part than take 2 had, not just a swap of one binary name for
  another.
- **Non-interactive auth is a NEW capability, not carried over from either
  prior take** — this is what actually closes take 1's original gap for
  good, independent of which tool ended up wrapped. `identities/zai-auth.ts`'s
  `writeZaiAuthFile()` does a read-modify-write into `<configDir>/crush.json`
  (preserves any other config already there — matters for rotating a key on
  an in-use identity, not just fresh creation). Wired into BOTH
  `cli/identities/create.ts`'s `--api-key=` flag (or an interactive prompt if
  omitted — optional, since a user may want to configure Crush manually
  instead) AND `identities/prompt.ts`'s own independent `createIdentityFlow`
  (the interactive-picker's "+ Create new identity" path) — confirmed no
  per-tool-extra-field concept existed anywhere in this codebase before this,
  so both call sites needed the identical addition or they'd have drifted.
  `ais identities update --tool=zai --api-key=<key>` rotates a key later
  without recreating the identity — handled as its own step in
  `cli/identities/dispatch.ts`'s "update" case, not threaded through
  `actions.updateIdentity`/`UpdateIdentityInput`, since an API key isn't
  `identities.json` metadata (kept out of the more casually viewed/backed-up
  registry file entirely).
- **`ais upgrade` includes zai even though Crush has no self-updater.** Its
  real binary's `--help` still has no `update`/`upgrade` command (the
  `update-providers` command is unrelated), so AIS installs/upgrades the
  documented `@charmland/crush` npm package in its managed real-CLI prefix.
  This is precisely why upgrade cannot be modelled as a flat loop over native
  updater subcommands.
- **resume/limits/usage support for zai is STILL not implemented, and the
  take-2 rationale ("zai's session files are literally claude's own format")
  no longer applies at all** — Crush's own session storage format hasn't
  been investigated in this pass. `resume/collect.ts`'s `READERS`/
  `limits/collect.ts`'s `FETCHERS` being `Partial` records still means this
  degrades to an honest "not implemented yet" instead of a crash.
  **Superseded for limits/usage by the 2026-07-18 addendum below** — Z.ai
  has its own live quota API (nothing to do with Crush's session storage at
  all), which closes both gaps; `resume` is still genuinely unimplemented,
  no live API covers it.
- **`opencode` was already uninstalled during take 2** (see take 2's own
  notes above) — Crush was installed fresh for this pass
  (`brew install charmbracelet/tap/crush`), unrelated to opencode's prior
  presence or absence.

#### zai/Crush addendum (2026-07-18): GLM-only model list, and two footguns found getting there

Take 3 shipped with zai working (real GLM responses, correct model name
display), but the very next real-world use surfaced a follow-up complaint:
the user opened Crush and saw Gemini, Grok, OpenAI, and dozens of reseller
providers alongside GLM — "It should just be GLM." Chasing that down surfaced
two confirmed, previously-undiscovered Crush behaviors, both load-bearing for
anyone touching this again:

- **The fix: `"options": {"disable_default_providers": true}` in
  `crush.json`, PLUS a fully self-contained custom "zai" provider entry.**
  Crush ships zai/GLM as a built-in provider already (its embedded Catwalk
  catalog, id `"zai"`, native `ZAI_API_KEY` env var support) — which is
  *why* take 3's original override-only entry (just `base_url`/`api_key`)
  was enough to work at all, but that catalog is *also* where every other
  provider (Gemini, Grok/xAI, OpenAI, Anthropic, 30+ resellers) comes from,
  and Crush's model picker/`crush models` lists the whole thing unconditionally
  by design (`crush --help`: "choose the provider of your choice, and paste
  your API key" — the picker is *meant* to show every known provider).
  `disable_default_providers` (confirmed via Crush's own source,
  `internal/config/provider.go`'s `Providers()`) skips loading that catalog
  entirely, but then requires each provider to be FULLY self-specified
  (`type` + non-empty `models`) to count as "configured" at all — an
  override-only entry that relied on the (now-skipped) built-in catalog to
  fill in `type`/`models` stops validating, and Crush refuses to start
  ("default providers are disabled and there are no custom providers are
  configured"). `identities/zai-auth.ts` now writes `type: "openai-compat"`
  and a static `models` array (copied from Crush's own real Catwalk "zai"
  entry, 11 GLM models) for exactly this reason. `discover_models: true` is
  also set: confirmed live that with a *working* key, Crush merges in a
  live-fetched model list from Z.ai's own API on top of the static one
  (harmless — the live-fetched 8-model set was a strict subset of the static
  11 in testing, so the merge changed nothing observable) — kept mainly so a
  real key stays authoritative if Z.ai's own live list ever drifts from what's
  hardcoded here. The static list is what keeps a freshly-created zai identity
  (blank key, "configure later") able to start Crush at all and browse
  models — without it, a missing/invalid key would fail discovery with
  nothing to fall back to, and the provider would be dropped entirely.
  Verified live (2026-07-18): `crush models` scoped to a configured identity
  now shows exactly the 11 `zai/glm-*` entries and nothing else.
- **Footgun #1 (real incident, caught and fixed same session): `crush
  update-providers <path>` ignores `CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA`
  entirely.** It was tried first, as a way to seed each identity's own
  trimmed provider cache — but confirmed via Crush's own source
  (`cachePathFor()` in `provider.go`) that this cache path is controlled
  ONLY by `XDG_DATA_HOME` (or the OS default `~/.local/share/crush`),
  completely independent of this project's per-identity env vars. Running
  `crush update-providers` scoped to one zai identity actually overwrote the
  REAL, shared, global `~/.local/share/crush/providers.json` with a
  zai-only list — corrupting the default Crush install (and any other
  identity, or ad-hoc `crush` use outside this project) until a plain `crush
  update-providers` (no path arg) was run again to re-fetch the full 39-
  provider catalog from Catwalk and restore it. **Do not use
  `update-providers` for any kind of per-identity scoping — it is
  fundamentally a global, unscoped operation regardless of what env vars are
  set.** `disable_default_providers` (above) sidesteps this cache path
  entirely (the whole default-catalog fetch is skipped, so this cache is
  never touched for a zai identity), which is the other reason it's the
  right fix rather than a merely-preferred one.
- **Footgun #2 (real bug in this project's own `ZAI_CONFIG`, caught and fixed
  same session): pointing `CRUSH_GLOBAL_CONFIG` and `CRUSH_GLOBAL_DATA` at
  the literal same directory — take 3's original, shipped design — makes
  Crush double-register every provider/model.** Confirmed live and
  reproduced deliberately: an identical `crush.json` (11 configured GLM
  models) produced 22 entries in `crush models` when both env vars pointed
  at the same path, and exactly 11 when they pointed at two different
  directories (nested or sibling, either was fine — just not identical).
  Not documented anywhere in Crush's own docs or source comments; found by
  bisecting a working scratch config against the real, broken `identity-a`
  identity until the one differing variable (same-vs-different dir) was
  isolated. Fixed generically, not with a zai-only special case: `ToolConfig
  .extraEnvVarNames` (`identities/types.ts`) changed from `string[]` to
  `Array<{ name: string; subdir?: string }>`, and `run-wrapper.ts`/
  `launch-desktop.ts` both now join `subdir` onto the resolved configDirValue
  when present instead of always mirroring the bare value. `ZAI_CONFIG` sets
  `{ name: "CRUSH_GLOBAL_DATA", subdir: "data" }` — crush's session/model-
  cache state now lives at `<configDir>/data/`, one level below `crush.json`
  itself, still fully within the identity's own configDir (so "one directory
  = one identity, holds everything" from identities.json's point of view
  still holds; it just isn't literally one flat directory internally
  anymore). This is a generic mechanism fix, not zai-specific plumbing — any
  future tool needing more than one redirected directory can reuse `subdir`
  instead of re-deriving this.

#### zai/Crush addendum (2026-07-18, later): `ais limits`/`ais usage` support, live API instead of Crush's own storage

Prompted directly: "Zai has no usage or limits fetcher but should be possible
via the API." Investigating turned up something neither prior take-3 pass
had checked — Z.ai itself exposes a live account-quota API, completely
independent of Crush and never previously looked for.

- **Confirmed live (2026-07-18) against a real "GLM Coding Max" account on
  this machine**: `GET https://api.z.ai/api/monitor/usage/quota/limit` with
  `Authorization: Bearer <key>` returns `data.limits[]`, each entry keyed by
  `(type, unit, number)` rather than a free-text label —
  `TOKENS_LIMIT`/`unit:3,number:5` is the 5h session window,
  `TOKENS_LIMIT`/`unit:6,number:1` is the weekly window, and a third
  `TIME_LIMIT`/`unit:5,number:1` entry is a separate MONTHLY allowance for
  web tools (search-prime/web-reader/zread call counts, not tokens — cross-
  checked its `nextResetTime` against `/api/biz/subscription/list`'s own
  monthly billing cycle, which matched). `percentage` is already 0-100, not
  a 0-1 fraction (confirmed: a same-day-created, barely-used account showed
  `percentage: 1`, not `100`). None of this is documented anywhere in
  `docs.z.ai`'s official API reference — found by reading real
  implementations, not Z.ai's own docs (see next bullet).
- **Found via independent reimplementation, not Z.ai's docs**: a subagent
  search turned up 15+ open-source tools already hitting this exact
  endpoint (tokscale, Raycast's `agent-usage` extension, `openusage`,
  `CodexBar`, and more) — Z.ai has an official first-party usage-check
  Claude Code plugin too (`docs.z.ai/devpack/extension/usage-query-plugin`)
  but its docs don't disclose the underlying endpoint either. tokscale's own
  Rust source (`crates/tokscale-cli/src/commands/usage/zai.rs`) was read
  directly to confirm the exact URL/header/response shape before writing any
  code against it — then verified independently with a real `curl` against
  the live endpoint (matched exactly).
- **CRITICAL caveat, found only by actually running it, not by reading
  source: tokscale's zai client is in its GitHub repo but NOT YET in any
  published release.** Confirmed 2026-07-18: `npm view tokscale versions`
  tops out at `4.5.3` (also `dist-tags.latest`, also what `bunx
  tokscale@latest` — this project's own `resolveTokscaleCommand()` fallback —
  actually resolves to), and running `ais usage --tool=zai` for real against
  that version fails with tokscale's own CLI error: `error: invalid value
  'zai' for '--client <CLIENTS>'` (its valid-values list has no "zai" at
  all yet). So as of this writing, `ais usage --tool=zai` does NOT actually
  work end-to-end — it fails cleanly (the existing "report the error,
  don't crash" path handles it fine) rather than silently.
  **CORRECTED same day, below: this bullet's "forward-compatible, will start
  working once tokscale ships a release" framing was WRONG** — the premise
  (zai.rs just hasn't shipped yet) was right, but the conclusion (that
  shipping it would make THIS report work) doesn't hold. Kept here, marked
  corrected, rather than silently rewritten, since it was already committed
  and pushed before the correction.
- **CORRECTION (2026-07-18, same day, prompted directly by the user's
  confusion — "thought we said ZAI API can be used for `ais usage`?"): the
  bullet above mixed up TWO SEPARATE tokscale subcommands.** `bunx
  tokscale@latest --help` lists a distinct `usage` subcommand ("Show
  subscription usage and quota for AI providers"), completely separate from
  the bare `tokscale --client <CLIENTS> --json` report this project's
  `ais usage` actually shells out to. `zai.rs` lives under
  `commands/usage/` because it belongs to THIS subcommand, not the one this
  project calls. Confirmed live: `ZAI_API_KEY=<key> bunx tokscale@latest
  usage --json` returns real Z.ai session/weekly/web-tools quota data TODAY,
  in the currently-published `4.5.3` — zai support was never unpublished at
  all. But `tokscale usage --help` shows it accepts NO `--client` flag at
  all (confirmed: passing one errors with "unexpected argument '--client'
  found"), and its output is quota PERCENTAGES per provider — the exact
  same shape of data `limits/zai-limits.ts` already surfaces via
  `ais limits --tool=zai`, never historical token counts/costs by model.
  Z.ai's API has no endpoint anywhere (checked directly) that exposes
  historical per-model token data, so the `--client zai --json` report
  `ais usage`'s default aggregate path always requests can NEVER succeed for
  zai, regardless of tokscale's version — this is a genuine, permanent
  data-availability gap, not a temporary one. Also confirmed `tokscale
  usage` is NOT identity-scopable in this project's model even if it were
  wired in: it auto-detects every provider it can find credentials for
  ambiently across the whole machine (confirmed live: it also picked up
  this machine's own unrelated Copilot and Kimi credentials alongside zai,
  with no way to filter to one identity) — plugging it into a per-identity
  report would leak other identities'/tools' data into what's supposed to
  be scoped.
  **SUPERSEDED minutes later, same day: "would leak" turned out to be
  solvable, not a reason to give up on wiring it in.** The user pushed back
  directly ("You need to pass ZAI_API_KEY through to tokscale... we have
  the ability to do this") rather than accepting "permanent gap, use
  `ais limits` instead" — and the fix was simpler than the paragraph above
  implied: `tokscale usage --json`'s response is unscoped, but nothing
  stops THIS project from filtering the response array down to just the
  entry whose `provider === "Z.ai"` before ever showing it to the user. Once
  that filter exists, the "ambient leakage" concern is fully resolved —
  it was a display-scoping problem, not a fundamental one. `run.ts`'s
  `fetchZaiQuotaViaTokscale` (originally named `runZaiQuota` — renamed once
  it became one of two concurrent fetches merged together, see below,
  rather than the sole handler for zai) does exactly this: calls `tokscale
  usage --json` directly
  (bypassing the `--client zai --json` path that was correctly identified
  as permanently broken above), filters to the Z.ai entry, and returns it
  as a new `UsageResult.quota` field (`TokscaleQuotaEntry`, distinct from
  `.report`'s token-count shape). `report.ts` renders it as a placeholder
  row in the main table (dashes, labeled "quota" not "error" — it isn't
  one) plus the real percentages in a new trailing "Quota:" section, rather
  than forcing them into token-count columns that don't apply.
  `tokscaleInvocationFor`'s `clientArgs` also changed: zai now gets `[]`
  unconditionally (not `["--client", "zai"]`) — "zai" was never a valid
  `--client` value for ANY tokscale subcommand, not just the per-model
  report, so the old code would have broken `ais usage --identity=<zai-id>
  --tool=zai -- usage` too (confirmed live: adding `--client zai` there
  fails with "unexpected argument '--client' found", the exact same
  scoped-passthrough case this project already supports for every other
  tool). The now-obsolete `translateZaiTokscaleError` (mentioned in the
  paragraph above as the fix) was deleted entirely — there's no longer a
  permanent failure to translate.
- **This is a LIVE QUOTA check, not a historical-token-log scan — tokscale's
  own "zai" support (its separate `usage` subcommand, see the correction
  above) works the same way, which is the direct answer to "can tokscale
  zai not use crush?"**: confirmed from tokscale's source that its zai
  client does NOT read Crush's local session data at all — it just needs a
  `ZAI_API_KEY`/`GLM_API_KEY` env var and calls the exact same live
  endpoint above.
  **This bullet originally said `ZAI_API_KEY` fed BOTH the default report
  and an unscoped passthrough — no longer true, see the SUPERSEDED note a
  few bullets down.** `ais usage`'s own default aggregate report doesn't go
  through tokscale for zai at all anymore (real numbers come from
  zai-usage.ts's direct SQLite read instead); `ZAI_API_KEY` now serves only
  the explicit passthrough case (`ais usage --identity=<zai-id> --tool=zai
  -- usage`).
  **"Still uninvestigated, still irrelevant" (Crush's own local session
  data) was WRONG, and got corrected within the hour by direct, insistent
  user pushback — twice in one sitting.** First: after seeing zai's row show
  nothing but dashes plus a bare "quota" label in the main table, the user
  said this looked broken; a first fix (putting the weekly percentage
  directly in the COST column) was rejected outright ("Nobody told you to
  move quote into the fucking usage table... FIX IT") — that fix was
  reverted, restoring plain dashes, because it was cosmetic and still didn't
  put real data anywhere. Second, immediately after: the user asked directly
  "And we don't have local logs for it like every other tool...?" — which is
  exactly the investigation that should have happened the first time zai's
  `ais usage` support was built, and didn't. Re-inspecting the SAME
  `.crush/crush.db` `resume/zai-resume.ts` already reads (this repo's own
  real database, created by this session's own earlier test invocations)
  found `sessions.message_count`/`prompt_tokens`/`completion_tokens`/`cost`
  — REAL, populated, non-zero columns (one real session: 45992 prompt
  tokens, 516 completion tokens; `sqlite3` confirmed a live SUM query
  returning 26 messages, 298004 prompt tokens, 1970 completion tokens,
  $0.145599 cost across this repo's own sessions) — that were simply never
  read for usage reporting, only `id`/`title`/`updated_at`/`created_at` for
  resume. "Z.ai's API has no token/cost history" (true, confirmed
  repeatedly) had been allowed to silently stand in for "zai has no local
  logs at all" (false) — those are not the same claim, and conflating them
  is the actual root cause of every wrong "permanent gap" statement made
  about `ais usage --tool=zai` earlier this session.
- **New: `usage/zai-usage.ts`'s `fetchZaiUsage`** — aggregates real local
  token/message/cost totals for one zai identity across EVERY project
  directory its own `projects.json` has ever recorded (unlike
  `resume/zai-resume.ts`, which scopes to the current cwd only — usage
  reporting for the other four tools means "this identity's entire history,"
  not "just here," so zai matches that). Uses the same `bun:sqlite`
  readonly-open pattern as zai-resume.ts, summing `message_count`/
  `prompt_tokens`/`completion_tokens`/`cost` with a single `SUM(...)` query
  per project db rather than iterating rows in JS. `totalCacheRead`/
  `totalCacheWrite` are genuinely `0` for zai, not a gap in this reader —
  checked the `messages` table's schema directly too, and there's no
  cache-read/write breakdown anywhere in Crush's local storage at all.
  Returns `undefined` (not an error) when there's nothing yet — no
  `projects.json`, or every registered project has no `crush.db` — matching
  every other reader's "identity has just never used this tool" convention.
  A `crush.db` that exists but fails to open/query is skipped, not fatal to
  the whole aggregate.
- **`run.ts`'s zai handling restructured to run BOTH concurrently, not
  either/or**: `runZaiUsage` calls `fetchZaiUsage` (real local totals, no API
  key needed — plain file I/O) and `fetchZaiQuotaViaTokscale` (live quota %,
  needs a key) in parallel via `Promise.all`, merging whichever succeed into
  one `UsageResult` — `report` when local data exists (now the COMMON case
  for a real, in-use identity), `quota` when a live check succeeds
  (independent of whether `report` also exists), and a hard error only when
  BOTH come up empty. This is why `runOne`'s zai branch had to move BEFORE
  the `tokscaleInvocationFor` early-return that gates every other tool: that
  check only tells you whether a live quota fetch is possible, and zai's
  local-log report doesn't depend on it at all — gating on it first would
  have skipped the (now primary) local-log path entirely for any identity
  missing a configured key.
- **`report.ts`'s row selection already handled this correctly with zero
  changes needed**: `r.report ? successRow(r) : r.quota ? quotaRow(r) :
  errorRow(r)` was written before this fix existed, but "prefer the real
  report, fall back to quota-only, then error" was already exactly the
  right precedence — a zai identity with real session history now renders
  with `successRow` (real numbers, participates in the TOTAL row) exactly
  like every other tool; `quotaRow` (plain dashes, no fabricated number —
  see report.ts's own comment for why a first attempt at showing a number
  there was reverted) is now the rarer fallback for a brand-new identity
  with a working key but no Crush sessions yet.
  **SUPERSEDED minutes later, same day: the whole quota-merge design in
  these last two bullets was removed entirely, not kept as a fallback.**
  The user's reaction was immediate and unambiguous: "Wait. Why is there
  still a fucking quoata section on the usage command???" — `ais usage`
  merging in a live quota % (even just as a fallback for brand-new
  identities, even clearly labeled) was never actually asked for, and no
  other tool's `ais usage` output has an equivalent extra section — it was
  scope creep this session added on its own initiative while fixing the
  real ask (real token/cost numbers). Fully reverted: `run.ts`'s
  `fetchZaiQuotaViaTokscale` and the concurrent `Promise.all` merge in
  `runZaiUsage` are gone — it's back to a single `fetchZaiUsage` call,
  reporting a plain "no local Crush session data yet for this identity"
  error when there's nothing. `report.ts`'s `quotaRow`/`formatQuotaLine`
  and the trailing "Quota:" section are deleted; row selection is back to
  the original two-way `r.report ? successRow(r) : errorRow(r)`.
  `tokscale.ts`'s `TokscaleQuotaEntry`/`TokscaleQuotaMetric` types are
  deleted too — nothing parses `tokscale usage`'s JSON output anymore.
  `tokscaleInvocationFor`'s zai handling (empty `clientArgs`, `ZAI_API_KEY`
  env var) is UNCHANGED and still correct — it's still needed for
  `usage/passthrough.ts`'s explicit `ais usage --identity=<zai-id> --tool=zai
  -- usage`, a deliberate, explicit invocation of tokscale's own subcommand
  that's a genuinely different thing from `ais usage`'s own default
  aggregate report auto-fetching and displaying it unasked. Live quota
  percentages have exactly one home now: `ais limits --tool=zai`.
- **New: `identities/zai-auth.ts`'s `readZaiApiKey(configDir)`** — the
  read-side counterpart to `writeZaiAuthFile`, pulling the literal key back
  out of `<configDir>/crush.json`'s `providers.zai.api_key`. Returns
  undefined (not the literal string) for anything that isn't a usable key:
  missing file, missing field, or a value shaped like an env-var reference
  (`"$ZAI_API_KEY"`, valid inside Crush's own config but not something an
  external HTTP caller can resolve) — callers treat that identically to "not
  authenticated yet," same as kimi-limits.ts's missing-credentials path.
- **New: `limits/zai-limits.ts`'s `fetchZaiLimits`**, wired into
  `limits/collect.ts`'s `FETCHERS`. Much simpler than kimi-limits.ts: a
  static API key, not OAuth, so there's no token-refresh flow at all — just
  one GET, mapped into this project's own `LimitWindow` shape (`session`/
  `week` categories for the two `TOKENS_LIMIT` entries; the `TIME_LIMIT` web-
  tools entry is deliberately labeled "web tools"/category "other" rather
  than "month" — it measures a different resource, call counts, and lumping
  it in with token-based monthly windows the way Codex/Grok report them
  would misrepresent it as directly comparable).
- **`usage/tokscale.ts`'s `tokscaleInvocationFor` is now `async`** (it wasn't
  before) — reading the key back out of `crush.json` is unavoidably async
  file I/O, so both call sites (`usage/run.ts`'s `runOne`,
  `usage/passthrough.ts`'s scoped branch) now `await` it. Returns `undefined`
  (same "not supported" contract every other gap already used) when the
  identity has no usable key yet, rather than handing tokscale an empty env
  var.
- **The unscoped "merge every identity into one tokscale process" path
  (`buildMergedExtraDirs`, renamed `buildMergedEnv`) can only ever carry ONE
  zai identity's key** — a hard structural limit, not an oversight: the
  other four tools merge via `TOKSCALE_EXTRA_DIRS`, an additive
  comma-separated list that happily holds N identities at once; zai works via
  a single `ZAI_API_KEY` env var, and only one value can occupy that slot in
  one shared process. With exactly one zai target in the merged set its key
  is included (best-effort, same "surface everything configured" spirit as
  the directory merge); with zero or more than one, zai is dropped from the
  merge silently (logged nowhere differently than any other unsupported-gap
  drop) — a `ais usage --identity=<name> --tool=zai` scoped call always
  works regardless, since that path never merges anything.
- **`ais resume --tool=zai` is still NOT implemented, deliberately, and
  isn't closed by any of the above** — the quota API answers "how much have
  I used," not "what sessions exist to resume." Crush's own session storage
  format remains uninvestigated; closing this gap would need that
  investigation specifically, not another live-API shortcut.
  **Superseded by the 2026-07-18 (later) addendum below** — that
  investigation happened, and it turned up something genuinely different
  from every other tool's storage model.

#### zai/Crush addendum (2026-07-18, later still): `ais resume`, and Crush's per-project (not per-identity) session storage

Directly requested as a follow-up once limits/usage were confirmed working:
"investigate resume." The investigation itself is what closed the gap — the
premise above (a live API can't answer "what sessions exist") is correct,
but the actual blocker (Crush's session storage being unknown) turned out to
be a quick, concrete answer once actually looked for, not an open-ended
unknown.

- **Confirmed live (2026-07-18) by direct SQLite inspection of a real
  `.crush/crush.db` this repo's own `crush` invocations had already
  created**: Crush does NOT store session/message data anywhere under the
  identity's own configDir at all (unlike claude/codex/grok/kimi, which all
  centralize everything there) — it creates a project-LOCAL `.crush/`
  directory inside whatever cwd it's run from, the same "one dotdir per
  project" model `.git` uses. That directory holds `crush.db` (a real
  SQLite file, WAL journal mode — confirmed safe for concurrent reads
  alongside an active writer) with a `sessions` table:
  `id, parent_session_id, title, message_count, cost, updated_at,
  created_at` (plus a few fields this project doesn't need). `title` is a
  real, auto-generated summary of the conversation (e.g. "Say hi in one
  word") — genuinely useful, not a placeholder — EXCEPT a small fraction of
  sessions get the literal placeholder `"Untitled Session"`, treated as "no
  label" the same way kimi's `"New Session"` placeholder is.
  `parent_session_id` is non-null for a sub-agent/child session — excluded
  from `ais resume`'s listing, since a user resuming wants a top-level
  conversation, not an internal sub-task (confirmed by direct testing:
  seeding a synthetic child row and verifying the reader excludes it).
- **A real, confirmed discrepancy in Crush's own schema**: the `sessions`
  table's SQL definition carries an inline comment claiming `updated_at`/
  `created_at` are "Unix timestamp in milliseconds" — they are NOT. Verified
  by converting a real row's value both ways: as milliseconds it lands in
  1970; as SECONDS it lands on today's actual date. Trusted the conversion
  that produced a sane date over the schema's own comment.
- **The missing link tying a project directory back to a specific
  identity**: Crush's own `projects.json` (at `<CRUSH_GLOBAL_DATA>/
  projects.json` — this project's own `CRUSH_GLOBAL_DATA`, i.e.
  `<configDir>/data` since the 2026-07-18 subdir fix above), a plain JSON
  file: `{ projects: [{ path, data_dir, last_accessed }] }`, one entry per
  project directory Crush has ever run in under that identity. This is
  exactly the piece needed: filter this identity's own `projects.json` for
  an entry whose `path` matches the current cwd (same
  `normalizePath`-then-exact-match convention every other reader already
  uses), then open THAT entry's `data_dir/crush.db` directly.
- **New: `resume/zai-resume.ts`'s `readZaiSessions`**, wired into
  `resume/collect.ts`'s `READERS`. Uses Bun's built-in `bun:sqlite` (`import
  { Database } from "bun:sqlite"`, opened `{ readonly: true }`) — zero new
  dependency, since Bun ships SQLite support natively and this project
  already compiles with `bun build --compile`. A `projects.json` entry whose
  `data_dir/crush.db` doesn't exist yet (the directory was only ever used
  for something that doesn't create a session, e.g. `crush dirs`) is
  skipped silently, not an error — same "identity has just never used this
  tool from this cwd" convention every other reader applies. Duplicate
  `projects.json` entries pointing at the same `data_dir` are deduped before
  querying, so a stale re-registration can't double-report sessions.
- **Two real, pre-existing bugs in `resume/launch.ts` found and fixed while
  wiring zai in — both invisible until zai, since every prior tool's
  `realBinaryName` happened to equal its `toolName`, and none had
  `extraEnvVarNames`:**
  1. `resolveRealBinary(session.toolName)` — for zai, `session.toolName` is
     literally `"zai"`, but there IS no binary named "zai" on PATH (the real
     binary is `crush`). Fixed to `resolveRealBinary(cfg.realBinaryName)`,
     a no-op change for claude/codex/grok/kimi (identical either way) but
     load-bearing for zai.
  2. The env injection only ever set `[cfg.envVarName]:
     session.identity.configDir` — never mirrored `cfg.extraEnvVarNames` the
     way `run-wrapper.ts` does. zai needs BOTH `CRUSH_GLOBAL_CONFIG` and
     `CRUSH_GLOBAL_DATA` (at `<configDir>/data`) set correctly, or a resumed
     session would read/write the wrong (or Crush's own unscoped default)
     data directory. Fixed by mirroring the exact same `subdir`-joining
     logic `run-wrapper.ts` already uses.
- **Verified live, end-to-end, twice — the listing AND the actual resume**:
  `ais resume --identity=identity-a --json` correctly listed all 9 real zai
  sessions in this repo's own `.crush/crush.db`, newest-first, with real
  titles as labels. Separately verified the RELAUNCH path's correctness
  (can't drive Crush's interactive TUI in this sandbox, so used `crush run
  --session <id> "what was my very first message?"` with the exact same
  env-var construction `launchResume` builds) — Crush correctly continued
  the exact session `ais resume` had listed, correctly recalling that
  session's actual first message, proving genuine session continuity rather
  than accidentally starting a fresh one.
- **`ais resume`'s `ResumableSession.toolName` union widened to include
  "zai"** (`resume/types.ts`) — `ToolResumeResult.toolName` already included
  it (a `Partial` record already anticipated this gap being filled later).
  No changes needed in `resume/pick.ts`/`resume/report.ts` — both are
  already fully generic over `ResumableSession`/`ToolResumeResult`, with no
  hardcoded per-tool branching to widen.
- **A real, reproduced flake found during this same verification pass, not
  a hypothetical**: opening `crush.db` readonly and immediately querying it
  failed once with "unable to open database file" in the narrow window
  right after this session's own live `crush run --session ...` write had
  just landed on that exact file — succeeded consistently on every retry
  seconds later, and succeeded immediately when opened via a completely
  separate, non-readonly connection at the same moment. WAL mode is
  supposed to let readers proceed alongside a writer without this, but
  empirically there's still a narrow window where it doesn't. Since a user
  running `ais resume` right after finishing a real zai session is exactly
  the moment this is most likely to recur, `zai-resume.ts`'s
  `queryTopLevelSessions` retries up to 3 times with a 100ms delay before
  surfacing a read as a genuine failure — not a blind "retry everything"
  policy, just this specific, observed transient-open failure class.

### ali case study (2026-08-07): Alibaba Cloud Model Studio's Token plan, the second crush-backed tool

`ali` is the sixth wrapped tool and the second fake proxy identity for the
real `crush` binary (github.com/charmbracelet/crush), following the exact
recipe zai's take-3 design (above) already worked out: a self-contained
custom provider entry in `crush.json`, non-interactive auth via a plain API
key, `disable_default_providers` to scope the model picker down to just this
provider's models.

- **What Alibaba's "Token plan" is**: Alibaba Cloud Model Studio (the
  DashScope/Bailian platform) offers an Anthropic-compatible endpoint under
  its Token plan, at
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`.
  Confirmed live (2026-08-07), same proof shape zai's take 3 used: writing a
  self-contained `crush.json` "alibaba" provider entry
  (`type: "anthropic"`, that `base_url`, `disable_default_providers: true`,
  a static `models` array) and running NO `crush login` at all was enough
  for `crush models` to list exactly those models, and for
  `crush run --model alibaba/<id> "..."` to send a REAL request to
  `<base_url>/v1/messages` (rejected only with a genuine Alibaba 401
  (carrying a real `request_id`) for a placeholder key, proving the config
  was actually read and used for the request, not just listed from a static
  catalog.
- **No `discover_models`: a deliberate, confirmed difference from zai's own
  entry, not an oversight.** zai's `writeZaiAuthFile` sets
  `discover_models: true` because Z.ai's endpoint has a real model-list API
  crush can merge live results from. Alibaba's Token plan endpoint has NO
  model-list endpoint at all (only `/v1/messages`), so live discovery would
  simply fail on every launch. `writeAliAuthFile` (`identities/ali-auth.ts`)
  omits the field entirely (not `false`, just absent) and documents why
  inline: the static `ALI_MODELS` list is the ONLY source of truth for this
  provider, never a fallback a live fetch could supersede.
- **The bespoke `ALI_CONFIG_DIR` envVarName is the one genuinely new design
  decision here, not copied from zai.** `ali` is the SECOND tool proxying
  `crush`, and `open.ts`/`resolve.ts` step (b) both identify the active tool
  by `envVarName` (`TOOL_CONFIGS.find((cfg) => process.env[cfg.envVarName])`
  in `open.ts`). If `ALI_CONFIG` reused `CRUSH_GLOBAL_CONFIG` (zai's own
  envVarName), an ali session and a zai session would be indistinguishable
  from each other, the exact collision class zai's OWN take-2 design hit
  when it shared `claude`'s envVarName with `CLAUDE_CONFIG` (see the "zai
  case study, take 2" section above). Fixed the same way take-3's fix for
  that problem worked: `ALI_CONFIG.envVarName` is the bespoke
  `ALI_CONFIG_DIR` (a var `crush` itself never reads), and the real crush
  vars (`CRUSH_GLOBAL_CONFIG`, `CRUSH_GLOBAL_DATA`) are mirrored via
  `extraEnvVarNames` instead (the exact mechanism `extraEnvVarNames` was
  built for in the first place (see `ToolConfig.extraEnvVarNames`'s own doc
  comment in `identities/types.ts`), just serving a second, different reason
  here (avoiding an envVarName collision) than it did for zai (splitting
  config from data). `open.ts`'s `TOOL_CONFIGS` array now lists `ALI_CONFIG`
  BEFORE `ZAI_CONFIG` specifically because of this: an ali session sets BOTH
  `ALI_CONFIG_DIR` and `CRUSH_GLOBAL_CONFIG` (the latter via its own
  extraEnvVarNames), while a zai session sets only `CRUSH_GLOBAL_CONFIG`;
  checking `ALI_CONFIG_DIR` first is what disambiguates the two, and the reverse
  order would misclassify every ali session as a zai one.
  - **Known, accepted residual** (same class as zai take-2's claude-sharing,
    not newly introduced here): a nested bare `zai` launch fired from
    inside an ali session sees `CRUSH_GLOBAL_CONFIG` already set (via ali's
    own extraEnvVarNames) and resolve.ts step (b) resolves it straight to
    the ali identity's configDir instead of prompting fresh. Not
    specifically guarded against, the same accepted risk shape as the
    zai/claude case, not a new hole this design introduces.
- **Limits support is a genuinely LIVE fetch, but via a browser-session
  cookie, not the inference API key — the Token plan has NO key-based quota
  endpoint, confirmed twice independently, not assumed (2026-08-07).** First
  by probing the inference host directly with the real key: only
  `/v1/messages` exists; every plausible usage/quota/models path on the
  token-plan host 404s "Not support", and DashScope's own endpoints reject
  the `sk-sp-...` key outright (it is a separate key namespace). Second, by
  reading CodexBar's (steipete/CodexBar) Token Plan implementation, which
  states it outright: "API-key auth ... not supported", cookie-only. The
  only working route is the Alibaba OneConsole browser gateway
  (`POST bailian-singapore-cs.alibabacloud.com/data/api.json?action=
  IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.
  /tokenplan/personal/api/v2/usage`), authenticated by the console session
  cookies. `limits/ali-limits.ts`'s `fetchAliLimits` implements exactly
  that request (headers, form body, and the `cornerstoneParam`
  client-context object — no secrets, `switchAgent` deliberately omitted,
  all mirroring CodexBar's fetcher one-for-one), and reads the cookie from
  `<configDir>/console-cookie.txt` (a plain-text file the user pastes
  their browser's Cookie header into — browser cookie-store import isn't
  portable across this project's machines, so manual paste is the only
  source; CodexBar supports the identical manual path alongside import).
  Confirmed live: the request round-trips and an expired/absent cookie
  surfaces as an honest "console session expired" unavailable, never a
  crash. Response shape: the outer envelope's `data.DataV2.data.data`
  carries `per5HourPercentage`/`per1WeekPercentage` as 0-1 FRACTIONS
  (unlike zai's 0-100 points — a barely-used account shows ~0.001) plus
  epoch-ms reset times. tokscale integration remains genuinely absent for
  ali: tokscale has no `"ali"`/`"alibaba"` client id AND there's no live
  quota API its own `usage` subcommand could hit as a fallback.
- **Usage and resume both reuse zai's exact local-log mechanism, generalized
  rather than copy-pasted.** Crush tracks real per-session token/message/
  cost data locally (`<project>/.crush/crush.db`) regardless of which
  provider it's pointed at (the same discovery that closed zai's own usage
  gap (see the 2026-07-18 zai/Crush addenda above) applies identically to
  ali. Rather than re-deriving that SQLite aggregation a second time,
  `usage/zai-usage.ts` and the new `usage/ali-usage.ts` are now both thin
  wrappers around a shared `usage/crush-usage.ts`'s `fetchCrushUsage(identity,
  dataSubdir)`; `resume/zai-resume.ts` and the new `resume/ali-resume.ts`
  are likewise thin wrappers around a shared `resume/crush-resume.ts`'s
  `readCrushSessions(toolName, identity, targetCwd, dataSubdir)`. Both zai
  and ali pass `dataSubdir: "data"` (matching their `CRUSH_GLOBAL_DATA`
  subdir; see tool-configs.ts). `resume/launch.ts`'s two zai-era fixes
  (resolving the REAL binary via `cfg.realBinaryName`, not `session.toolName`;
  mirroring `cfg.extraEnvVarNames` with `subdir` support) already generalize
  to ali with zero further changes, since both were written against
  `ToolConfig`, not a zai-specific literal.
- **Sync generalized from zai-only to "any crush-backed tool," not
  duplicated per tool.** The pre-existing sync code (`sync/rsync.ts`,
  `sync/sqlite-merge.ts`, `sync/service.ts`, `sync/watch.ts`) had several
  `scope.cfg.toolName === "zai"` / hardcoded `.zai/identities.json` checks
  that would have silently excluded ali's own project-local `.crush` data,
  `projects.json` exclusion, and SQLite VACUUM-snapshot merge protocol.
  Generalized via a new `CRUSH_BACKED_TOOL_CONFIGS` export in `sync/rsync.ts`
  (every `ToolConfig` with `realBinaryName === "crush"`, currently zai and
  ali) and an `isCrushBacked(cfg)` helper in `sync/service.ts`, rather than
  adding a second parallel `"ali"` check next to every existing `"zai"` one.
  `sqlite-merge.ts`'s `discoverCrushDatabasePaths` now scans EVERY
  crush-backed registry's `identities.json` (previously hardcoded to
  `.zai/identities.json` alone), reusing `rsync.ts`'s own `configHomeRoot()`
  to re-derive each tool's home-relative container directory (".zai",
  ".ali") rather than hardcoding either string a second time. The internal
  SSH protocol commands (`ais sync snapshot-zai`/`merge-zai-snapshot`) keep
  their historical zai-flavored names unchanged; they already operate on
  "every crush database this discovery function finds," so renaming them
  would only churn cross-host compatibility for no behavioral gain; their
  handlers already call the now-generalized `createCrushSnapshotTree`/
  `mergeCrushSnapshotTree` with no args, so ali's databases participate
  automatically.
- **`ais upgrade` keeps distinct `ZAI_CONFIG` and `ALI_CONFIG` specs, but
  deduplicates their identical physical installer.** Both point at
  `@charmland/crush` and the same real `crush` binary. A real upgrade showed
  why two supposedly idempotent npm calls are unsafe: the first installed
  Crush successfully, then the second reran Crush's network-bound
  postinstall and failed on a transient GitHub DNS lookup, turning a
  successful upgrade into an overall failure. `runUpgradeWithDeps` therefore
  caches results by npm package, real binary, script allowlist, and fallback
  arguments. Both installed shims are still detected independently, but one
  physical installer is attempted and counted once; if only one alias is
  installed, that alias still triggers the install normally.
- **Model list is static/fallback metadata, not independently verified
  per-model figures.** Costs are 0 (plan-included, same convention as
  zai's own `glm-5.2` entry) and context windows/max-tokens are reasonable
  defaults, not confirmed against Alibaba's own published specs for each
  model. This doesn't matter functionally: Alibaba's real endpoint enforces
  its own actual limits server-side regardless of what crush's local
  config claims, the same as zai's own static fallback list.
- **No desktop app, no interactive login, same as zai.** `ali`'s
  `--desktop` is wired up structurally (appName `"Crush"`, same as zai) but
  expected to just fail resolving `/Applications/Crush.app`, and there is no
  browser-OAuth flow of any kind involved in ali's auth (a plain API key in
  a JSON file), so `open.ts`'s Chrome-MCP-redirect mechanism has nothing to
  do for ali either (same as zai's own final state, see "zai case study,
  take 3" above), never re-verified because there's nothing here to verify.

### Provider-first views for limits and usage (2026-09-03)

Prompted directly: the per-tool sections in `ais limits` ("pi (4
identities)… no limits fetcher implemented") and the zero/error placeholder
rows in `ais usage` were exactly the tool-shaped output the user had already
rejected — both views must be per PROVIDER + identity, with the wrapper/tool
kept only as collection provenance (fine to keep in internal records and
logs for future reporting, never as a reporting dimension).

What the rule means in practice, now enforced in both pipelines:

- **`ToolLimitResult.provider` is the report's grouping key.** The six 1:1
  tools stamp it from `providerForTool` in one place (`singleToolFetcher` in
  limits/collect.ts); their fetchers return the narrower
  `FetchedLimitResult` (no provider field), which makes it a compile error
  to construct a provider-less result anywhere else. The multi-provider
  clients' adapters (`pi-limits.ts`, `opencode-limits.ts`) stamp each
  result's provider themselves — only they know which upstream each answer
  came from. `formatLimitsReport` renders one section per provider
  (Anthropic, OpenAI, xAI, Kimi, Z.ai, Alibaba, OpenCode Go, ...), never a
  tool name.
- **The same provider+identity reached through two wrappers merges into one
  row** (`aggregateLimitResults`, the counterpart of usage/run.ts's
  `aggregateUsageResults`). This is the common case, not the edge case: pi's
  auth.json was IMPORTED from the native tools (identities/pi-auth.ts), so
  its Z.ai key IS the zai tool's key. Windows come from the best-ranked
  result (live > cached > unavailable; the flat target order puts native
  tools first so ties resolve deterministically); a live answer discards the
  duplicate source's error text, two failures merge their reasons, and a
  resolved result always supersedes a pending placeholder.
- **Native-covered providers are skipped, not duplicated.** Pi's
  anthropic/openai-codex/xai/alibaba-plan entries and OpenCode's
  alibaba_token_plan entry contribute nothing: the native claude/codex/
  grok/ali fetchers already answer for the same account through their own
  authenticated paths (Claude/Codex/Grok limit reads go through the native
  CLI itself; the Alibaba Token plan has no API-key quota endpoint at all),
  and a pi/opencode row would either duplicate the branch or add an
  unactionable "can't fetch" line. Fetchable from pi today: `zai` (static
  key, same quota endpoint as zai-limits), `kimi-coding` (OAuth via
  `fetchKimiUsageForCredentials`), and `opencode-go` (same Go-plan quota
  endpoint as opencode-limits). Fetchable from opencode today:
  `zai_coding_plan` and `opencode-go`.
  **OpenCode Go's quota endpoint** (`GET
  https://opencode.ai/zen/go/v1/usage`, Bearer the Go API key) was found
  2026-09-03 by probing the Go gateway directly — an earlier probe sweep
  against `/zen/v1/*` (the WRONG base path; Go keys live under
  `/zen/go/v1`) all 404'd, which produced a bogus "no public limits API"
  claim that user feedback killed the same day: the user hit their weekly
  limit with no way to see it. The endpoint returns the plan's three
  DOLLAR-denominated windows ($12/5h rolling, $30 weekly, $60 monthly) as
  `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}` — percent is
  share-of-window-budget, `status: "rate-limited"` marks an exhausted
  window. Its real token usage also appears in `ais usage` (see
  usage/opencode-usage.ts).
  **OpenCode identity usage also reads its db directly** (added 2026-09-03
  after the user saw ONE dynacom plan rendered as FOUR rows): tokscale's
  opencode client collapses multi-plan models into comma-joined
  pseudo-providers ("opencode_go, zai_coding_plan") and underscore
  spellings, fragmenting the report. Identity dbs are read with the same
  exact per-message providerID attribution as the default profile, and
  canonicalUsageProvider splits comma-joined provider strings so any
  residual joined form still collapses to one stable key. The db scan
  yields every ~500 rows — bun:sqlite is synchronous, and an unyielding
  scan of a multi-GB db froze the live render's spinners.
  **Default-profile usage is attributed by CREDENTIAL MATCH, not scope**
  (fixed 2026-09-03 after the user corrected it hard: their unscoped
  `~/.local/share/opencode` profile held dynacom's OpenCode Go key, and
  logging that usage under a synthetic "default" identity was wrong —
  "ALL USAGE WE HAVE IS FOR DYNACOM"). The profile's auth.json keys are
  matched against every opencode/pi identity's keys; usage logs under the
  identity holding the same credential. The synthetic "default" identity
  is the fallback ONLY for providers no identity can claim.
- **ONE credential per (identity, provider) — kimi-store.ts.** Kimi rotates
  its OAuth refresh token on EVERY refresh, and the same account's
  credentials exist in two stores: the kimi identity's
  `credentials/kimi-code.json` (the kimi CLI's own file) and the same-named
  pi identity's imported `auth.json` "kimi-coding" entry. Left independent,
  whichever store refreshed first invalidated the other — every few days
  an access-token expiry stranded a store with HTTP 400 until manual
  re-auth (observed live 2026-09-03, both kimi identities). The stores are
  now views of ONE logical token: reads take the FRESHEST copy
  (freshest-wins self-heals), and every refresh is written through to ALL
  of the account's stores in each store's own shape (pi's expires is
  milliseconds, kimi's seconds). pi's entry is thus a live projection, not
  a fork. The same law will need the same treatment for the other OAuth
  providers pi holds copies of (anthropic, openai-codex, xai) — kimi is
  where rotation made the race an everyday failure, so it went first.
- **No tool-shaped placeholder rows exist for the multi-provider clients.**
  Neither a pending seed (the provider isn't known until the adapter reads
  the identity's own auth store — a placeholder would render a fake
  "Detecting providers"/"OpenCode" section) nor a cached-mode row (same
  problem, persistent). Both render nothing until their real per-provider
  results land; an explicit `--tool=` still gets one honest row. 1:1 tools
  keep their pending spinners unchanged.
- **No per-target timeout in the shared usage engine.** The console work
  added a 25s `runOneBounded` cap; on this machine ~25 targets run
  concurrently and contend for disk, so real scans routinely take 25-55s
  and the cap turned ENTIRE reports into error rows (labeled "timed out
  after 25ms" — the unit math was wrong too). Reverted 2026-09-03: the CLI
  must never truncate good data; genuine hangs stay bounded where they
  actually occur (tokscale's own spawn timeout; limits has never had a
  cap). Multi-provider source failures (a pi/opencode reader crashing
  before attributing any provider) are flagged `sourceOnlyError`: they
  render NO provider table row — never a fabricated "Unattributed" row —
  and surface only in the trailing Errors section under their SOURCE label
  (`pi/dynacom: ...`), the same "per-tool in diagnostics" allowance as the
  internal logs.
- **A source with nothing to report renders no row — unless the user asked
  for that source specifically.** Both pipelines thread an `explicitTool`
  flag (`--tool=<t>`): unscoped, an empty tokscale report or a pi identity
  with no sessions contributes nothing (no "0 messages" pseudo-provider
  rows, no Unattributed error rows); with an explicit `--tool=`, the same
  condition becomes one honest "unavailable" row instead of silence. Real
  failures (tokscale crashed, unreadable session data) keep their error rows
  in unscoped reports — a blank table over a broken environment would hide
  the problem.

"Prove it" evidence for the fetchable paths: live `ais limits` after this
change shows pi's dynacom Z.ai key answering for the same account whose
native zai row had been timing out, and `ais usage` no longer lists
Unattributed/OpenCode placeholder rows for the three pi identities with no
local sessions and the two opencode identities with no data.

## Commands

### OpenCode identity proxy (2026-08-27)

- `opencode` is a real eighth AIS-managed CLI, separate from the retired
  zai-via-OpenCode experiment above. `OPENCODE_CONFIG` points
  `OPENCODE_CONFIG_DIR` at the identity root and redirects `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, and `XDG_STATE_HOME` into `data`, `cache`, and `state`
  subdirectories. OpenCode adds its own `opencode/` suffix to the XDG roots.
- `run`, `acp`, and `serve` are non-interactive entrypoints. The wrapper must
  never prompt for an identity in those modes. `serve` remains loopback-only
  unless the caller explicitly supplies another hostname.
- Provider credentials remain OpenCode-owned. In particular, never reuse
  Claude Pro/Max OAuth: Anthropic supports third-party clients with an API
  key. OpenAI/xAI use OpenCode's OAuth flows; Kimi For Coding, Z.AI Coding
  Plan, and Alibaba Token Plan use their dedicated product credentials.
- OpenCode identities mirror the same account boundaries used by the other
  AIS wrappers. Never aggregate credentials from unrelated AIS identities
  into one catch-all OpenCode profile.
- OpenCode currently participates in identity management, backup, update,
  upgrade, and SSH profile sync. Usage, limits, doctor, and resume degrade to
  their existing honest unsupported result until native collectors are added.

- `bun install` — install dependencies.
- `bun test` — run the unit test suite (`test/match.test.ts`, `test/resolve.test.ts`,
  `test/chrome-profile.test.ts`, `test/codex-backfill.test.ts`,
  `test/store.test.ts`, `test/cli-args.test.ts`, and `test/cli/*`).
- `bun run build`: `bun build --compile` all eight proxy entrypoints (`claude`,
  `codex`, `grok`, `kimi`, `zai`, `ali`, `pi`, `opencode`) plus `open`
  (darwin only), `ais`, and the installer into `dist/`.
- `bun run backup` — mirrors `~/.claude`, `~/.claude-identity-a`,
  `~/.claude-personal`, `~/.codex`, `~/.grok`, `~/.kimi-code`, `~/.zai`,
  `~/.ali`, `~/.pi`, and `~/.opencode` into the persistent git-managed repo at `~/.ais/backups` and
  commits whatever changed since the last backup (see "~/.ais: one
  consolidated root" above).
- `bun run migrate` — **one-time, destructive.** Restructures the real
  `~/.claude`/`~/.codex` directories into the `identities/<name>/` layout.
  Refuses to run if a `claude`/`codex` process is currently running (checked
  via `pgrep`) — run it from a plain terminal, not from inside an active
  Claude Code/Codex session. Takes a fresh backup first, unconditionally.
  Does NOT cover `~/.grok`, `~/.kimi-code`, `~/.zai`, or `~/.ali`: those
  directories started fresh/unauthenticated when grok/kimi/zai/ali support
  was added, with nothing worth preserving under a default identity, so
  this script was intentionally left claude/codex-only rather than
  generalized speculatively.
- `bun run install:shims` — backs up, then copies `dist/claude`/`dist/codex`/
  `dist/grok`/`dist/kimi`/`dist/zai`/`dist/ali`/`dist/pi`/`dist/opencode`/
  `dist/open` to `~/.local/bin`.
  Open a new terminal (or `hash -r`) afterward, and for grok and kimi
  specifically, verify with `which grok` / `which kimi` that they actually
  resolve to `~/.local/bin/grok` / `~/.local/bin/kimi` (see the PATH-ordering
  caveat under "Key design decisions"). `zai`/`ali` have no equivalent
  PATH-ordering risk: there's no real `zai`/`ali` binary anywhere on `PATH`
  to lose a race against.

## Desktop apps

`--desktop` on the `claude` wrapper launches Claude.app's real binary directly
(bypassing `open`, which does not forward env vars to the launched app) with
the resolved `CLAUDE_CONFIG_DIR` set. **Codex has a native, better path**:
`codex app [PATH]`, run *through* the codex wrapper (so `CODEX_HOME` is already
correctly set on the real `codex` process before it launches the desktop app)
— try this before reaching for a `--desktop`-style hack on codex. **Grok has
neither** — no `grok app` subcommand and no `/Applications/Grok.app` bundle
found on this machine — `--desktop` is wired up structurally for grok anyway
(consistency with the generic `runWrapper`/`launchDesktopApp` code path), but
is expected to just fail resolving the app bundle binary. **Kimi is the
same** — no `kimi app` subcommand and no `/Applications/Kimi*.app` bundle
found on this machine (checked 2026-07-17) — `--desktop` is wired up
structurally for kimi anyway (same consistency argument), and is likewise
expected to just fail resolving the app bundle binary. **zai is now the same
category as grok/kimi too** — its current real binary, `crush`, is a
terminal-only CLI with no known desktop app bundle — `--desktop` for zai is
wired up structurally (appName `"Crush"`) but expected to just fail
resolving `/Applications/Crush.app`. (This flips zai's own earlier note:
when zai's real binary was `opencode`, a real `OpenCode.app` cask DID exist —
see "zai case study, take 1" — but that's moot now that zai proxies crush
instead.) **ali is in the identical category to zai.** Same real binary
(`crush`), same terminal-only CLI with no known desktop app bundle,
`--desktop` for ali wired up structurally (appName `"Crush"`, same as zai)
but expected to just fail resolving `/Applications/Crush.app` too (see the
"ali case study" above.

**Spike outcome (fill in after running verification step 12):**
- `codex --identity=<name> app .` — TODO: does the launched Codex.app actually
  reflect the identity, or does it manage its own account independent of
  `CODEX_HOME`?
- `claude --identity=<name> --desktop` — TODO: does Claude.app's embedded
  Claude Code/Cowork feature respect `CLAUDE_CONFIG_DIR`, or is its identity
  determined purely by its own logged-in OAuth session (its
  `claude-code-sessions/` storage is keyed by Anthropic account UUID, which
  points this way, but wasn't confirmed empirically before shipping v0.1)?
- `grok --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-13: no
  `Grok.app` exists on this machine to even attempt launching. Not re-checked
  on a machine that does have one installed; if the user installs a Grok
  desktop app later, re-verify rather than assuming this stays negative.
- `kimi --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-17: no
  `Kimi.app` (no `/Applications/Kimi*.app` at all) exists on this machine to
  even attempt launching. Same caveat as grok: if the user installs a Kimi
  desktop app later, re-verify rather than assuming this stays negative.
- `zai --identity=<name> --desktop` — verified NEGATIVE as of 2026-07-17
  (take 3): no `Crush.app` exists on this machine (crush is a terminal-only
  CLI with no known desktop bundle) to even attempt launching. Same caveat
  as grok/kimi: re-verify rather than assume this stays negative if that
  ever changes. (Superseded finding: when zai's real binary was `opencode`
  — take 1 — a real `OpenCode.app` Homebrew cask DID exist but was untested;
  moot now.)
- `ali --identity=<name> --desktop`: verified NEGATIVE as of 2026-08-07,
  same basis as zai: no `Crush.app` exists on this machine, and ali's real
  binary is the identical `crush` CLI. Same caveat: re-verify rather than
  assume this stays negative if that ever changes.

If either comes back negative: drop that mechanism and document here that
desktop identity switching for that app can only be done via its own in-app
login/logout UI.

## Chrome profile per identity (auto-opened links)

Auto-opened links (OAuth `/login`, etc.) redirect into the active identity's
own isolated **Chrome (Claude MCP)** instance — the exact same dedicated,
per-identity automation browser the `chrome-devtools` MCP server already uses.
Identity names, ports, and Chrome profile directories are machine-local data
loaded from `~/.ais/config/chrome-mcp.json` (or
`AIS_CHROME_MCP_CONFIG`), never source-controlled configuration.
A top-level `chromeProfileOverrides` array can redirect a specific directory
to a **different** identity's Chrome (Claude MCP) instance instead — same
pattern grammar as `directories` (see `src/identities/match.ts`), most-
specific wins, and it takes precedence over the active identity when both
would otherwise apply:

```text
{
  "version": 1,
  "identities": [ ... ],
  "chromeProfileOverrides": [
    { "directories": ["<absolute-directory>/*"], "targetIdentity": "<name>", "label": "optional note" }
  ]
}
```

**Mechanism** (`src/open.ts`, installed as `~/.local/bin/open`, darwin only;
`src/identities/chrome-mcp.ts` for machine-local config + self-heal + CDP call):
requires running inside a session our own claude/codex/grok/kimi/zai wrapper
launched (`IDENTITY_SESSION_MARKER`, same guard as before) with
`resolveChromeMcpTarget()` resolving an identity. Once resolved:

1. `ensureChromeMcpRunning(identityName)` checks whether that identity's port
   is listening (`GET /json/version`); if not, and `devserver ls` shows the
   `chrome-mcp-<identity>` session is genuinely missing (mirrors
   `chrome-mcp-ensure-running.sh`'s hook logic exactly, including the same
   guard against double-launching a duplicate window), runs the same Recovery
   launch command and polls up to 15s.
2. `openUrlInChromeMcp(port, url)` opens the URL as a new tab via the
   already-running instance's **full CDP WebSocket protocol** —
   `Target.createTarget` with `{ url, background: true, newWindow: false }`
   — never an app launch, and never the simpler HTTP `/json/new` endpoint.

   **First cut used HTTP `/json/new` and shipped a real, user-visible bug
   (2026-07-14, caught immediately in the same session): it stole OS-level
   window focus every time a link opened**, because `/json/new` has no
   parameter for background tab creation at all — it always activates the
   new tab and brings the whole Chrome window to the front. This is exactly
   the failure mode the `chrome-mcp-profile` skill's `background: true`
   convention (`mcp__chrome-devtools__new_page`'s own param) exists to
   prevent — "this browser is shared, visible, and not yours alone." The fix
   required moving off the HTTP endpoint entirely: `background`/`newWindow`
   are only accepted by `Target.createTarget` over the WebSocket protocol
   (`webSocketDebuggerUrl` from `GET /json/version`), the same mechanism
   puppeteer/chrome-devtools-mcp itself relies on for the already-proven
   "don't steal focus" guarantee elsewhere in this project. Verified the
   WebSocket call succeeds with these params against a fully disposable,
   throwaway **headless** Chrome instance on an unused port with a `/tmp`
   `--user-data-dir` — deliberately never re-touching any real identity's
   visible Chrome (Claude MCP) window to "verify the fix," since the whole
   point was to stop doing that.

   Two more things confirmed empirically against a live instance
   (2026-07-14), neither documented anywhere in Chrome's own docs, both still
   true of the current WebSocket-based implementation: `GET /json/new`
   (the old HTTP endpoint) returns 405 on this Chrome build (150.x) — the
   DevTools HTTP endpoints require `PUT`, CSRF hardening added at some point
   — moot now that HTTP `/json/new` isn't used at all, but worth remembering
   if anything ever needs it again; and an unencoded target URL passed
   through a URL-shaped CDP/HTTP parameter gets silently truncated at its
   first embedded `&` (whatever's parsing the query string treats it as a
   break into a new, unrecognized param and drops everything after) — e.g. an
   OAuth callback's `&state=...` vanishes silently unless the URL is passed
   as a proper JSON string value (as `Target.createTarget`'s WebSocket
   `params.url` does — no manual encoding needed there, since it's a JSON
   payload field, not a query string).

When a redirect actually happens (success or failure at any stage — target
resolution, self-heal timeout, CDP call failure), `open.ts` prints one
`console.error` diagnostic line; a failure at any stage falls through to
unmodified `open` rather than hanging or erroring outright, matching the
"never let this shim break plain `open`" principle from before — but always
loudly, never silently, per the 2026-07-14 identity-a incident where a silent
browser-tool fallback (unrelated to this file, but the same failure shape)
went unnoticed for 4+ days.

**Spike outcome: still UNVERIFIED**, same two stacked assumptions as before —
the redirect *target* changed, but neither of these was re-tested, since both
are about whether `open.ts` gets invoked at all, independent of what it does
once invoked:

1. That the real `claude`/`codex`/`grok`/`kimi`/`crush` binaries (and
   whatever they spawn for OAuth login) invoke the bare command name `open`
   via a PATH lookup, the same way
   `Bun.spawn(["open", ...])`/Node's `child_process.spawn("open", ...)` do —
   rather than a hardcoded absolute path like `/usr/bin/open`, which would
   make this shim invisible to them. Circumstantial evidence is strong (the
   real `claude` binary is itself Bun-compiled, and shelling out via bare
   command name is the standard portable pattern — hardcoding an absolute
   path is unusual and non-idiomatic) but this was NOT confirmed empirically:
   attempts to drive a real onboarding/login flow through `expect` inside
   this sandbox to observe whether a logging decoy at `~/.local/bin/open` got
   hit were blocked by the sandbox's lack of pty allocation for nested
   interactive sessions.
2. That the actual invocation shape is the bare `open <url>` this shim
   intercepts (`urlToOpenInBrowser` in `src/open.ts`, zero other flags). If
   the real call includes any extra flag (e.g. `-g` to avoid stealing focus),
   this shim's narrow guard rejects it and falls through to passthrough —
   deliberately conservative (a wrong guess broadening it risks hijacking
   unrelated `open` calls) but untested against the real invocation shape.

kimi, zai, and ali are wired identically (`src/open.ts`'s `TOOL_CONFIGS` now
includes all three, so redirects resolve for wrapped kimi/zai/ali sessions
too) but were never re-verified under either of the two assumptions above:
treat all three as exactly as unverified as for the other tools. Moot for
zai's and ali's CURRENT designs either way: crush's Z.ai/Alibaba auth (see
"zai case study, take 3" and "ali case study") is a one-time file write
(`identities/zai-auth.ts`/`identities/ali-auth.ts`), with no browser OAuth
flow involved at all, so no auto-opened link is expected to fire for either
session in the first place; this redirect mechanism simply has nothing to
do for zai or ali. (Historical note: zai's take-1 real binary, opencode, DID
have an interactive `opencode auth login` OAuth-style flow, never attempted
through this project's `open` shim at the time — moot now that zai's auth
model has changed entirely, and ali never had an equivalent design to begin
with.)

If assumption 1 is wrong: drop the mechanism entirely, document that here,
and fall back to `/login`'s manual "press `c` to copy the URL" flow. If only
assumption 2 is wrong: broaden `urlToOpenInBrowser` once the real flag shape
is known — don't guess at further flag combinations blind.

**To verify for real** (safe, ~30 seconds, after `bun run install:shims`): run
`claude --identity=<name>` somewhere that triggers a fresh login (or any
other auto-opened link) and watch whether a new tab appears in that
identity's Chrome (Claude MCP) window instead of your regular daily-driver
Chrome. If a real Chrome window opens instead (or nothing redirects at all),
the bare-command-name assumption is wrong — drop this mechanism and record
that finding here instead of iterating on it further.

@/home/thomas/.config/devdeploy/CLAUDE.snippet.md
