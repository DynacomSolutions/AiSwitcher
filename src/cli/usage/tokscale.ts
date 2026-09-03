import type { Identity, ToolConfig } from "../../identities/types.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readZaiApiKey } from "../../identities/zai-auth.ts";

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
 *   - claude: tokscale hardcodes `<home>/.claude/projects` and has no
 *     CLAUDE_CONFIG_DIR-equivalent override (confirmed absent from its
 *     source), so `TOKSCALE_EXTRA_DIRS=claude:<path>` — an additive extra
 *     scan root — is the only lever. Verified this correctly scopes to just
 *     one identity's data with no symlinks and no cross-identity leakage:
 *     the top-level `~/.claude` container this project uses has no
 *     `projects/` of its own, so tokscale's default scan root (still active
 *     alongside the extra dir) contributes nothing to double-count.
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
      return { env: { TOKSCALE_EXTRA_DIRS: tokscaleExtraDirEntry("claude", identity) }, clientArgs };
    case "zai": {
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
 * opencode has the same at-most-one limitation, for a different reason: its
 * scan root resolves through XDG_DATA_HOME (see tokscaleInvocationFor), a
 * single root that — unlike TOKSCALE_EXTRA_DIRS — can only ever point at
 * one identity's data dir. Same resolution: with exactly one opencode
 * target in the set its data root is included via `XDG_DATA_HOME`; with
 * zero or more than one, opencode is silently dropped from the merge.
 */
export async function buildMergedEnv(targets: Array<{ toolName: string; identity: Identity }>): Promise<Record<string, string>> {
  const entries: string[] = [];
  for (const t of targets) {
    if (tokscaleSupportsClient(t.toolName)) entries.push(tokscaleExtraDirEntry(t.toolName, t.identity));
  }
  const env: Record<string, string> = { TOKSCALE_EXTRA_DIRS: entries.join(",") };

  const zaiTargets = targets.filter((t) => t.toolName === "zai");
  if (zaiTargets.length === 1) {
    const apiKey = await readZaiApiKey(zaiTargets[0]!.identity.configDir);
    if (apiKey) env.ZAI_API_KEY = apiKey;
  }

  const opencodeTargets = targets.filter((t) => t.toolName === "opencode");
  if (opencodeTargets.length === 1) {
    env.XDG_DATA_HOME = join(opencodeTargets[0]!.identity.configDir, "data");
  }
  return env;
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
 * below) — so once the binary is cached, every tokscale call can run in
 * parallel with no serialization at all. Returns undefined when nothing is
 * resolvable yet (cold cache + caller must fall back to `bunx`, which is the
 * only path that downloads). Memoized per process: resolution doesn't change
 * within one CLI run (runUsageQueryForTargets refreshes the cache BEFORE any
 * call here can happen), and memoizing also avoids re-probing executability
 * on every one of the ~2N spawns in a full report. */
let cachedBinaryMemo: string[] | undefined | null = null;
export function resolveTokscaleCachedBinary(): string[] | undefined {
  if (cachedBinaryMemo === null) cachedBinaryMemo = findCachedTokscaleBinary();
  return cachedBinaryMemo;
}

function findCachedTokscaleBinary(): string[] | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return undefined;
  const cacheRoot = `${home}/.bun/install/cache/@tokscale`;

  // tokscale ships per-platform optional-dep packages (@tokscale/cli-<os>-<arch>-<libc>).
  // Try the native libc variant for this platform first, then the musl one.
  const platform = process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch;
  const variants = [`cli-${platform}-${arch}-gnu`, `cli-${platform}-${arch}-musl`];

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
 * at a time, but it is now only ever reached on a COLD cache (nothing
 * cached yet, so the very first invocation on a machine must still go
 * through bunx to download) — once the native binary is in Bun's install
 * cache, resolveTokscaleCachedBinary finds it and every subsequent spawn
 * bypasses bunx entirely, running fully in parallel. Everything OUTSIDE the
 * spawn (env resolution, JSON parsing, the per-target extraCost probes in
 * run.ts) runs concurrently either way; only bunx process creation itself
 * is serialized, which is the narrowest possible fix. */
let bunxQueue: Promise<unknown> = Promise.resolve();

/** Runs tokscale with one set of args plus the given per-identity env, and
 * returns its stdout when it exits 0. Throws with tokscale's own stderr (or
 * a generic message) otherwise, and with a SyntaxError when the caller's
 * JSON.parse does — the two existing callers (runTokscale in usage/run.ts,
 * fetchTokscaleDailyUsage below) keep their exact prior error semantics,
 * they just share this one spawn now instead of each re-implementing it.
 * Splitting the spawn out is what lets usage/run.ts run every target's work
 * concurrently while this module alone guarantees bunx spawn safety. */
export async function runTokscaleProcess(args: string[], env: Record<string, string>): Promise<string> {
  const cached = resolveTokscaleCachedBinary();
  if (cached) {
    return spawnTokscaleProcess(cached[0]!, [], args, env);
  }
  const [cmd, ...prefixArgs] = resolveTokscaleCommand();
  const spawn = (): Promise<string> => spawnTokscaleProcess(cmd!, prefixArgs, args, env);
  const run = bunxQueue.then(spawn, spawn);
  bunxQueue = run.catch(() => undefined);
  return run;
}

/** Hard ceiling for any single tokscale/bunx child. Without it a wedged
 * child (bunx hitting a stalled network, a scan crawling a hung mount)
 * pends the whole usage report forever; observed live 2026-08-26. Was 25s
 * — far too tight for the real data on this machine: a 1.3GB opencode.db
 * scan (or any scan, once ~25 tokscale children contend for disk) routinely
 * needs 25-55s, and the ceiling turned good data into "timed out" rows.
 * 120s still bounds a genuinely wedged child without truncating real work. */
const TOKSCALE_SPAWN_TIMEOUT_MS = 120_000;

async function spawnTokscaleProcess(
  cmd: string,
  prefixArgs: string[],
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const proc = Bun.spawn([cmd, ...prefixArgs, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const collect = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      reject(
        new Error(
          `${cmd}${prefixArgs.length ? ` ${prefixArgs.join(" ")}` : ""} timed out after ${TOKSCALE_SPAWN_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, TOKSCALE_SPAWN_TIMEOUT_MS);
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([collect, timeout]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `tokscale exited with code ${exitCode}`);
    return stdout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Once per CLI run, make sure Bun's tokscale cache is up to date before
 * fanning out to parallel cache-direct spawns: resolveTokscaleCachedBinary
 * picks whatever version happens to be newest in the cache, which pins a
 * stale tokscale forever if nothing ever refreshes it. `bunx tokscale@latest`
 * (run through bunxQueue, so it can't race anything) is the same refresh
 * mechanism the old design used implicitly on every single call — now it
 * runs exactly once, and only when tokscale isn't on PATH (a PATH install is
 * the user's own choice of version). Never throws: if the refresh fails
 * (offline, registry down) the possibly-stale cached binary still serves,
 * matching tokscale's "prefer on PATH, bunx on demand" best-effort contract. */
let cacheFreshPromise: Promise<void> | undefined;
export function ensureTokscaleCacheFresh(): Promise<void> {
  if (!cacheFreshPromise) {
    if (Bun.which("tokscale")) {
      cacheFreshPromise = Promise.resolve();
    } else {
      const warmUp = (): Promise<string> =>
        // bunx resolves @latest over the NETWORK; bound it far tighter than
        // real scans so an offline/stalled registry cannot hold a whole
        // usage report hostage (the cached binary still serves afterwards).
        Promise.race([
          spawnTokscaleProcess("bunx", ["tokscale@latest"], ["--version"], {}),
          Bun.sleep(8_000).then(() => {
            throw new Error("bunx cache warm-up timed out after 8s");
          }),
        ]);
      const run = bunxQueue.then(warmUp, warmUp);
      bunxQueue = run.catch(() => undefined);
      cacheFreshPromise = run.then(() => undefined).catch(() => undefined);
    }
  }
  return cacheFreshPromise;
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
