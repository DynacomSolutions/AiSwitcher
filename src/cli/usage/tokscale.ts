import type { Identity, ToolConfig } from "../../identities/types.ts";
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isRetired } from "../../identities/retired.ts";
import { readZaiApiKey } from "../../identities/zai-auth.ts";
import { aisCacheDir, aisHome } from "../../shared/ais-home.ts";
import { defaultOpencodeProfileDbPath } from "./opencode-usage.ts";
import { TOKSCALE_TIME_ZONE_NAMES } from "./tokscale-zones.ts";

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
  /** Digest of the messages in the batch AIS already holds for this
   * partition. Identical messages are then reported as unchanged instead of
   * written out again (vendor/tokscale README). */
  previousMessagesSha256?: string;
  /** Write a segmented batch: content-addressed segments in this directory and
   * a small manifest at exportPath (vendor/tokscale README). */
  segmentDir?: string;
  /** File listing the segments AIS has verified on disk (one SHA-256 per
   * line). Only these may be left unwritten; every other segment is written. */
  reusableSegmentsFile?: string;
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

  const defaultOpencode = target.toolName === "opencode" && !target.identity;
  if (!target.identity && !defaultOpencode) throw new Error("native-export-identity-required");
  const sourceEnv = aisNativeSourceEnv(target.toolName, target.identity);
  if (!sourceEnv) return undefined;
  const clientArgs = ["--client", target.toolName];

  // The native exporter runs with an isolated config directory. Pass the
  // caller's pre-isolation Tokscale config root separately so its one-time
  // Claude message-cache seed can read only the historical source cache.
  const sourceTokscaleConfigDir = env.TOKSCALE_CONFIG_DIR ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tokscale");

  return {
    command,
    args: clientArgs,
    env: {
      ...sourceEnv,
      TOKSCALE_EXTRA_DIRS: "",
      TOKSCALE_AIS_SOURCE_CONFIG_DIR: resolve(sourceTokscaleConfigDir),
      TOKSCALE_CONFIG_DIR: aisNativeTokscaleConfigDir(),
      TOKSCALE_AIS_EXPORT_PATH: target.exportPath,
      TOKSCALE_AIS_PARTITION_ID: target.partitionId,
      // One message-cache scope per scanned source root: an export reads and
      // rewrites only its own identity's cache entries, not the whole
      // namespace (vendor/tokscale README).
      TOKSCALE_AIS_CACHE_SCOPE: aisTokscaleCacheScope(target.toolName, sourceEnv),
      // A warm scan trusts an exact size and mtime match, so an unchanged
      // transcript is only stat'ed, never read (vendor/tokscale README).
      TOKSCALE_AIS_STAT_ONLY_CACHE: "1",
      // A long cold scan commits its message cache as it goes, so an export
      // killed by the timeout below keeps what it parsed and the next cycle
      // continues from there (vendor/tokscale README).
      TOKSCALE_AIS_CHECKPOINT_SECS: String(TOKSCALE_EXPORT_CHECKPOINT_SECS),
      ...(target.previousMessagesSha256 && /^[a-f0-9]{64}$/.test(target.previousMessagesSha256)
        ? { TOKSCALE_AIS_PREVIOUS_MESSAGES_SHA256: target.previousMessagesSha256 }
        : {}),
      ...(target.segmentDir && isAbsolute(target.segmentDir) ? { TOKSCALE_AIS_SEGMENT_DIR: target.segmentDir } : {}),
      ...(target.segmentDir && target.reusableSegmentsFile && isAbsolute(target.reusableSegmentsFile)
        ? { TOKSCALE_AIS_REUSABLE_SEGMENTS_FILE: target.reusableSegmentsFile }
        : {}),
    },
    cwd: process.cwd(),
    ...(target.signal ? { signal: target.signal } : {}),
  };
}

/** The env that points the native exporter at one source's data: the same
 * roots `tokscaleInvocationFor` uses, plus the default OpenCode profile and
 * Pi. Undefined for tools without native capture (Z.ai, Alibaba). */
export function aisNativeSourceEnv(toolName: ToolConfig["toolName"], identity: Identity | undefined): Record<string, string> | undefined {
  if (!identity) return toolName === "opencode" ? { XDG_DATA_HOME: join(homedir(), ".local", "share") } : undefined;
  switch (toolName) {
    case "codex": return { CODEX_HOME: identity.configDir };
    case "grok": return { GROK_HOME: identity.configDir };
    case "kimi": return { KIMI_CODE_HOME: identity.configDir };
    case "claude": return { CLAUDE_CONFIG_DIR: identity.configDir };
    case "opencode": return { XDG_DATA_HOME: join(identity.configDir, "data") };
    case "pi": return { PI_CODING_AGENT_DIR: identity.configDir };
    default: return undefined;
  }
}

/** Tokscale's message-cache scope for one source. It is keyed by the tool
 * and the scanned root, not the identity name: cache entries are keyed by
 * absolute path, so a renamed or re-added identity with the same directory
 * keeps its cache, and a new directory could not reuse old entries anyway. */
export function aisTokscaleCacheScope(toolName: string, sourceEnv: Record<string, string>): string {
  const roots = Object.keys(sourceEnv).sort().map((key) => `${key}=${resolve(sourceEnv[key]!)}`).join("\0");
  return createHash("sha256").update(`ais-tokscale-cache-scope-v1\0${toolName}\0${roots}`).digest("hex");
}

const TOKSCALE_CACHE_SCOPE_DIRNAME = "source-message-cache-v2-ais-scope";

/** Where the patched Tokscale keeps scoped message caches. */
export function aisTokscaleCacheScopeRoot(): string {
  return join(aisNativeTokscaleConfigDir(), "cache", TOKSCALE_CACHE_SCOPE_DIRNAME);
}

/** A scope unused for this long, and absent from the live set, is removed. */
export const TOKSCALE_CACHE_SCOPE_MAX_IDLE_MS = 30 * 24 * 60 * 60_000;

/** Stamp a scope as used: its directory mtime is the sweep's last-use time.
 * Tokscale writes only inside the namespace subdirectories, so without this
 * an unchanged source's scope would look idle. Never throws. */
export function markTokscaleCacheScopeUsed(env: Record<string, string>): void {
  const scope = env.TOKSCALE_AIS_CACHE_SCOPE;
  const configDir = env.TOKSCALE_CONFIG_DIR;
  if (!scope || !/^[a-f0-9]{64}$/.test(scope) || !configDir || !isAbsolute(configDir)) return;
  try {
    const dir = join(configDir, "cache", TOKSCALE_CACHE_SCOPE_DIRNAME, scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    utimesSync(dir, now, now);
  } catch { /* a missed stamp only delays nothing: the scope stays live or young */ }
}

/** Delete scoped caches that no live source uses and that no export has used
 * for `maxIdleMs` (a removed identity or a moved directory). The age floor
 * protects a source that is only briefly missing from discovery, and a second
 * collector that sees the same caches under different paths. Never throws;
 * returns the number removed. */
export function sweepUnusedTokscaleCacheScopes(
  liveScopes: ReadonlySet<string>,
  root = aisTokscaleCacheScopeRoot(),
  nowMs = Date.now(),
  maxIdleMs = TOKSCALE_CACHE_SCOPE_MAX_IDLE_MS,
): number {
  let names: string[];
  try { names = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name) || liveScopes.has(name)) continue;
    try {
      if (nowMs - statSync(join(root, name)).mtimeMs < maxIdleMs) continue;
      rmSync(join(root, name), { recursive: true, force: true });
      removed++;
    } catch { /* retried next cycle */ }
  }
  return removed;
}

/** The isolated Tokscale config directory every native export runs with. Its
 * settings.json holds the scanner's bucket timezone (Tokscale pins it on its
 * first run), which the daily rollup of an export must reuse. */
export function aisNativeTokscaleConfigDir(): string {
  return join(aisCacheDir(), "usage", "native-tokscale", "isolated-config");
}

/** The snapshot worker owns this bounded process call and validates the
 * separately written export envelope before it can become visible. */
export async function runAisTokscaleExportInvocation(invocation: AisTokscaleExportInvocation): Promise<string> {
  if (invocation.signal?.aborted) throw new Error("native-export-aborted");
  markTokscaleCacheScopeUsed(invocation.env);
  return withTokscaleProcessSlot(() =>
    spawnTokscaleProcess(invocation.command, [], [...invocation.args, "--json"], invocation.env, tokscaleExportTimeoutMs()));
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

// One scan worker can launch tokscale once per source. Serialize every
// invocation so the pod's memory ceiling is independent of target count. The slot is held through
// child and process-group cleanup, including timeouts and read failures.
let tokscaleProcessQueue: Promise<unknown> = Promise.resolve();

export function withTokscaleProcessSlot<T>(job: () => Promise<T>): Promise<T> {
  const run = tokscaleProcessQueue.then(job, job);
  tokscaleProcessQueue = run.then(() => undefined, () => undefined);
  return run;
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

/** A native export writes the full message envelope (hundreds of MB for the swap pool) and the
 * collector service runs throttled (MemoryHigh, IO bandwidth caps), so it needs more headroom than a
 * plain report before a kill turns the partition into an error. The ceiling is never below the plain
 * tokscale one; AIS_TOKSCALE_EXPORT_TIMEOUT_MS overrides the default.
 *
 * A cold export of a large identity (an empty or deleted message cache) can need longer than this
 * under the service's 5 MB/s disk cap. It is still killed here, and its partition stays in error or
 * stale, since it never wrote a batch; but it checkpointed its message cache every
 * TOKSCALE_EXPORT_CHECKPOINT_SECS, so each cycle continues where the last one stopped until one
 * finishes and publishes the complete batch. */
export const DEFAULT_TOKSCALE_EXPORT_TIMEOUT_MS = 25 * 60 * 1000;

/** Minimum seconds between two message-cache checkpoints of one native export. The patched
 * Tokscale also waits at least four times the previous checkpoint's duration, which bounds the
 * extra writes as the cache grows. */
export const TOKSCALE_EXPORT_CHECKPOINT_SECS = 120;

export function tokscaleExportTimeoutMs(): number {
  const raw = process.env.AIS_TOKSCALE_EXPORT_TIMEOUT_MS?.trim() ?? "";
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  const configured = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOKSCALE_EXPORT_TIMEOUT_MS;
  return Math.max(configured, tokscaleSpawnTimeoutMs());
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

/** One entry of tokscale's `hourly --json` output — only the fields this
 * module reads (`hour`/`input`/`output`) are typed; the real payload also
 * carries per-hour cache/reasoning/model/cost breakdowns this module has no
 * use for. */
export interface TokscaleHourlyEntry {
  hour: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  messageCount?: number;
  cost?: number;
}

/** Per local day: [input, output, cacheRead, cacheWrite, messages, cost]. Exact
 * per-day figures, so a period total is a plain sum of days, never an estimate. */
export type DailyTotals = Record<string, [number, number, number, number, number, number]>;

export function addDailyTotals(into: DailyTotals, day: string, input: number, output: number, cacheRead: number, cacheWrite: number, messages: number, cost: number): void {
  const row = into[day] ??= [0, 0, 0, 0, 0, 0];
  row[0] += input; row[1] += output; row[2] += cacheRead; row[3] += cacheWrite; row[4] += messages; row[5] += cost;
}

export function mergeDailyTotals(a: DailyTotals | undefined, b: DailyTotals | undefined): DailyTotals | undefined {
  if (!a && !b) return undefined;
  const merged: DailyTotals = {};
  for (const source of [a, b]) for (const [day, v] of Object.entries(source ?? {})) addDailyTotals(merged, day, v[0], v[1], v[2], v[3], v[4], v[5]);
  return merged;
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
  totals: DailyTotals;
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
  const totals: DailyTotals = {};

  for (const e of entries) {
    if (!HOUR_BUCKET_RE.test(e.hour)) continue;
    const ms = new Date(`${e.hour.replace(" ", "T")}:00`).getTime();
    if (!Number.isFinite(ms)) continue;
    firstMs = firstMs === undefined ? ms : Math.min(firstMs, ms);
    lastMs = lastMs === undefined ? ms : Math.max(lastMs, ms);
    const dayKey = e.hour.slice(0, 10);
    daily[dayKey] = (daily[dayKey] ?? 0) + e.input + e.output;
    addDailyTotals(totals, dayKey, e.input, e.output, e.cacheRead ?? 0, e.cacheWrite ?? 0, e.messageCount ?? 0, e.cost ?? 0);
  }

  if (firstMs === undefined || lastMs === undefined) return undefined;
  return { dateSpan: { firstMs, lastMs }, daily, totals };
}

/** One message of an AIS native export batch: Tokscale's `UnifiedMessage`,
 * serialized with its snake_case field names. Only the fields the hourly
 * rollup reads are typed. */
interface NativeExportMessage {
  session_id?: unknown;
  dedup_key?: unknown;
  timestamp?: unknown;
  date?: unknown;
  tokens?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown } | null;
  message_count?: unknown;
  cost?: unknown;
}

export const LOCAL_RECOVERY_DAILY_PREFIX = "local-recovery:daily:";
const TOKSCALE_UNKNOWN_DATE = "unknown";

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The zone Tokscale buckets in for a configured `bucketTimezone`: the
 * trimmed name when chrono-tz parses it (case-sensitive IANA names and links
 * only), otherwise undefined, meaning local time, as Tokscale falls back. */
export function tokscalePinnedZone(bucketTimezone: string | undefined): string | undefined {
  const zone = bucketTimezone?.trim();
  return zone && TOKSCALE_TIME_ZONE_NAMES.has(zone) ? zone : undefined;
}

/** Formats an instant as Tokscale's "YYYY-MM-DD HH:00" hour key in its
 * bucket timezone: a pinned IANA zone, or the machine's local zone when none
 * is pinned or chrono-tz would reject the name (Tokscale's own fallback).
 * Memoized per minute, since every real zone offset is whole minutes. */
function tokscaleHourKeyFormatter(bucketTimezone: string | undefined): (timestampMs: number) => string {
  let zoned: Intl.DateTimeFormat | undefined;
  const zone = tokscalePinnedZone(bucketTimezone);
  if (zone) {
    try {
      zoned = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
      });
    } catch {
      zoned = undefined;
    }
  }
  const memo = new Map<number, string>();
  return (timestampMs) => {
    const minute = Math.floor(timestampMs / 60_000);
    const cached = memo.get(minute);
    if (cached !== undefined) return cached;
    let key: string;
    if (zoned) {
      const parts: Record<string, string> = {};
      for (const part of zoned.formatToParts(new Date(timestampMs))) parts[part.type] = part.value;
      key = `${(parts.year ?? "").padStart(4, "0")}-${parts.month}-${parts.day} ${parts.hour}:00`;
    } else {
      const d = new Date(timestampMs);
      key = `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
    }
    memo.set(minute, key);
    return key;
  };
}

/** Tokscale's `hourly` report computed from the messages an AIS native export
 * already holds, so the collector needs no second transcript scan. Mirrors
 * Tokscale 4.20's aggregate_hourly_usage_entries exactly: recovery daily rows
 * and undated balances are skipped, a timestamped message is keyed by its
 * hour in the bucket timezone, a timestamp-less one by `<date> 00:00`, and
 * costs add in message order within an hour, hours sorted by key. The export
 * holds the same parsed, unfiltered message set the hourly report filters
 * with no date range, which removes nothing. */
export function hourlyEntriesFromNativeMessages(messages: readonly unknown[], bucketTimezone?: string): TokscaleHourlyEntry[] {
  const hourKey = tokscaleHourKeyFormatter(bucketTimezone);
  const hours = new Map<string, TokscaleHourlyEntry>();
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as NativeExportMessage;
    const timestamp = finiteNumber(message.timestamp);
    const date = typeof message.date === "string" ? message.date : "";
    const dedupKey = typeof message.dedup_key === "string" ? message.dedup_key : undefined;
    if (dedupKey !== undefined && message.session_id === dedupKey && dedupKey.startsWith(LOCAL_RECOVERY_DAILY_PREFIX)) continue;
    if (timestamp === 0 && date === TOKSCALE_UNKNOWN_DATE) continue;
    const key = timestamp > 0 ? hourKey(timestamp) : `${date} 00:00`;
    let entry = hours.get(key);
    if (!entry) {
      entry = { hour: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messageCount: 0, cost: 0 };
      hours.set(key, entry);
    }
    const tokens = message.tokens ?? {};
    entry.input += finiteNumber(tokens.input);
    entry.output += finiteNumber(tokens.output);
    entry.cacheRead! += finiteNumber(tokens.cache_read);
    entry.cacheWrite! += finiteNumber(tokens.cache_write);
    entry.messageCount! += Math.max(0, finiteNumber(message.message_count, 1));
    entry.cost! += finiteNumber(message.cost);
  }
  return [...hours.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
}

/** The daily usage Tokscale's `hourly` report would give, derived from an
 * AIS native export's messages instead of a separate scan. */
export function dailyUsageFromNativeMessages(messages: readonly unknown[], bucketTimezone?: string): DailyUsage | undefined {
  return dailyUsageFromHourlyEntries(hourlyEntriesFromNativeMessages(messages, bucketTimezone));
}

/** The scanner bucket timezone Tokscale recorded in a config directory's
 * settings.json, or undefined (local time) when it is absent or unreadable.
 * Pass the TOKSCALE_CONFIG_DIR of the process that produced the data: for a
 * native export that is the isolated config, never the user's default
 * ~/.config/tokscale, which the exporter does not read. */
export function readTokscaleBucketTimezone(configDir: string): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { scanner?: { bucketTimezone?: unknown } };
    const zone = settings?.scanner?.bucketTimezone;
    return typeof zone === "string" && zone.trim() ? zone : undefined;
  } catch {
    return undefined;
  }
}
