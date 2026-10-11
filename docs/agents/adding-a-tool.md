# Adding another wrapped tool later

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 1344-1461). Read before touching this area._

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
7. Update AGENTS.md (core), docs/agents/module-map.md and README.md to
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

