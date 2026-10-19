# Module map and overview

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 36-48 50-450). Read before touching this area._

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
                             zai.ts/ali.ts/open.ts/cli/*. PI_CONFIG additionally carries
                             singleInstanceDir (~/.pi/agent): pi launches ONE shared instance
                             exposing every identity in-app (see "pi single instance" below).
                             ZAI_CONFIG/ALI_CONFIG both carry
                             realBinaryName ("crush", since neither "zai" nor "ali" is a real
                             binary) and extraEnvVarNames (crush splits config from
                             session/model-cache data (see "zai case study" below); ali's
                             own envVarName is bespoke too, to disambiguate from zai; see
                             "ali case study")
    retired.ts              isRetired/activeIdentities/retire+unretire field helpers and
                             lastRetirementEventMs() (sync ordering); RetiredIdentityError
                             lives in errors.ts
    credential-paths.ts     credentialPathsForTool(): the on-disk credential files per tool
                             (server/auth.ts re-exports it)
    retire-credentials.ts    purgeRetiredIdentityCredentials(): deletes a retired identity's
                             credentials (files, crush.json api key, ali cookie/auth-browser/
                             timer, same-named pi auth.json entry); never touches logs/DBs
    zai-auth.ts             writeZaiAuthFile(): read-modify-write into a zai identity's own
                             <configDir>/crush.json with its "zai" provider entry — the
                             non-interactive auth this design's whole existence depends on
    ali-auth.ts              writeAliAuthFile(): the same read-modify-write trick for ali's
                             "alibaba" provider entry, see "ali case study" below
    aws-profile.ts           identity -> AWS CLI profile resolution for AWS Bedrock
                             reporting (registry env > ~/.ais/config/aws-profiles.json;
                             region/account-id enriched from ~/.aws/config) +
                             isBedrockIdentity(); profile NAMES only, never credentials
    pi-auth.ts               one-shot, secret-silent import of the six provider-specific
                             AIS identities plus OpenCode Go into one Pi auth.json; also translates ali's
                             Crush model catalogue into Pi's models.json; plus the ADD-ONLY sync
                             primitives (readPiCredentialSources/planPiCredentialSync/syncPiCredentials)
    pi-extension-install.ts  self-heal installer that keeps the current AIS Pi
                             extension (embedded at build time via Bun's
                             `type: "text"` import attribute) in
                             $PI_CODING_AGENT_DIR/extensions/ais-identity.ts,
                             version-stamped so stale copies refresh; never throws
    resolve.ts             resolveIdentity(): the flag > env > dir-match > prompt/error chain;
                             single-instance tools (ToolConfig.singleInstanceDir - pi) take
                             resolveSingleInstanceIdentity() instead: NEVER prompts, never
                             errors on no-match, always launches the one shared dir (flag >
                             env override still honored; a match only seeds the in-app default)
    prompt.ts               @clack/prompts picker + create-new-identity flow
                             The picker lists claude pools under one "Claude Pools" entry
                             (second select of member accounts; a member choice makes it
                             active via the manual switch, then launches the pool) and
                             pre-selects the last pick per tool, remembered by
                             last-identity.ts in ~/.ais/state/last-identity.json (mode 0600,
                             every read/write best-effort)
    errors.ts                typed IdentityResolutionError subclasses
  shared/              process/OS mechanics — no identity-resolution logic
    resolve-binary.ts    find the REAL claude/codex/grok/kimi/open/crush/pi binary,
                        self-recursion guard. Takes a `realBinaryName`, not a `toolName` —
                        zai's real binary is "crush", not "zai"
    herdr-bin.ts           resolveHerdrBinary(): AIS_HERDR_BIN override, then PATH,
                        then ~/.local/bin/herdr. Shared by the herdr bridge, the
                        `ais herdr` wrapper and `ais upgrade`'s herdr row; herdr is
                        never bundled, vendored, or installed by ais
    release-assets.ts    the one release-download layer: platformKeyFrom/platformKey
                        ("<os>-<cpu>" mapping), downloadAsset/downloadAssetAtomic
                        (public <tag>/latest redirect, GH_TOKEN/GITHUB_TOKEN API
                        path, temp+rename+chmod atomic install, destination
                        symlink never followed). Consumed by installer.ts,
                        `ais update` and the aistui self-heal
    aistui-bin.ts          resolveTuiBinary() (AIS_TUI_BIN > ~/.local/bin/aistui >
                        dev cargo checkout) + ensureAistuiBinary(): the ONE
                        self-heal download of aistui-<platform> from the release
                        matching the running ais (v<pkg.version>, latest-release
                        fallback), atomic into ~/.local/bin/aistui, no retry loop;
                        shared by `ais tui` and `ais herdr`'s panel
    exec.ts               Bun.spawn passthrough, signal relay, exit-code parity;
                          execveReal/execReal try execve first;
                          also defines IDENTITY_SESSION_MARKER (see below)
    execve.ts             libc execve via bun:ffi (Linux) or posix_spawn SETEXEC
                          (macOS): argv/envp block, signal and fd hygiene; every
                          failure returns a reason string
    darwin-proc.ts        macOS sysctl/proc_pidpath reads for the sidecar's PID watch
    session-sidecar.ts    detached `__session-sidecar` (sync watcher, Herdr titles,
                          PID-exit watch, post-exit sync) and launchWithSession()
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
    state.ts               server.json read/write/clear + token generation. Default
                            location ~/.ais/web; AIS_WEB_STATE_DIR relocates the whole
                            console state dir (server.json, auth-refresh state, file
                            backups) for contexts that share the host's ~/.ais but must
                            own separate lifecycle state: the k8s pod sets it to
                            /web/state (hostPath mount + hostPID otherwise put the pod's
                            daemon pid in the same server.json the host daemon manages,
                            and each side's stop/start churn killed the other's daemon)
    expensive.ts           PollCache (TTL + in-flight dedupe) shared by the limits/usage
                            endpoints so BOTH frontends' live polling never hammers
                            upstream provider APIs; also maps query params onto the
                            ParsedArgs["flags"] shape the collectors already read
    processes.ts           /proc scan for running agent CLIs, attributed to identities via
                            IDENTITY_SESSION_MARKER in each process's environ
    registries.ts          registry listing + all mutations via cli/identities/actions.ts's
                            pure functions + store.ts atomic save; optional apiKey at create
                            time forwarded to writeZaiAuthFile/writeAliAuthFile
    auth.ts                per-identity auth health probes (file presence + shape +
                            expiry reads, never secret values) and fix actions: zai/ali
                            key writes, ali console-cookie paste, kimi token refresh
                            (reuses fetchKimiLimits's refresh-on-expiry path), login
                            starts (managed flows with terminal handoff fallback) and
                            the legacy spawn-into-terminal path; also owns
                            credentialPathsForTool(), the single source of truth for
                            "what counts as credentials" shared by the probes and the
                            flow manager
    login-specs.ts         LOGIN_FLOW_SPECS: the per-tool managed login command, mode
                            (pty vs pipes) and paste capability; the terminal fallback
                            derives its args from the same table so the two never drift
    auth-refresh.ts        the daemon credential-renewal scheduler: REFRESHERS registry
                            (ali cookie harvest + OAuth refreshers for codex/claude/grok/kimi,
                            see identities/oauth-refresh.ts), cadence (expiry-window +
                            daily keep-alive; claude: 1h window, no keep-alive), loud failures with escalation, skip/revoked
                            state persisted under the console state dir, and
                            lastRefreshFailure()/lastRefreshState() for the CLI consumers
    login-flows.ts         LoginFlowManager: daemon-managed per-identity logins — spawns
                            the REAL CLI's own flow (resolveRealBinary, never the shim)
                            with piped stdio or a script-allocated PTY, surfaces the
                            auth URL/device code from its output (ANSI-stripped), tracks
                            status (waiting -> callback -> completed/failed/cancelled)
                            via process exit + credential-file fingerprints, injects
                            pasted codes on stdin for claude's paste path
    files.ts               whitelisted-root file browsing/editing (~/.ais, tool containers,
                            registered configDirs): dual lexical+realpath containment guards,
                            REPRODUCIBLE_JUNK_DIR_NAMES-filtered listings, 2 MB text cap,
                            binary sniffing, atomic writes with pre-edit backups under
                            <consoleWebDir>/file-backups/ (follows AIS_WEB_STATE_DIR)
  cli/                 the `ais` management CLI — no identity-resolution logic of its own
    dispatch.ts          top-level subcommand routing + uniform error->exit-code handling
    args.ts                minimal argv parser: positionals + --flag=value/--flag
    errors.ts               CliUsageError — bad flags/args, distinct from identities/errors.ts
    launch.ts                 `ais launch`: tool list (installed + active identity), offline warning,
                             then promptForIdentity and exec through ~/.local/bin/<tool> shim
                             with --identity/--pool; or start a local model (no identity)
    local/dispatch.ts          `ais local list|start`: local llama.cpp model (shared/local-models.ts)
    version.ts               `ais version` (reads package.json)
    help.ts                   `ais help` / bare `ais` / `--help`/`-h`
    update.ts                 `ais update`: re-downloads whichever of claude/codex/grok/kimi/
                             zai/ali/pi/open/ais/aistui are already in ~/.local/bin, via
                             shared/release-assets.ts's downloadAssetAtomic
    upgrade.ts                 `ais upgrade`: ensures every installed AIS shim has its real
                             CLI installed/upgraded IN PARALLEL (one task per spec;
                              failures never abort siblings) — Claude/Codex/Kimi/Crush/Pi
                              in AIS's user-owned npm prefix, Grok through xAI's official
                              release installer; capability-checked native updaters are
                              only fallbacks. Installer children run through exec.ts's
                              captured spawnCaptured, so their output never interleaves
                              into the status list and is only surfaced on failure (and
                              in non-TTY failure reports); on a TTY the command renders
                              a live one-row-per-tool status list, on a pipe it prints
                              plain start/finish lines. Distinct from `ais update`, which
                              refreshes this project's own shims
    upgrade-status.ts             pure status model behind `ais upgrade`'s status list:
                              rows + transition events + reducer + row formatting, no
                              process/terminal access, unit-testable without a TTY
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
      breakdown.ts              collectIdentityBreakdown()/runBreakdownQuery(): per-tool-call
                               token & cost breakdown from local logs (claude projects JSONL,
                               codex rollout JSONL; streaming line reader, mtime/path-date
                               pruning); MCP servers roll up to mcp:<server> with per-tool
                               detail, edit/write tools group as kind "edit"; one documented
                               attribution rule (prompt-side tokens on the "conversation"
                               row, output split evenly across a turn's tool calls) and
                               explicit unavailable results for tools without per-call
                               local data; see the case study below before touching
      pi-usage.ts providers.ts    recursive Pi JSONL usage reader + canonical upstream-provider
                               aliases; copied/forked messages are deduplicated before aggregation,
                               party members are provider-attributed, and native CLI bridges are marked
      aws-bedrock-usage.ts         Bedrock usage in two layers: LOCAL month-to-date
                                tokens + token-based EST. COST from the shared
                                session-log readers (shared/local-spend.ts) in the
                                normal columns, REAL AWS spend (Cost Explorer
                                UnblendedCost, SERVICE = "Amazon Bedrock") + budget
                                context in a separate realCost field rendered as a
                                sub-row (see the AWS Bedrock case study)
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
      aws-bedrock-limits.ts       AWS Budgets as the limits source for Bedrock-backed
                                identities (one COST budget = one month-category
                                window; see the AWS Bedrock case study)
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
      sessions/                session TREES (what spawned which agent) + normalized
                               TRANSCRIPTS behind GET /api/sessions/tree and
                               GET /api/sessions/transcript (docs/API.md carries the DTO
                               contract; scan kinds "tree"/"transcript" in server/scan-worker.ts
                               run them in the isolated scan child, 15s/4s caches). ALL reads
                               stream line-by-line via shared.ts's forEachLine/findFirstLine
                               (fileTextChunks + a real Bun.sleep(0) yield per chunk — the #63
                               lesson), never a whole-file sync read. Per-tool readers
                               claude/codex/pi/grok/kimi/crush.ts: claude subagents are
                               `<enc>/<sessionId>/subagents/**/agent-<id>.jsonl` (child id
                               "<sessionId>/<agentId>"); codex subagent/guardian threads are
                               rollout files with session_meta.parent_thread_id (user-role
                               response_items starting `<environment_context` are synthetic
                               and skipped); kimi subagents are `agents/<dir>/wire.jsonl`
                               (child id "<sessionId>/<agentDir>"; turns come from turn.prompt /
                               content.part / tool.call / tool.result wire events); crush reads
                               sessions.parent_session_id + messages.parts (JSON part array,
                               UNIX-seconds timestamps) provider-scoped like crush-resume.ts;
                               pi and grok record NO parent links (flat roots). Orphan rule
                               (tree.ts computeDepths): a child whose parent is outside the
                               `days` window keeps parentId but renders at depth 0. Identity
                               session colours live in identities/colour.ts (explicit #rgb/
                               #rrggbb on Identity.colour, validated in store.ts; every
                               consumer renders effectiveColour = explicit or a stable
                               hash(tool:name) palette pick, one shared palette so CLI,
                               server and web agree).
     web.ts                   `ais web start|stop|status|open [--port=] [--foreground]`:
                            lifecycle for server/*'s console daemon. Default spawns a
                            DETACHED child re-invoking this same entrypoint with the hidden
                            --serve-internal flag (works compiled AND dev: [Bun.main] alone
                            when self, [process.execPath, Bun.main] under the bun runtime);
                            fails fast if the child exits before its own pid appears in
                            server.json and answers a health probe, so a stale daemon
                            holding the port can never masquerade as a successful start
                            (a genuinely occupied port reports "port N already in use"
                            instead of a 10s timeout). NEVER-KILL GUARD: stop/restart
                            verify the state file's pid via /proc/<pid>/cmdline (basename
                            containing "ais" anywhere in argv + the --serve-internal
                            marker) before signalling; a stale, hand-edited or foreign
                            pid is refused loudly and left in place ("refusing to kill
                            pid N - it is not a console daemon (cmdline: ...)") so
                            lifecycle churn can never take down an unrelated process.
                            /proc-less platforms (macOS) fall back to the legacy blind
                            SIGTERM. NOTE parseArgs only reads --flag=value; "--port 1234"
                            would silently become port=true + positional "1234"
    tui.ts                   `ais tui`: ensures the console server is up (reads
                            ~/.ais/web/server.json), then execs the ratatui binary from
                            $AIS_TUI_BIN > ~/.local/bin/aistui > apps/tui/target/release/
                            aistui, passing AIS_CONSOLE_URL/AIS_CONSOLE_TOKEN via env;
                            when nothing resolves, ONE self-heal download of
                            aistui-<platform> from the matching release first
                            (shared/aistui-bin.ts), original not-found error as fallback
    herdr.ts                 `ais herdr`: runs the NATIVE wrapper, `aistui herdr`
                            (apps/tui/src/herdr.rs): the real herdr client embedded
                            in a PTY on the LEFT, the overview rendered natively on
                            the RIGHT at --panel-width (default 42), a status bar
                            below; no tmux anywhere. --remote=<target> points herdr
                            at a remote herdr server, --remote-ais mirrors the remote
                            machine's console through an ssh -L tunnel owned by THIS
                            process (started before aistui, killed in a finally;
                            honest local fallback with a note), --raw execs plain
                            herdr, --force overrides the nesting guard (HERDR_* env
                            only: tmux nesting is fine now the wrapper is a plain
                            TUI); non-interactive stdin is refused before any side
                            effects (there is no detachable session any more); the
                            tmux-era flags --new/--panel-cmd/--tmux-socket are
                            removed with honest errors; console credentials reach
                            the panel via env, never argv; shares tui.ts's one-shot
                            aistui self-heal before its not-found error
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
    local-spend.ts          the shared Bedrock session-log readers (codex
                            rollout + claude projects JSONL, month-to-date
                            period filter, Bedrock-rate valuation): the spend
                            guard's offline estimate AND the usage report's
                            Bedrock columns read through this one
                            implementation, so the two reconcile by
                            construction (see the spend guard case study)
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

