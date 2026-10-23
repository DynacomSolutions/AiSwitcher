import type { Identity, ToolConfig } from "../../identities/types.ts";
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isRetired } from "../../identities/retired.ts";
import { readZaiApiKey } from "../../identities/zai-auth.ts";
import { aisCacheDir, aisHome } from "../../shared/ais-home.ts";
import { defaultOpencodeProfileDbPath } from "./opencode-usage.ts";

/**
 * How to point tokscale (github.com/junhoyeo/tokscale) at exactly one
 * identity's session data for one tool, and what its `--json` output looks
 * like. Confirmed empirically against real identity data on this machine
 * (2026-07-13) rather than assumed from its README:
 *
 *   - codex/grok/kimi: tokscale itself reads CODEX_HOME/GROK_HOME/
 *     KIMI_CODE_HOME to locate session data — the exact same env vars this
 *     project already redirects per identity (see identities/tool-configs.ts).
 *     No extra step needed.
 *   - claude: tokscale (>= 4.18) reads CLAUDE_CONFIG_DIR and scans
 *     `<it>/projects`, replacing its `$HOME/.claude` default. Verified
 *     2026-10-10: that alone scopes to one identity. TOKSCALE_EXTRA_DIRS is
 *     ADDITIVE, so using it alone also scanned the default root and leaked it
 *     into every identity.
 *   - zai: NOT a directory scan at all, unlike the other four, and this
 *     project's own `usage/run.ts` doesn't even use this for its default
 *     aggregate report — zai's real MESSAGES/INPUT/OUTPUT/COST numbers come
 *     from `usage/zai-usage.ts` instead, reading Crush's own project-local
 *     `crush.db` directly (no tokscale involved at all for that report).
 *     `ZAI_API_KEY` is still set here purely for `usage/passthrough.ts`:
 *     `ais usage --identity=<zai-id> --tool=zai -- usage` invokes
 *     tokscale's own separate `usage` subcommand directly (its "subscription
 *     usage and quota" report — a live quota PERCENTAGE check, the same
 *     data `ais limits --tool=zai` already shows, and completely unrelated
 *     to `--client <CLIENTS>`, the per-model token-log report the other
 *     four tools use). "zai" is never a valid `--client` value anywhere in
 *     tokscale (confirmed: it's absent from the full valid-values list),
 *     which is why `clientArgs` below is empty for zai specifically —
 *     passing one would break that passthrough invocation too. Returns
 *     `undefined` (same as "not supported") when the identity has no usable
 *     literal key yet (readZaiApiKey) rather than crashing tokscale with an
 *     empty env var.
 *   - opencode: a real tokscale client id ("opencode", confirmed in
 *     `tokscale clients` output) whose scan root resolves through
 *     XDG_DATA_HOME — `<data>/opencode/...`, covering both the legacy
 *     storage/message tree and the newer opencode.db — with no env var of
 *     its own. Setting `XDG_DATA_HOME: <configDir>/data` (the same root
 *     this project's opencode wrapper already scopes per identity, see
 *     OPENCODE_CONFIG's extraEnvVarNames) scopes tokscale to exactly that
 *     identity's sessions; confirmed live 2026-09-03 against both storage
 *     formats with no cross-identity leakage.
 *   - ali: has NO tokscale support at all, unlike zai: tokscale has no
 *     "alibaba"/"ali" client id, AND Alibaba's Token plan API has no
 *     documented quota/usage endpoint for tokscale's own separate `usage`
 *     subcommand to hit either (confirmed: no equivalent of zai's
 *     `api.z.ai/api/monitor/usage/quota/limit` was found anywhere in
 *     Alibaba's Model Studio docs). So this always returns `undefined` for
 *     ali; real MESSAGES/INPUT/OUTPUT/COST still come from
 *     `usage/ali-usage.ts`'s local Crush-log reader (same mechanism as
 *     zai-usage.ts), just with no tokscale passthrough fallback available.
 */
export async function tokscaleInvocationFor(
  toolName: ToolConfig["toolName"],
  identity: Identity,
): Promise<{ env: Record<string, string>; clientArgs: string[] } | undefined> {
  // `--client <tool>` only, not `--json` — this is shared by both the
  // aggregate report (run.ts, which appends its own --json) and passthrough
  // mode (passthrough.ts, which forwards the caller's own tokscale args
  // as-is — forcing --json there would corrupt a `tui`/`graph` invocation).
  //
  // zai gets NO `--client` at all, unlike the other four: "zai" isn't a
  // recognized client id anywhere in tokscale (confirmed: it's absent from
  // the full valid-values list tokscale's default report prints), so
  // passing it fails identically whether targeting the default report OR
  // tokscale's own `usage` subcommand (confirmed live: `tokscale usage
  // --client zai` errors with "unexpected argument '--client' found" even
  // though `tokscale usage` alone, with just `ZAI_API_KEY` set, works).
  // This function's only zai caller is usage/passthrough.ts now — run.ts's
  // default aggregate report gets zai's real numbers from zai-usage.ts
  // instead, with no tokscale invocation at all.
  const clientArgs = toolName === "zai" ? [] : ["--client", toolName];
  switch (toolName) {
    case "codex":
      return { env: { CODEX_HOME: identity.configDir }, clientArgs };
    case "grok":
      return { env: { GROK_HOME: identity.configDir }, clientArgs };
    case "kimi":
      return { env: { KIMI_CODE_HOME: identity.configDir }, clientArgs };
    case "claude":
      // CLAUDE_CONFIG_DIR REPLACES tokscale's default claude root (tokscale
      // >= 4.18 reads it, appending `projects`). TOKSCALE_EXTRA_DIRS is
      // additive, so using it alone also scanned $HOME/.claude/projects (or the
      // caller's own CLAUDE_CONFIG_DIR) and leaked it into every identity.
      return { env: { CLAUDE_CONFIG_DIR: identity.configDir }, clientArgs };
    case "zai": {
      // A retired identity's credentials are deleted and tokscale's live
      // quota call must never run for it: same "not supported" answer as the
      // no-key path.
      if (isRetired(identity)) return undefined;
      const apiKey = await readZaiApiKey(identity.configDir);
      if (!apiKey) return undefined;
      return { env: { ZAI_API_KEY: apiKey }, clientArgs };
    }
    case "ali":
      // No tokscale client, no live quota API to fall back on either (see
      // this function's own doc comment above).
      return undefined;
    case "opencode": {
      // tokscale's opencode client resolves its scan root through
      // XDG_DATA_HOME (`<data>/opencode/...`, covering both the legacy
      // storage/message tree and the newer opencode.db) with no env var of
      // its own — the same root opencode itself splits its config/data/
      // cache/state across (see OPENCODE_CONFIG's extraEnvVarNames), so
      // pointing XDG_DATA_HOME at the identity's data subdir scopes
      // tokscale to exactly that identity's sessions, old format or new.
      return { env: { XDG_DATA_HOME: join(identity.configDir, "data") }, clientArgs };
    }
    case "pi":
      return undefined;
  }
}

export interface AisTokscaleExportTarget {
  toolName: ToolConfig["toolName"];
  identity?: Identity;
  partitionId: string;
  exportPath: string;
  signal?: AbortSignal;
}

export interface AisTokscaleExportInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
}

/** Build one isolated invocation of AIS-patched Tokscale's native message
 * exporter. It never falls back to PATH or bunx, because those binaries may
 * not implement the export contract. */
export async function buildAisTokscaleExportInvocation(
  target: AisTokscaleExportTarget,
  env: Record<string, string | undefined> = process.env,
): Promise<AisTokscaleExportInvocation | undefined> {
  if (!/^[a-f0-9]{64}$/.test(target.partitionId) || !isAbsolute(target.exportPath)) {
    throw new Error("invalid-native-export-target");
  }
  const command = env.AIS_TOKSCALE_SHARED_BIN || join(aisCacheDir(), "usage", "native-tokscale", "tokscale");
  if (!isAbsolute(command)) throw new Error("invalid-native-export-binary-path");
  try {
    const info = await stat(command);
    await access(command, fsConstants.X_OK);
    if (!info.isFile()) throw new Error("invalid-native-export-binary");
  } catch {
    throw new Error("native-export-binary-unavailable");
  }

  let sourceEnv: Record<string, string>;
  let clientArgs: string[];
  if (target.toolName === "opencode" && !target.identity) {
    sourceEnv = { XDG_DATA_HOME: join(homedir(), ".local", "share") };
    clientArgs = ["--client", "opencode"];
  } else if (target.toolName === "pi" && target.identity) {
    sourceEnv = { PI_CODING_AGENT_DIR: target.identity.configDir };
    clientArgs = ["--client", "pi"];
  } else {
    if (!target.identity) throw new Error("native-export-identity-required");
    const invocation = await tokscaleInvocationFor(target.toolName, target.identity);
    if (!invocation || target.toolName === "ali" || target.toolName === "zai") return undefined;
    sourceEnv = invocation.env;
    clientArgs = invocation.clientArgs;
  }

  return {
    command,
    args: clientArgs,
    env: {
      ...sourceEnv,
      TOKSCALE_EXTRA_DIRS: "",
      TOKSCALE_CONFIG_DIR: join(aisCacheDir(), "usage", "native-tokscale", "isolated-config"),
      TOKSCALE_AIS_EXPORT_PATH: target.exportPath,
      TOKSCALE_AIS_PARTITION_ID: target.partitionId,
    },
    cwd: process.cwd(),
    ...(target.signal ? { signal: target.signal } : {}),
  };
}

/** The snapshot worker owns this bounded process call and validates the
 * separately written export envelope before it can become visible. */
export async function runAisTokscaleExportInvocation(invocation: AisTokscaleExportInvocation): Promise<string> {
  if (invocation.signal?.aborted) throw new Error("native-export-aborted");
  return spawnTokscaleProcess(invocation.command, [], [...invocation.args, "--json"], invocation.env);
}

/** Resolve the installed AIS-patched binary and authoritative manifest for
 * shared TUI mode. This path deliberately has no PATH/bunx fallback. */
export async function resolveAisTokscaleSharedTui(
  env: Record<string, string | undefined> = process.env,
): Promise<{ command: string; args: string[] }> {
  const command = env.AIS_TOKSCALE_SHARED_BIN || join(aisCacheDir(), "usage", "native-tokscale", "tokscale");
  if (!isAbsolute(command)) throw new Error("AIS_TOKSCALE_SHARED_BIN must be an absolute path");

  try {
    const info = await stat(command);
    await access(command, fsConstants.X_OK);
    if (!info.isFile()) throw new Error("shared Tokscale binary is not a file");
  } catch {
    throw new Error(`AIS shared Tokscale binary is missing or not executable: ${command}`);
  }

  return {
    command,
    args: ["--ais-shared-snapshot", join(aisCacheDir(), "usage", "snapshot.json")],
  };
}

/** The relative path tokscale itself appends to each client's scan root
 * (confirmed from its own env-var resolution — CODEX_HOME's fallback is
 * `<home>/.codex/sessions`, GROK_HOME's is `<home>/.grok/sessions`,
 * KIMI_CODE_HOME's is `<home>/.kimi-code/sessions` (tokscale's kimi client
 * reads KIMI_CODE_HOME; client id `kimi` confirmed in tokscale's README
 * `--client` list and its session-scanner source, 2026-07-17), and claude
 * has no env override but resolves to `<home>/.claude/projects`).
 * TOKSCALE_EXTRA_DIRS entries need this same final path, not just the
 * identity's bare configDir — confirmed empirically for all three. */
const EXTRA_DIR_RELATIVE: Record<"claude" | "codex" | "grok" | "kimi", string> = {
  claude: "projects",
  codex: "sessions",
  grok: "sessions",
  kimi: "sessions",
};

/** One `client:/abs/path` entry for TOKSCALE_EXTRA_DIRS — see
 * buildMergedEnv for why passthrough.ts needs to combine several of
 * these into one comma-separated value rather than using tokscaleInvocationFor
 * (which only ever scopes to a single identity via one env var swap). */
export function tokscaleExtraDirEntry(toolName: "claude" | "codex" | "grok" | "kimi", identity: Identity): string {
  return `${toolName}:${identity.configDir}/${EXTRA_DIR_RELATIVE[toolName]}`;
}

function tokscaleSupportsClient(toolName: string): toolName is "claude" | "codex" | "grok" | "kimi" {
  return toolName in EXTRA_DIR_RELATIVE;
}

/**
 * TOKSCALE_EXTRA_DIRS supports multiple comma-separated entries, including
 * several for the same client id — confirmed empirically: merging every
 * configured identity's extra-dir entry into one TOKSCALE_EXTRA_DIRS value
 * and running a single bare tokscale invocation surfaced every identity's
 * data simultaneously (claude/codex/grok all present, correct per-client
 * totals). This is what makes "every identity/provider, unscoped" a single
 * tokscale process rather than N of them — unlike the scoped, single-identity
 * case, nothing here needs per-identity subprocess isolation.
 *
 * zai can't join this merge the same way: it works via a single
 * `ZAI_API_KEY` env var, not an additive directory list, so at most ONE
 * zai identity's key can ever be active in one merged tokscale process —
 * unlike TOKSCALE_EXTRA_DIRS, there's no way to merge several. With exactly
 * one zai target in the set, its key is included (best-effort — the same
 * "show everything configured" spirit as the directory-based merge); with
 * zero or more than one, zai is silently dropped from the merge (same
 * "report what's supported, don't crash over a gap" stance as
 * tokscaleInvocationFor) — an ambiguous zai target still works fine on its
 * own via a SCOPED `ais usage --identity=<name>` invocation instead.
 * `ZAI_API_KEY` is worth carrying into this merge for the same reason
 * tokscaleInvocationFor sets it at all: an unscoped `ais usage -- usage`
 * passthrough invokes tokscale's OWN `usage` subcommand, which DOES read
 * this var and DOES return real Z.ai quota data (the default aggregate
 * report doesn't go through tokscale for zai at all — see zai-usage.ts).
 *
 * OpenCode SQLite files and legacy message roots are configured through
 * scanner.opencodeDbPaths and scanner.extraScanPaths.opencode. TOKSCALE_CONFIG_DIR
 * points Tokscale at an AIS-managed settings overlay that retains existing
 * Tokscale settings and links its other files/directories back to the user's
 * normal config directory. This permits one process to scan every configured
 * OpenCode identity without rewriting user settings or copying credentials.
 */
export interface MergedEnvOptions {
  /** Test seam; production uses TOKSCALE_CONFIG_DIR or Tokscale's default. */
  sourceConfigDir?: string;
  /** Test seam; production stores its durable overlay below ~/.ais/usage. */
  overlayConfigDir?: string;
  /** Include the user's default OpenCode profile in unscoped usage parity. */
  includeDefaultOpencodeProfile?: boolean;
}

function defaultTokscaleConfigDir(): string {
  if (process.env.TOKSCALE_CONFIG_DIR) return resolve(process.env.TOKSCALE_CONFIG_DIR);
  return resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tokscale");
}

async function prepareTokscaleConfigOverlay(
  sourceConfigDir: string,
  overlayConfigDir: string,
  dbPaths: string[],
  legacyMessageRoots: string[],
): Promise<void> {
  await mkdir(overlayConfigDir, { recursive: true });

  // Tokscale 4.20 config state directories documented in its README. Link
  // only these known cache/state paths, plus documented credential files
  // when they already exist. This keeps existing state in place without
  // copying secrets or blindly importing future files into the overlay.
  const stateDirectories = [
    "cache",
    "cursor-cache",
    "amp-cache",
    "antigravity-cache",
    "trae-cache",
    "warp-cache",
    "headless",
    "autosubmit",
  ];
  const stateFiles = ["star-cache.json", "credentials.json", "cursor-credentials.json", "recovered-usage-v1.json"];
  await mkdir(sourceConfigDir, { recursive: true });
  for (const name of stateDirectories) {
    const source = join(sourceConfigDir, name);
    await mkdir(source, { recursive: true });
    await ensureTokscaleStateLink(source, join(overlayConfigDir, name), true);
  }
  for (const name of stateFiles) {
    const source = join(sourceConfigDir, name);
    try {
      await lstat(source);
      await ensureTokscaleStateLink(source, join(overlayConfigDir, name), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const readSettings = async (path: string): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {};
    }
  };
  const sourceSettings = await readSettings(join(sourceConfigDir, "settings.json"));
  const overlaySettings = await readSettings(join(overlayConfigDir, "settings.json"));
  // Once created, the persistent overlay is Tokscale's active settings file.
  // This preserves changes the TUI makes there between AIS invocations.
  const settings = { ...sourceSettings, ...overlaySettings };

  const sourceScanner = sourceSettings.scanner && typeof sourceSettings.scanner === "object" && !Array.isArray(sourceSettings.scanner)
    ? sourceSettings.scanner as Record<string, unknown>
    : {};
  const overlayScanner = overlaySettings.scanner && typeof overlaySettings.scanner === "object" && !Array.isArray(overlaySettings.scanner)
    ? overlaySettings.scanner as Record<string, unknown>
    : {};
  const scanner = { ...sourceScanner, ...overlayScanner };
  const configuredPaths = Array.isArray(sourceScanner.opencodeDbPaths)
    ? sourceScanner.opencodeDbPaths.filter((path): path is string => typeof path === "string")
    : [];
  const mergedPaths = [...new Set(await Promise.all([...configuredPaths, ...dbPaths].map(canonicalPathOrResolved)))];
  const configuredLegacyRoots = scanner.extraScanPaths && typeof scanner.extraScanPaths === "object" && !Array.isArray(scanner.extraScanPaths)
    ? scanner.extraScanPaths as Record<string, unknown>
    : {};
  const opencodeRoots = Array.isArray(configuredLegacyRoots.opencode)
    ? configuredLegacyRoots.opencode.filter((path): path is string => typeof path === "string")
    : [];
  const mergedLegacyRoots = [...new Set(await Promise.all([...opencodeRoots, ...legacyMessageRoots].map(canonicalPathOrResolved)))];
  settings.scanner = {
    ...scanner,
    opencodeDbPaths: mergedPaths,
    extraScanPaths: { ...configuredLegacyRoots, opencode: mergedLegacyRoots },
  };

  const currentPaths = Array.isArray(overlayScanner.opencodeDbPaths)
    ? overlayScanner.opencodeDbPaths.filter((path): path is string => typeof path === "string").map((path) => resolve(path))
    : [];
  const currentLegacyRoots = Array.isArray((overlayScanner.extraScanPaths as Record<string, unknown> | undefined)?.opencode)
    ? ((overlayScanner.extraScanPaths as Record<string, unknown>).opencode as unknown[]).filter((path): path is string => typeof path === "string").map((path) => resolve(path))
    : [];
  if (JSON.stringify(currentPaths) !== JSON.stringify(mergedPaths) || JSON.stringify(currentLegacyRoots) !== JSON.stringify(mergedLegacyRoots)) {
    const settingsPath = join(overlayConfigDir, "settings.json");
    const tempPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, settingsPath);
  }
}

async function canonicalPathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(path);
  }
}

async function ensureTokscaleStateLink(sourcePath: string, destinationPath: string, sourceIsDirectory: boolean): Promise<void> {
  try {
    const existing = await lstat(destinationPath);
    if (!existing.isSymbolicLink()) return;
    const existingTarget = await readlink(destinationPath);
    if (resolve(dirname(destinationPath), existingTarget) === resolve(sourcePath)) return;
    await unlink(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await symlink(sourcePath, destinationPath, sourceIsDirectory ? "dir" : "file");
  } catch (error) {
    // Another invocation can establish the same link concurrently.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function buildMergedEnv(
  targets: Array<{ toolName: string; identity: Identity }>,
  options: MergedEnvOptions = {},
): Promise<Record<string, string>> {
  const entries: string[] = [];
  for (const t of targets) {
    if (tokscaleSupportsClient(t.toolName)) entries.push(tokscaleExtraDirEntry(t.toolName, t.identity));
  }
  // TOKSCALE_EXTRA_DIRS is additive: point every default root at an empty
  // path so only the listed identities are scanned, never $HOME's own dirs.
  const empty = join(aisHome(), "usage", "no-default-scan");
  const env: Record<string, string> = {
    TOKSCALE_EXTRA_DIRS: entries.join(","),
    CLAUDE_CONFIG_DIR: empty,
    CODEX_HOME: empty,
    GROK_HOME: empty,
    KIMI_CODE_HOME: empty,
  };

  const zaiTargets = targets.filter((t) => t.toolName === "zai");
  if (zaiTargets.length === 1) {
    const apiKey = await readZaiApiKey(zaiTargets[0]!.identity.configDir);
    if (apiKey) env.ZAI_API_KEY = apiKey;
  }

  const opencodeTargets = targets.filter((t) => t.toolName === "opencode");
  if (opencodeTargets.length > 0 || options.includeDefaultOpencodeProfile) {
    const sourceConfigDir = options.sourceConfigDir ?? defaultTokscaleConfigDir();
    const dbPaths = opencodeTargets.map((t) => resolve(join(t.identity.configDir, "data", "opencode", "opencode.db")));
    const legacyMessageRoots = opencodeTargets.map((t) => resolve(join(t.identity.configDir, "data", "opencode", "storage", "message")));
    if (options.includeDefaultOpencodeProfile) {
      const defaultDbPath = defaultOpencodeProfileDbPath();
      dbPaths.push(resolve(defaultDbPath));
      legacyMessageRoots.push(resolve(join(dirname(defaultDbPath), "storage", "message")));
    }
    const overlayRoot = options.overlayConfigDir ?? join(aisHome(), "usage", "tokscale-config");
    const targetSetHash = createHash("sha256")
      .update([resolve(sourceConfigDir), ...dbPaths.sort(), ...legacyMessageRoots.sort()].join("\0"))
      .digest("hex")
      .slice(0, 16);
    const overlayConfigDir = options.overlayConfigDir ?? join(overlayRoot, targetSetHash);
    await prepareTokscaleConfigOverlay(sourceConfigDir, overlayConfigDir, dbPaths, legacyMessageRoots);
    env.TOKSCALE_CONFIG_DIR = overlayConfigDir;
    // Configured DB paths are additive to Tokscale auto-discovery. Keep its
    // ambient XDG root empty so the caller's personal OpenCode data is not
    // pulled into an all-identities report.
    env.XDG_DATA_HOME = empty;
  }
  return env;
}

/** Prepares an unscoped Tokscale invocation without executing it. The same
 * output is consumed by passthrough's execve path and can be tested with
 * noninteractive arguments such as --json. */
export async function prepareMergedPassthrough(
  targets: Array<{ toolName: string; identity: Identity }>,
  args: string[],
  options: MergedEnvOptions = {},
): Promise<{ args: string[]; env: Record<string, string> }> {
  return {
    args,
    env: targets.length === 0 && !options.includeDefaultOpencodeProfile ? {} : await buildMergedEnv(targets, options),
  };
}

/** One row of tokscale's `--json` `entries` array — usage broken down by model. */
export interface TokscaleEntry {
  client: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messageCount: number;
  cost: number;
}

/** tokscale's `--json` output shape, confirmed by direct invocation against
 * real claude and codex identity data — only the fields this module actually
 * reads are typed; the rest of tokscale's output passes through untouched. */
export interface TokscaleReport {
  entries: TokscaleEntry[];
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalMessages: number;
  totalCost: number;
}

/** Prefer an already-installed `tokscale` on PATH; otherwise fetch-and-run it
 * via `bunx` on demand. Deliberately not a project dependency — tokscale
 * ships heavy platform-specific native optional-deps that don't belong
 * bundled into this project's own install (see AGENTS.md). */
export function resolveTokscaleCommand(): string[] {
  const onPath = Bun.which("tokscale");
  if (onPath) return [onPath];
  return ["bunx", "tokscale@latest"];
}

/** Resolves tokscale to a spawnable command, but smarter than
 * `resolveTokscaleCommand`: if tokscale isn't on PATH yet `bunx tokscale@latest`
 * has ALREADY materialized it in Bun's install cache (the common case after a
 * prior run), spawn the cached native binary DIRECTLY instead of going through
 * `bunx` again. That bypasses bunx's per-call `.bin` link step entirely —
 * the exact step that races under concurrency (EEXIST, see the bunxQueue doc
 * below). Cached-native execution avoids that bunx link race; a separate
 * process-wide limiter still serializes tokscale work to bound memory.
 * Returns undefined when nothing is resolvable yet (cold cache + caller must
 * fall back to `bunx`, which is the only path that downloads). Memoized per process: resolution doesn't change
 * within one CLI run (runUsageQueryForTargets refreshes the cache BEFORE any
 * call here can happen), and memoizing also avoids re-probing executability
 * on every one of the ~2N spawns in a full report. */
let cachedBinaryMemo: string[] | undefined | null = null;
export function resolveTokscaleCachedBinary(): string[] | undefined {
  if (cachedBinaryMemo === null) cachedBinaryMemo = findCachedTokscaleBinary({});
  return cachedBinaryMemo;
}

/**
 * tokscale's npm optional-dep package names by platform, confirmed against
 * the real `tokscale` package's `optionalDependencies` (npm view tokscale):
 * Linux ships a libc-suffixed pair per arch (`-gnu`/`-musl`, glibc vs musl,
 * e.g. Alpine) — the ONLY platform where that distinction exists. darwin
 * and win32 packages carry no libc suffix at all (macOS has no musl/glibc
 * split; win32 uses `-msvc` instead). The previous version of this function
 * always appended `-gnu`/`-musl` regardless of platform, so on macOS
 * neither candidate directory ever existed and findCachedTokscaleBinary
 * fell through to `undefined` unconditionally — every single call (via
 * runTokscaleProcess) then went through `bunx tokscale@latest`, even with a
 * fully warm, working cache, on every scan. Exported pure so this mapping
 * is unit-tested directly against known package names rather than only
 * indirectly through a real cache directory. */
export function tokscalePlatformVariants(platform: string, arch: string): string[] {
  if (platform === "darwin") return [`cli-darwin-${arch}`];
  if (platform === "win32") return [`cli-win32-${arch}-msvc`];
  const linuxPlatform = platform === "linux" ? "linux" : platform;
  return [`cli-${linuxPlatform}-${arch}-gnu`, `cli-${linuxPlatform}-${arch}-musl`];
}

/** Exported (pure apart from the fs reads) so tests can drive it against a
 * synthetic cache directory and an explicit platform/arch, independent of
 * both the real ~/.bun cache and whatever OS the test happens to run on. */
export function findCachedTokscaleBinary(opts: {
  cacheRoot?: string;
  platform?: string;
  arch?: string;
} = {}): string[] | undefined {
  const cacheRoot = opts.cacheRoot ?? (() => {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home ? `${home}/.bun/install/cache/@tokscale` : undefined;
  })();
  if (!cacheRoot) return undefined;

  const variants = tokscalePlatformVariants(opts.platform ?? process.platform, opts.arch ?? process.arch);

  for (const variant of variants) {
    let versions: string[];
    try {
      versions = readdirSync(`${cacheRoot}/${variant}`);
    } catch {
      continue;
    }
    // Entries look like "4.10.0@@@1". Sort by the semver prefix so the newest
    // cached version wins even if directory mtime order is unreliable.
    const semvered = versions
      .filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => compareSemver(b.split("@@@")[0]!, a.split("@@@")[0]!));
    for (const entry of semvered) {
      const bin = `${cacheRoot}/${variant}/${entry}/bin/tokscale`;
      try {
        if (!statSync(bin).isFile()) continue;
      } catch {
        continue;
      }
      // Executability probe: a cache entry for the wrong libc (or a corrupt
      // download) exists as a file but can't run — spawnSync --version is the
      // only reliable check, and this runs at most once per process thanks to
      // the memo above. A failing candidate falls through to the next
      // variant/version, and ultimately to undefined (bunx fallback).
      const probe = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
      if (probe.exitCode === 0) return [bin];
    }
  }
  return undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Bunx's global `.bin` link step is not safe under concurrency: two
 * simultaneous `bunx tokscale@latest` processes can fail with EEXIST even
 * against an already-warm package cache (reproduced directly on bun 1.3.11,
 * 2026-08-07 — see the historical note on run.ts's runUsageQueryForTargets
 * for the full empirical background). This queue serializes bunx spawns one
 * at a time. On a cold cache the first invocation still goes through bunx
 * to download; after that the native binary is used directly. A separate
 * process-wide slot serializes every native or bunx invocation because they
 * have the same per-process memory cost. Env resolution, JSON parsing and
 * per-target extraCost probes in run.ts can still run concurrently. */
let bunxQueue: Promise<unknown> = Promise.resolve();
// One scan worker can launch tokscale once per target plus an hourly report.
// Serialize every invocation, including cached native binaries, so the pod's
// memory ceiling is independent of target count. The slot is held through
// child and process-group cleanup, including timeouts and read failures.
let tokscaleProcessQueue: Promise<unknown> = Promise.resolve();

export function withTokscaleProcessSlot<T>(job: () => Promise<T>): Promise<T> {
  const run = tokscaleProcessQueue.then(job, job);
  tokscaleProcessQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Runs tokscale with one set of args plus the given per-identity env, and
 * returns its stdout when it exits 0. Throws with tokscale's own stderr (or
 * a generic message) otherwise, and with a SyntaxError when the caller's
 * JSON.parse does — the two existing callers (runTokscale in usage/run.ts,
 * fetchTokscaleDailyUsage below) keep their exact prior error semantics,
 * they just share this one spawn now instead of each re-implementing it.
 * Splitting the spawn out is what lets usage/run.ts resolve targets
 * concurrently while this module bounds tokscale process memory. */
export async function runTokscaleProcess(args: string[], env: Record<string, string>): Promise<string> {
  return withTokscaleProcessSlot(async () => {
    const cached = resolveTokscaleCachedBinary();
    if (cached) return spawnTokscaleProcess(cached[0]!, [], args, env);
    const [cmd, ...prefixArgs] = resolveTokscaleCommand();
    const spawn = (): Promise<string> => spawnTokscaleProcess(cmd!, prefixArgs, args, env);
    const run = bunxQueue.then(spawn, spawn);
    bunxQueue = run.catch(() => undefined);
    return run;
  });
}

/** Hard ceiling for any single tokscale/bunx child. Without it a wedged
 * child (bunx hitting a stalled network, a scan crawling a hung mount)
 * pends the whole usage report forever; observed live 2026-08-26. Was 25s
 * — far too tight for the real data on this machine: a 1.3GB opencode.db
 * scan (or any scan, once ~25 tokscale children contend for disk) routinely
 * needs 25-55s, and the ceiling turned good data into "timed out" rows.
 * (main's interim 55s sat exactly ON that measured edge.) Even 120s later
 * proved too tight: under heavy disk contention, or after many new
 * transcripts (tokscale must parse every uncached file), whole Claude/Codex
 * rows timed out and silently contributed $0. The default is now 10 minutes,
 * which still bounds a genuinely wedged child; AIS_TOKSCALE_TIMEOUT_MS
 * overrides it (positive integer milliseconds, read at call time). */
export const DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS = 10 * 60 * 1000;

export function tokscaleSpawnTimeoutMs(): number {
  const raw = process.env.AIS_TOKSCALE_TIMEOUT_MS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS;
}

/** Message for a tokscale child that outlived the ceiling. Names the env var
 * so users know how to raise it. */
export function tokscaleTimeoutMessage(command: string, timeoutMs: number): string {
  return `${command} timed out after ${timeoutMs / 1000}s (raise the limit with AIS_TOKSCALE_TIMEOUT_MS, in milliseconds)`;
}

export async function spawnTokscaleProcess(
  cmd: string,
  prefixArgs: string[],
  args: string[],
  env: Record<string, string>,
  timeoutOverrideMs?: number,
): Promise<string> {
  // Keep tokscale in the scan worker's process group so an outer scan
  // deadline can terminate the entire scan tree with one group signal.
  const proc = Bun.spawn([cmd, ...prefixArgs, ...args], {
    stdin: "ignore",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Snapshot descendants while the leader is still alive. A child can exit
  // normally while a grandchild keeps running, at which point ancestry alone
  // can no longer identify that owned process.
  const knownDescendants = new Map<number, string>();
  const tracker = setInterval(() => collectTokscaleDescendants(proc.pid, knownDescendants), 10);
  const collect = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const timeoutMs = timeoutOverrideMs ?? tokscaleSpawnTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(tokscaleTimeoutMessage(`${cmd}${prefixArgs.length ? ` ${prefixArgs.join(" ")}` : ""}`, timeoutMs)),
      );
    }, timeoutMs);
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([collect, timeout]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `tokscale exited with code ${exitCode}`);
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(tracker);
    await terminateTokscaleProcess(proc, false, knownDescendants);
  }
}

const TOKSCALE_DESCENDANT_LIMIT = 4096;
const TOKSCALE_DESCENDANT_DEPTH_LIMIT = 128;
const TOKSCALE_TASK_LIMIT_PER_PROCESS = 256;

function collectTokscaleDescendants(parentPid: number | undefined, descendants: Map<number, string>): void {
  if (process.platform !== "linux" || !parentPid) return;
  const queue: Array<{ pid: number; depth: number }> = [{ pid: parentPid, depth: 0 }];
  const visited = new Set<number>([parentPid]);
  let discovered = 0;
  while (queue.length > 0 && discovered < TOKSCALE_DESCENDANT_LIMIT) {
    const current = queue.shift()!;
    if (current.depth >= TOKSCALE_DESCENDANT_DEPTH_LIMIT) continue;

    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${current.pid}/task`).slice(0, TOKSCALE_TASK_LIMIT_PER_PROCESS);
    } catch { /* process exited while /proc was read */ continue; }

    for (const task of tasks) {
      let children: string[];
      try {
        children = readFileSync(`/proc/${current.pid}/task/${task}/children`, "utf8").trim().split(/\s+/);
      } catch { /* thread exited while /proc was read */ continue; }
      for (const child of children) {
        if (!/^\d+$/.test(child)) continue;
        const pid = Number(child);
        if (!pid || visited.has(pid)) continue;
        visited.add(pid);
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          // The task children file is authoritative for ancestry, while this
          // check protects against a process exiting and its PID being reused.
          if (Number(fields[1]) !== current.pid || !fields[19]) continue;
          descendants.set(pid, fields[19]);
          discovered++;
          if (discovered >= TOKSCALE_DESCENDANT_LIMIT) break;
          queue.push({ pid, depth: current.depth + 1 });
        } catch { /* child exited while /proc was read */ }
      }
      if (discovered >= TOKSCALE_DESCENDANT_LIMIT) break;
    }
  }
}

export async function terminateTokscaleProcess(
  proc: Bun.Subprocess<any, "pipe", "pipe">,
  isolatedGroup: boolean,
  descendants = new Map<number, string>(),
): Promise<void> {
  let signalFailure: unknown;
  const signalDescendants = (value: "SIGTERM" | "SIGKILL") => {
    collectTokscaleDescendants(proc.pid, descendants);
    for (const [pid, startTime] of descendants) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[19] === startTime && fields[0] !== "Z" && fields[0] !== "X") process.kill(pid, value);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "ENOENT") signalFailure = error;
      }
    }
  };
  const descendantsAlive = () => {
    for (const [pid, startTime] of descendants) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[19] === startTime && fields[0] !== "Z" && fields[0] !== "X") return true;
      } catch { /* process exited */ }
    }
    return false;
  };
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    try {
      if (isolatedGroup && proc.pid) process.kill(-proc.pid, value);
      else {
        signalDescendants(value);
        proc.kill(value);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "ENOENT") signalFailure = error;
    }
  };
  const groupHasLiveMembers = () => {
    if (!isolatedGroup || !proc.pid) return false;
    if (process.platform === "linux") {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === proc.pid && fields[0] !== "Z" && fields[0] !== "X") return true;
        } catch { /* process exited while /proc was read */ }
      }
      return false;
    }
    try { process.kill(-proc.pid, 0); return true; } catch { return false; }
  };
  signal("SIGTERM");
  collectTokscaleDescendants(proc.pid, descendants);
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
  if (!exited || groupHasLiveMembers() || descendantsAlive()) {
    signal("SIGKILL");
    while (groupHasLiveMembers() || descendantsAlive()) {
      await Bun.sleep(250);
      signal("SIGKILL");
    }
  }
  await proc.exited;
  if (groupHasLiveMembers() || descendantsAlive()) throw new Error(`tokscale process tree ${proc.pid} still has live members after SIGKILL`);
  if (signalFailure !== undefined) throw signalFailure;
}

/** Where the last successful cache-refresh time is persisted, so the
 * cool-down below survives across process boundaries (each scan runs in a
 * brand-new `ais __scan_worker` child - see server/workers.ts - so an
 * in-memory-only timestamp would reset on every single scan and refresh on
 * every one, which is the bug this whole file's caching exists to avoid). */
function tokscaleRefreshStatePath(): string {
  return join(aisHome(), "usage", "tokscale-refresh.json");
}

async function readLastRefreshMs(path = tokscaleRefreshStatePath()): Promise<number | undefined> {
  try {
    const raw = (await Bun.file(path).json()) as { lastRefreshMs?: unknown };
    return typeof raw.lastRefreshMs === "number" && Number.isFinite(raw.lastRefreshMs) ? raw.lastRefreshMs : undefined;
  } catch {
    return undefined;
  }
}

async function writeLastRefreshMs(ms: number, path = tokscaleRefreshStatePath()): Promise<void> {
  try {
    await Bun.write(path, JSON.stringify({ lastRefreshMs: ms }));
  } catch {
    // Best-effort: a failed write just means the next process re-checks too.
  }
}

/** How often the bunx refresh (see below) is allowed to actually run once a
 * working cached binary already exists. Exported so the interval is
 * configurable for unusually stale/fast-moving setups; the default favours
 * "almost never" over "every scan" — see ensureTokscaleCacheFresh. */
export function tokscaleRefreshIntervalMs(): number {
  const raw = Number.parseInt(process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
}

/** Pure decision function behind ensureTokscaleCacheFresh's cool-down,
 * exported so it is unit-testable without touching the filesystem, a
 * network, or process-lifetime state. */
export function shouldRefreshTokscaleCache(lastRefreshMs: number | undefined, now: number, intervalMs: number): boolean {
  return lastRefreshMs === undefined || now - lastRefreshMs >= intervalMs;
}

/** Keeps Bun's tokscale cache from pinning a stale version forever, WITHOUT
 * re-verifying it on every scan. `resolveTokscaleCachedBinary` already picks
 * whatever version happens to be newest in the cache; left unrefreshed that
 * pins a stale tokscale forever, so this occasionally re-runs
 * `bunx tokscale@latest -- --version` (which also downloads/updates the
 * cache as a side effect) to catch up. That refresh is now gated on BOTH
 * "no working binary is cached yet" (a genuine cold start, always refreshes)
 * OR "the persisted cool-down has elapsed" (tokscaleRefreshIntervalMs,
 * default 24h) - previously it ran on every call whenever `tokscale` wasn't
 * literally on PATH, which given each scan runs in a brand-new
 * `__scan_worker` child (per-process memoization does nothing across
 * processes) meant EVERY scan, forever, re-ran a full `bunx` cold start -
 * complete with a fresh temp `bunx-*` extraction dir that macOS
 * Gatekeeper/XProtect re-scanned on every single launch, even though a
 * perfectly good native binary was already cached and immediately
 * discarded in favour of the bunx one. Never throws: if the refresh fails
 * (offline, registry down) the possibly-stale cached binary still serves,
 * matching tokscale's "prefer on PATH, bunx on demand" best-effort contract. */
let cacheFreshPromise: Promise<void> | undefined;
export function ensureTokscaleCacheFresh(): Promise<void> {
  if (!cacheFreshPromise) {
    cacheFreshPromise = (async () => {
      if (Bun.which("tokscale")) return; // PATH install: the user's own version choice.
      const cached = resolveTokscaleCachedBinary();
      if (cached) {
        const lastRefreshMs = await readLastRefreshMs();
        if (!shouldRefreshTokscaleCache(lastRefreshMs, Date.now(), tokscaleRefreshIntervalMs())) return;
      }
      await warmUpTokscaleCache();
    })();
  }
  return cacheFreshPromise;
}

async function warmUpTokscaleCache(): Promise<void> {
  // Enforce the short network warm-up ceiling inside the spawn helper, so
  // timeout includes child cleanup before its serialized slot is released.
  const warmUp = (): Promise<string> => spawnTokscaleProcess("bunx", ["tokscale@latest"], ["--version"], {}, 8_000);
  const run = withTokscaleProcessSlot(() => {
    const queued = bunxQueue.then(warmUp, warmUp);
    bunxQueue = queued.catch(() => undefined);
    return queued;
  });
  await run
    .then(() => writeLastRefreshMs(Date.now()))
    .catch(() => undefined);
}

/** One entry of tokscale's `hourly --json` output — only the fields this
 * module reads (`hour`/`input`/`output`) are typed; the real payload also
 * carries per-hour cache/reasoning/model/cost breakdowns this module has no
 * use for. */
interface TokscaleHourlyEntry {
  hour: string;
  input: number;
  output: number;
}
interface TokscaleHourlyReport {
  entries: TokscaleHourlyEntry[];
}

export interface DateSpan {
  firstMs: number;
  lastMs: number;
}

export interface DailyUsage {
  dateSpan: DateSpan;
  /** Local "YYYY-MM-DD" (see local-day.ts) -> total input+output tokens
   * that day. Only ever the days that actually had activity — a day with
   * no entry means no tracked usage, never a fabricated 0 for days outside
   * what tokscale actually returned. */
  daily: Record<string, number>;
}

/**
 * tokscale's default report (ModelReport, what `TokscaleReport` above
 * mirrors) carries no timestamps at all — confirmed by reading tokscale's
 * own source (junhoyeo/tokscale, crates/tokscale-core/src/lib.rs): neither
 * `ModelUsage` nor `ModelReport` has a date field, regardless of
 * `--group-by`. The `hourly` subcommand is the one place tokscale exposes
 * real dates: each `HourlyUsage` entry's `hour` is a
 * `Local.timestamp_opt(...).format("%Y-%m-%d %H:00")` bucket key (LOCAL
 * time, same machine tokscale runs on — same one this CLI runs on, so
 * `new Date("<hour>:00")` without a "Z" suffix parses it back correctly).
 * Feeds BOTH usage/report.ts's date-range/averages line and its
 * contribution-graph.ts week grid off one shared fetch/subprocess rather
 * than querying tokscale twice for the same underlying data.
 *
 * Fired concurrently with the main report fetch for the same target (usage/
 * run.ts's runOne fires both at once): when tokscale isn't on PATH yet, the
 * bunx queue in runTokscaleProcess below serializes the two spawns so they
 * can't race on bunx's global `.bin` link (the exact EEXIST failure the old
 * cross-target serialization comment documented, empirically); when it IS on
 * PATH they genuinely overlap. Returns undefined rather than throwing on any
 * failure (unsupported client, tokscale error, zero history) — this is a
 * display nicety, never something worth sinking the whole report over.
 */
export async function fetchTokscaleDailyUsage(
  toolName: "claude" | "codex" | "grok" | "kimi" | "opencode",
  identity: Identity,
): Promise<DailyUsage | undefined> {
  const invocation = await tokscaleInvocationFor(toolName, identity);
  if (!invocation) return undefined;
  const { env, clientArgs } = invocation;

  try {
    const stdout = await runTokscaleProcess(["hourly", ...clientArgs, "--json"], env);
    const parsed = JSON.parse(stdout) as TokscaleHourlyReport;
    return dailyUsageFromHourlyEntries(parsed.entries);
  } catch {
    return undefined;
  }
}

/** Strict "YYYY-MM-DD HH:00" match, validated BEFORE handing anything to
 * `Date` — `Date`'s own parser is too lenient to reject a malformed bucket
 * key by returning NaN (confirmed empirically: `new Date("not-a-date:00")`
 * parses to a real, garbage timestamp rather than Invalid Date), so
 * `Number.isFinite` alone isn't a reliable filter here. */
const HOUR_BUCKET_RE = /^\d{4}-\d{2}-\d{2} \d{2}:00$/;

/** Exported standalone so the "YYYY-MM-DD HH:00" bucket-key parsing and the
 * day rollup are unit-testable without a real tokscale subprocess. Rolls up
 * by taking the DATE PORTION of each hour bucket key directly (a plain
 * string slice) rather than reparsing into a Date and re-deriving the local
 * date — the bucket key is already local, so its own leading 10 characters
 * ARE the local date, with no timezone-conversion risk from round-tripping
 * through Date's local accessors a second time. */
export function dailyUsageFromHourlyEntries(entries: TokscaleHourlyEntry[]): DailyUsage | undefined {
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  const daily: Record<string, number> = {};

  for (const e of entries) {
    if (!HOUR_BUCKET_RE.test(e.hour)) continue;
    const ms = new Date(`${e.hour.replace(" ", "T")}:00`).getTime();
    if (!Number.isFinite(ms)) continue;
    firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
    lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    const dayKey = e.hour.slice(0, 10);
    daily[dayKey] = (daily[dayKey] ?? 0) + e.input + e.output;
  }

  if (firstMs === undefined || lastMs === undefined) return undefined;
  return { dateSpan: { firstMs, lastMs }, daily };
}
