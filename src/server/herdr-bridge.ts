import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { resolveHerdrBinary } from "../shared/herdr-bin.ts";
import { readProcessEnviron, type EnvironAttribution } from "./processes.ts";
import { runScanIsolated } from "./workers.ts";

/**
 * The herdr metadata bridge: feeds per-pane AIS limit data to herdr's
 * sidebar via `herdr pane report-metadata <pane_id> --token $ais_...=...`.
 * herdr panes whose foreground process carries the wrapper's
 * IDENTITY_SESSION_MARKER get one metadata report per cycle with that
 * identity's limit percentages, so herdr's sidebar can show "s:18% w:42%"
 * next to each agent pane without herdr knowing anything about AIS.
 *
 * State machine (GET /api/herdr-bridge):
 *   - "disabled": config.enabled=false (the scheduler still answers, so the
 *     WebUI card can explain why nothing is happening).
 *   - "idle": herdr is not running (`herdr pane list` says so); every cycle
 *     retries, so attaching herdr resumes the bridge by itself.
 *   - "pending": herdr lacks `pane report-metadata`. The probe re-runs EVERY
 *     cycle while pending, so upgrading herdr flips the bridge to "active"
 *     automatically (within one interval) with zero config change.
 *   - "active": pushes happen. If a push itself fails in an unsupported-
 *     shaped way (CLI parsed it, server rejected it), the bridge drops back
 *     to pending and the next cycle re-probes.
 *
 * ZERO herdr source involvement: herdr is a third-party binary and the
 * bridge only ever CALLS its CLI (read-only subcommands plus the one
 * display-only report-metadata write). It never signals, restarts, or kills
 * any herdr process; killing our own timed-out CLI client spawn is the only
 * exception and it is not a herdr session process.
 *
 * Attribution reuses the /proc environ scanner's exact rules
 * (parseIdentityEnviron in processes.ts): a pane counts only when its
 * foreground process(es) carry AI_PROFILE_SWITCHER_SESSION. Environment
 * contents are never logged.
 *
 * Limits come from the SAME isolated scan pathway the /api/limits route
 * uses (runScanIsolated "limits"), with a small per-identity TTL cache so
 * panes sharing an identity share one scan and back-to-back cycles do not
 * refetch. No limits data for a pane means NO tokens pushed: herdr elides
 * empty tokens, so the pane simply keeps its previous tokens until the
 * push TTL expires (stale panes clear themselves).
 */

export const DEFAULT_HERDR_BRIDGE_INTERVAL_S = 60;
export const MIN_HERDR_BRIDGE_INTERVAL_S = 15;
export const DEFAULT_HERDR_BRIDGE_CATEGORIES = ["session", "week"] as const;
export const FIRST_TICK_DELAY_MS = 5_000;
export const PANE_LIST_TIMEOUT_MS = 10_000;
export const PROCESS_INFO_TIMEOUT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const PUSH_TIMEOUT_MS = 10_000;
/** Per-identity limits cache: matches the /api/limits server-side budget. */
export const LIMITS_TTL_MS = 45_000;
/** `--source` value on every metadata report, namespacing AIS's tokens. */
export const METADATA_SOURCE = "ais";
/** Token names must start with `$` (herdr's own rule: "custom tokens must
 * start with `$`"). The task contract's `$ais_*` names are literal. */
export const TOKEN_PREFIX = "$ais_";
/** herdr rejects ttl-ms above one day (its "metadata ttl_ms must be
 * 86400000 or less"); clamp so a large intervalS cannot produce an
 * always-rejected push. */
export const MAX_TTL_MS = 86_400_000;
/** The standing reason the WebUI shows while pending. */
export const PENDING_REASON = "report-metadata needs herdr >= 0.9.0";

export type BridgeCategory = "session" | "week" | "month";
const BRIDGE_CATEGORIES: readonly BridgeCategory[] = ["session", "week", "month"];

export interface HerdrBridgeConfig {
  enabled: boolean;
  intervalS: number;
  categories: BridgeCategory[];
  /** Machine-local kill switch for the metadata WRITES only. Attribution,
   * limits fetching and the capability probe still run; state still reports
   * what herdr supports. Default true. */
  push: boolean;
}

/** Tolerant config parse, same contract as the spend guard's: missing or
 * invalid fields fall to the defaults, out-of-range values clamp (a typoed
 * config must never disable the bridge or hammer herdr). Exported pure for
 * tests. */
export function parseHerdrBridgeConfig(raw: unknown): HerdrBridgeConfig {
  const source = (raw ?? {}) as { enabled?: unknown; intervalS?: unknown; categories?: unknown; push?: unknown };
  const interval = Number(source.intervalS);
  const categories = Array.isArray(source.categories)
    ? [...new Set(source.categories.filter((c): c is BridgeCategory => BRIDGE_CATEGORIES.includes(c as BridgeCategory)))]
    : [];
  return {
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    intervalS: Number.isFinite(interval) && interval > 0 ? Math.max(MIN_HERDR_BRIDGE_INTERVAL_S, Math.floor(interval)) : DEFAULT_HERDR_BRIDGE_INTERVAL_S,
    categories: categories.length > 0 ? categories : [...DEFAULT_HERDR_BRIDGE_CATEGORIES],
    push: source.push === undefined ? true : Boolean(source.push),
  };
}

export async function loadHerdrBridgeConfig(
  path: string = join(homedir(), ".ais", "config", "herdr-bridge.json"),
): Promise<HerdrBridgeConfig> {
  try {
    return parseHerdrBridgeConfig(await Bun.file(path).json());
  } catch {
    return parseHerdrBridgeConfig(undefined);
  }
}

/* ------------------------------ herdr CLI I/O ----------------------------- */

export interface HerdrCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when OUR timeout killed the spawned CLI client. */
  timedOut: boolean;
  error?: string;
}

/** Resolves the herdr binary for every bridge CLI call. Shared with
 * `ais herdr` and `ais upgrade` (shared/herdr-bin.ts: AIS_HERDR_BIN
 * override, then PATH, then ~/.local/bin/herdr; herdr is never bundled).
 * Re-exported so existing importers keep working. */
export { resolveHerdrBinary };

/** Runs one herdr CLI command with a hard timeout. The spawned process is a
 * short-lived CLI CLIENT talking to herdr's socket; killing it on timeout
 * never touches the user's herdr server or any pane process. */
export async function runHerdr(args: string[], timeoutMs: number): Promise<HerdrCommandResult> {
  const bin = resolveHerdrBinary();
  if (!bin) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, error: "herdr binary not found (PATH or ~/.local/bin)" };
  }
  let timedOut = false;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", timedOut: false, error: err instanceof Error ? err.message : String(err) };
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);
  timer.unref?.();
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    ok: !timedOut && exitCode === 0,
    exitCode,
    stdout,
    stderr,
    timedOut,
    ...(timedOut ? { error: `herdr ${args[0]} timed out after ${timeoutMs}ms` } : {}),
  };
}

/* ------------------------------ tolerant parse ---------------------------- */

export interface HerdrPane {
  pane_id?: string;
  agent?: string;
  agent_status?: string;
  /** herdr's own focus flag from `herdr pane list`: true for the pane the
   * user is currently looking at. Threaded into the DTO so the aistui
   * overview can mark the focused pane's identity more strongly. */
  focused?: boolean;
  cwd?: string;
  terminal_title?: string;
  workspace_id?: string;
}

/** Parses `herdr pane list` output: one line of JSON shaped
 * {"id":"cli:pane:list","result":{"panes":[...],"type":"pane_list"}}.
 * Tolerant by design: anything unexpected is zero panes, never a throw. */
export function parsePaneList(stdout: string): HerdrPane[] {
  let parsed: { result?: { panes?: unknown } };
  try {
    parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
  } catch {
    return [];
  }
  const panes = parsed.result?.panes;
  if (!Array.isArray(panes)) return [];
  return panes.flatMap((p) => {
    const pane = p as HerdrPane;
    return typeof pane?.pane_id === "string" && pane.pane_id.length > 0 ? [pane] : [];
  });
}

export interface HerdrProcessCandidate {
  pid: number;
  /** herdr's own binary basename for this process (argv[0] basename). */
  name?: string;
}

/** Extracts the environ-read candidates from `herdr pane process-info`
 * output: every foreground process of the pane's group (the AIS wrapper's
 * env markers are inherited by the whole group, and herdr lists the group
 * members verbatim), then the pane's shell as a last resort. Tolerant. */
export function parseProcessInfo(stdout: string): HerdrProcessCandidate[] {
  let parsed: { result?: { process_info?: { foreground_processes?: unknown; shell_pid?: unknown } } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return [];
  }
  const info = parsed.result?.process_info;
  if (!info) return [];
  const candidates = new Map<number, HerdrProcessCandidate>();
  if (Array.isArray(info.foreground_processes)) {
    for (const p of info.foreground_processes as Array<{ pid?: unknown; name?: unknown }>) {
      if (typeof p?.pid === "number" && Number.isFinite(p.pid) && !candidates.has(p.pid)) {
        candidates.set(p.pid, { pid: p.pid, ...(typeof p.name === "string" && p.name ? { name: p.name } : {}) });
      }
    }
  }
  if (typeof info.shell_pid === "number" && Number.isFinite(info.shell_pid) && !candidates.has(info.shell_pid)) {
    candidates.set(info.shell_pid, { pid: info.shell_pid });
  }
  return [...candidates.values()];
}

/* ---------------------------- feature detection ---------------------------- */

export type ProbeVerdict = "supported" | "pending";

/** Classifies a `herdr pane report-metadata --help` probe. Never performs a
 * write: the probe must be safe on any herdr version. Exit 0 means the CLI
 * knows the subcommand; a clap-style "unrecognized subcommand" means it
 * does not; a bare-invocation usage dump that still names the subcommand is
 * also proof the CLI knows it (exit 2 there is only a missing-args error). */
export function classifyProbe(exitCode: number | null, stdout: string, stderr: string): ProbeVerdict {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (exitCode === 0) return "supported";
  if (/(unknown command|unrecognized|no such command|invalid subcommand|not a valid)/.test(text)) return "pending";
  if (text.includes("report-metadata")) return "supported";
  return "pending";
}

export type PaneListFailure = "not-running" | "error";

/** Distinguishes "herdr isn't running" (state idle) from any other pane-list
 * failure (transient: keep the previous state, record the error). */
export function classifyPaneListFailure(stderr: string): PaneListFailure {
  if (/(no running|not running|server is not|failed to connect|connection refused|no such file|socket)/i.test(stderr)) {
    return "not-running";
  }
  return "error";
}

/* ------------------------------ token contract ---------------------------- */
/**
 * Tokens pushed per attributed pane (names are literal, `$` included):
 *   $ais_identity  identity label (the IDENTITY_SESSION_MARKER value)
 *   $ais_session   numeric 0-100 percent, rounded; omitted when the
 *                  provider has no session window (or "session" is not a
 *                  configured category)
 *   $ais_week      as above for the weekly window
 *   $ais_month     as above for the monthly window
 *   $ais_limits    preformatted compact summary of whichever configured
 *                  categories have data, e.g. "s:18% w:42%"
 * A pane whose identity yields no window data at all gets NO tokens
 * (not even $ais_identity): herdr elides empty metadata, and the pane's
 * previous tokens expire via the push TTL.
 * When several providers report the same category for one identity (a
 * multi-provider client), the MAX percent wins: the sidebar shows the
 * worst window, which is the one that would block the session.
 */

export interface LimitWindowLike {
  category?: unknown;
  usedPercent?: unknown;
}

/** Tolerant extraction of one identity's windows from a limits envelope's
 * results array (ToolLimitResult[] shapes, read field-by-field). */
export function windowsForIdentity(results: unknown, identity: string): LimitWindowLike[] {
  if (!Array.isArray(results)) return [];
  const out: LimitWindowLike[] = [];
  for (const result of results) {
    const name = (result as { identity?: { name?: unknown } } | null)?.identity?.name;
    if (name !== identity || !Array.isArray((result as { windows?: unknown }).windows)) continue;
    out.push(...((result as { windows: LimitWindowLike[] }).windows ?? []));
  }
  return out;
}

export interface PaneTokens {
  identity: string;
  session?: number;
  week?: number;
  month?: number;
  /** The $ais_limits summary; empty only when called with no data, in which
   * case the whole token set is undefined anyway. */
  summary: string;
}

/** Computes the token set for one pane's identity. Undefined when no
 * CONFIGURED category has any window data (that pane gets no push). */
export function computePaneTokens(
  identity: string,
  windows: readonly LimitWindowLike[],
  categories: readonly BridgeCategory[],
): PaneTokens | undefined {
  const maxFor = (category: BridgeCategory): number | undefined => {
    if (!categories.includes(category)) return undefined;
    let max: number | undefined;
    for (const window of windows) {
      if (window?.category !== category) continue;
      const pct = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : undefined;
      if (pct === undefined) continue;
      max = max === undefined ? pct : Math.max(max, pct);
    }
    return max === undefined ? undefined : Math.round(max);
  };
  const session = maxFor("session");
  const week = maxFor("week");
  const month = maxFor("month");
  if (session === undefined && week === undefined && month === undefined) return undefined;
  const parts: string[] = [];
  if (session !== undefined) parts.push(`s:${session}%`);
  if (week !== undefined) parts.push(`w:${week}%`);
  if (month !== undefined) parts.push(`m:${month}%`);
  return {
    identity,
    ...(session !== undefined ? { session } : {}),
    ...(week !== undefined ? { week } : {}),
    ...(month !== undefined ? { month } : {}),
    summary: parts.join(" "),
  };
}

/** Flattens a token set into report-metadata argv (--token NAME=VALUE
 * pairs; the summary's spaces ride inside one argv element). */
export function tokenArgs(tokens: PaneTokens): string[] {
  const args = ["--token", `${TOKEN_PREFIX}identity=${tokens.identity}`];
  if (tokens.session !== undefined) args.push("--token", `${TOKEN_PREFIX}session=${tokens.session}`);
  if (tokens.week !== undefined) args.push("--token", `${TOKEN_PREFIX}week=${tokens.week}`);
  if (tokens.month !== undefined) args.push("--token", `${TOKEN_PREFIX}month=${tokens.month}`);
  if (tokens.summary) args.push("--token", `${TOKEN_PREFIX}limits=${tokens.summary}`);
  return args;
}

/** Maps the recognised config-dir env vars back to the wrapping tool.
 * Extra vars score lower than a tool's own primary var, so an ali session
 * (which carries crush's vars as extras PLUS ALI_CONFIG_DIR) attributes to
 * ali, not zai. Undefined when nothing matches. */
export function toolFromIdentityEnv(identityEnv: Record<string, string>): string | undefined {
  let best: { tool: string; score: number } | undefined;
  for (const cfg of Object.values(TOOL_CONFIGS)) {
    let score = 0;
    if (identityEnv[cfg.envVarName] !== undefined) score += 2;
    for (const extra of cfg.extraEnvVarNames ?? []) {
      if (identityEnv[extra.name] !== undefined) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { tool: cfg.toolName, score };
  }
  return best?.tool;
}

/* -------------------------------- scheduler -------------------------------- */

export type HerdrBridgeState = "disabled" | "idle" | "pending" | "active";

export interface HerdrBridgePaneDto {
  paneId: string;
  agent?: string;
  agentStatus?: string;
  /** True only for herdr's currently focused pane (omitted otherwise, so
   * at most one pane in the list carries it). */
  focused?: boolean;
  /** AIS attribution: the marked process's binary basename, else the
   * config-dir env vars' tool, else herdr's own agent label. */
  tool?: string;
  identity?: string;
  title?: string;
  session?: number;
  week?: number;
  month?: number;
  /** The $ais_limits summary pushed for this pane, when any. */
  summary?: string;
}

export interface HerdrBridgeStatusDto {
  ok: true;
  state: HerdrBridgeState;
  running: boolean;
  config: HerdrBridgeConfig;
  herdrVersion?: string;
  /** Why state is "pending"; cleared once active/idle. */
  pendingReason?: string;
  panes: HerdrBridgePaneDto[];
  lastCycleAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
}

export interface ProbeOutcome {
  verdict: ProbeVerdict;
  version?: string;
}

export interface HerdrBridgeSchedulerDeps {
  config: HerdrBridgeConfig;
  /** Runs `herdr pane list`. Default: the real CLI with a 10s timeout. */
  paneList?: () => Promise<HerdrCommandResult>;
  /** Runs `herdr pane process-info --pane <id>`. */
  processInfo?: (paneId: string) => Promise<HerdrCommandResult>;
  /** Capability probe (CLI --help based, never a write) + version capture.
   * Default: `herdr pane report-metadata --help` + `herdr --version`. */
  probe?: () => Promise<ProbeOutcome>;
  /** /proc environ reader, defaulting to the shared scanner's reader. */
  readEnviron?: (pid: number) => Promise<EnvironAttribution | undefined>;
  /** Limits for one identity name: the results array of the /api/limits
   * envelope shape (or anything tolerable to windowsForIdentity). */
  fetchLimits?: (identity: string) => Promise<unknown>;
  /** The metadata write. Default: the real report-metadata CLI call. */
  push?: (paneId: string, args: string[]) => Promise<HerdrCommandResult>;
  now?: () => Date;
  log?: (message: string) => void;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

/** Default limits pathway: the SAME runScanIsolated("limits") the
 * /api/limits route uses, fronted by a small per-identity TTL cache so
 * panes sharing an identity share one scan. Failures are not cached: the
 * next cycle retries, and the failed identity simply pushes nothing this
 * cycle (TTL semantics keep its previous tokens alive meanwhile). */
function defaultFetchLimits(): (identity: string) => Promise<unknown> {
  const cache = new Map<string, { at: number; value: unknown }>();
  return async (identity: string): Promise<unknown> => {
    const hit = cache.get(identity);
    if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.value;
    const result = await runScanIsolated<{ results?: unknown }>("limits", { identity, maxAgeS: 45 }, 45_000);
    if (!result.ok) return [];
    const value = result.payload?.results ?? [];
    cache.set(identity, { at: Date.now(), value });
    return value;
  };
}

async function defaultProbe(): Promise<ProbeOutcome> {
  const [version, help] = await Promise.all([
    runHerdr(["--version"], PROBE_TIMEOUT_MS),
    runHerdr(["pane", "report-metadata", "--help"], PROBE_TIMEOUT_MS),
  ]);
  return {
    verdict: classifyProbe(help.exitCode, help.stdout, help.stderr),
    ...(version.ok ? { version: firstLine(version.stdout).split(/\s+/).pop() || undefined } : {}),
  };
}

export class HerdrBridgeScheduler {
  private readonly config: HerdrBridgeConfig;
  private readonly deps: HerdrBridgeSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private ticking = false;
  private state: HerdrBridgeState;
  private pendingReason: string | null = null;
  private probeVerdict: ProbeVerdict | null = null;
  /** Sticky guard against probe/push disagreement flapping: the first
   * unsupported-shaped PUSH failure downgrades to pending, but if that
   * keeps happening after a supported probe we stay put and surface the
   * error instead of oscillating every cycle. */
  private unsupportedPushFailures = 0;
  private herdrVersion: string | undefined;
  private panes: HerdrBridgePaneDto[] = [];
  private lastCycleAt: string | null = null;
  private lastPushAt: string | null = null;
  private lastError: string | null = null;
  private seq = 0;

  constructor(deps: HerdrBridgeSchedulerDeps) {
    this.config = deps.config;
    this.deps = deps;
    this.state = deps.config.enabled ? "idle" : "disabled";
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Deliberately no hydrate(): the bridge keeps no persistent state. Every
   * value it reports is recomputed within one interval from live sources
   * (herdr's pane list, /proc, the limits scan), and a daemon restart
   * losing the last cycle's snapshot is invisible at the next tick. */

  start(): void {
    if (!this.enabled || this.timer) return;
    this.stopped = false;
    if (this.state === "disabled") this.state = "idle";
    // First pass shortly after boot so a fresh daemon converges fast.
    this.bootTimer = setTimeout(() => void this.tick(), FIRST_TICK_DELAY_MS);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.config.intervalS * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = undefined;
    this.bootTimer = undefined;
  }

  status(): HerdrBridgeStatusDto {
    return {
      ok: true,
      state: this.state,
      running: !this.stopped && this.timer !== undefined,
      config: { ...this.config, categories: [...this.config.categories] },
      ...(this.herdrVersion !== undefined ? { herdrVersion: this.herdrVersion } : {}),
      ...(this.pendingReason ? { pendingReason: this.pendingReason } : {}),
      panes: this.panes.map((pane) => ({ ...pane })),
      lastCycleAt: this.lastCycleAt,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
    };
  }

  /** One bridge pass. Overlapping ticks are collapsed; errors are recorded,
   * never thrown (identical contract to the spend guard's tick). */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.enabled) return;
    this.ticking = true;
    try {
      await this.cycle();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`cycle failed: ${this.lastError}`);
    } finally {
      this.ticking = false;
    }
  }

  private ttlMs(): number {
    // Three intervals of survival after the last push: a pane whose agent
    // exited (or whose identity lost its limits data) clears itself soon,
    // while a transient bridge hiccup never blanks the sidebar.
    return Math.min(MAX_TTL_MS, Math.max(1_000, this.config.intervalS * 3 * 1000));
  }

  private async cycle(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();

    // (a) Enumerate panes. herdr not running -> idle (every cycle retries).
    const listed = await (this.deps.paneList ?? (() => runHerdr(["pane", "list"], PANE_LIST_TIMEOUT_MS)))();
    if (!listed.ok) {
      if (classifyPaneListFailure(listed.stderr) === "not-running") {
        this.state = "idle";
        this.pendingReason = null;
        this.lastError = firstLine(listed.error ?? listed.stderr) || "herdr is not running";
      } else {
        this.lastError = `herdr pane list failed: ${firstLine(listed.error ?? listed.stderr)}`;
      }
      this.lastCycleAt = now.toISOString();
      return;
    }
    const panes = parsePaneList(listed.stdout);
    this.lastError = null;

    // (e) Capability probe: cached once supported; re-probed EVERY cycle
    // while not supported, so a herdr upgrade flips us to active within one
    // interval, no daemon restart, no config change.
    if (this.probeVerdict !== "supported") {
      const probe = await (this.deps.probe ?? defaultProbe)();
      this.probeVerdict = probe.verdict;
      if (probe.version) this.herdrVersion = probe.version;
      if (probe.verdict === "supported") {
        this.state = "active";
        this.pendingReason = null;
      } else {
        this.state = "pending";
        this.pendingReason = PENDING_REASON;
      }
    }

    // (b) Attribute panes: process-info -> foreground pids -> /proc environ.
    // Only panes herdr itself reports an AGENT for are probed: a pane at a
    // bare shell prompt has no marked foreground process to find, and this
    // bounds the CLI calls to the panes that can ever attribute.
    const attributed: Array<{ pane: HerdrPane; identity: string; tool: string | undefined }> = [];
    for (const pane of panes) {
      if (!pane.agent) continue;
      const info = await (this.deps.processInfo ?? ((id: string) => runHerdr(["pane", "process-info", "--pane", id], PROCESS_INFO_TIMEOUT_MS)))(pane.pane_id!);
      if (!info.ok) continue;
      for (const candidate of parseProcessInfo(info.stdout)) {
        const env = await (this.deps.readEnviron ?? readProcessEnviron)(candidate.pid);
        if (!env?.wrapped || !env.identity) continue;
        attributed.push({
          pane,
          identity: env.identity,
          tool: candidate.name ?? toolFromIdentityEnv(env.identityEnv) ?? pane.agent,
        });
        break;
      }
    }

    // (c) Limits for exactly the affected identities (shared TTL cache).
    const limitsByIdentity = new Map<string, unknown>();
    for (const identity of new Set(attributed.map((a) => a.identity))) {
      limitsByIdentity.set(identity, await (this.deps.fetchLimits ?? defaultFetchLimits())(identity));
    }

    // (d) Tokens per pane + the status DTO.
    const dto: HerdrBridgePaneDto[] = [];
    const pushable: Array<{ paneId: string; tokens: PaneTokens }> = [];
    for (const { pane, identity, tool } of attributed) {
      const tokens = computePaneTokens(identity, windowsForIdentity(limitsByIdentity.get(identity), identity), this.config.categories);
      dto.push({
        paneId: pane.pane_id!,
        ...(pane.agent ? { agent: pane.agent } : {}),
        ...(pane.agent_status ? { agentStatus: pane.agent_status } : {}),
        ...(pane.focused ? { focused: true } : {}),
        tool,
        identity,
        ...(pane.terminal_title ? { title: pane.terminal_title } : {}),
        ...(tokens?.session !== undefined ? { session: tokens.session } : {}),
        ...(tokens?.week !== undefined ? { week: tokens.week } : {}),
        ...(tokens?.month !== undefined ? { month: tokens.month } : {}),
        ...(tokens?.summary ? { summary: tokens.summary } : {}),
      });
      if (tokens) pushable.push({ paneId: pane.pane_id!, tokens });
    }
    this.panes = dto;
    this.lastCycleAt = now.toISOString();

    // Push only when herdr supports the command and the machine config has
    // not opted out of writes.
    if (this.state !== "active" || !this.config.push) return;
    let pushedAny = false;
    const pushErrors: string[] = [];
    for (const { paneId, tokens } of pushable) {
      const args = [
        "pane",
        "report-metadata",
        paneId,
        "--source",
        METADATA_SOURCE,
        ...tokenArgs(tokens),
        "--seq",
        String(++this.seq),
        "--ttl-ms",
        String(this.ttlMs()),
      ];
      const result = await (this.deps.push ?? ((_paneId, pushArgs) => runHerdr(pushArgs, PUSH_TIMEOUT_MS)))(paneId, args);
      if (result.ok) {
        pushedAny = true;
        this.unsupportedPushFailures = 0;
        continue;
      }
      if (classifyProbe(result.exitCode, result.stdout, result.stderr) === "pending" && this.unsupportedPushFailures < 1) {
        // The CLI's own parser accepted the command at probe time but the
        // call failed in an unsupported shape: drop to pending and let the
        // next cycle's probe decide. The sticky counter stops an endless
        // probe-supported/push-rejected oscillation.
        this.unsupportedPushFailures += 1;
        this.probeVerdict = null;
        this.state = "pending";
        this.pendingReason = PENDING_REASON;
        this.lastError = `metadata push rejected by herdr: ${firstLine(result.error ?? result.stderr)}`;
        break;
      }
      pushErrors.push(`${paneId}: ${firstLine(result.error ?? result.stderr)}`);
    }
    if (pushedAny) this.lastPushAt = now.toISOString();
    if (pushErrors.length > 0) this.lastError = `metadata push failed: ${pushErrors.join("; ")}`;
  }

  private log(message: string): void {
    (this.deps.log ?? ((msg: string) => console.error(`[herdr-bridge] ${msg}`)))(message);
  }
}
