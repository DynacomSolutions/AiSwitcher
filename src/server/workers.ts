import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PollCache } from "./expensive.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import { CliUsageError } from "../cli/errors.ts";
import { collectTargets, pendingUsageResult } from "../cli/usage/run.ts";
import { tokscaleSpawnTimeoutMs } from "../cli/usage/tokscale.ts";
import { withUsableCwd } from "../shared/exec.ts";
import { runScan, type ScanKind, type ScanRequest, type ScanResult } from "./scan-worker.ts";
import { scanMetric } from "./scan-metrics.ts";
import { markUsageSnapshotDirty, usageSnapshotTargetKey } from "../cli/usage/snapshot-dirty.ts";
import {
  externalUsageCollectorOwnsRefreshes,
  recordUsageSnapshotRefreshFailure,
  USAGE_SNAPSHOT_REFRESH_INTERVAL_MS,
  type UsageSnapshotRefreshFailureCategory,
} from "../cli/usage/snapshot.ts";
import { defaultOpencodeProfileDbPath } from "../cli/usage/opencode-usage.ts";
import { requestStaleUsageBreakdowns, refreshQueuedUsageBreakdowns } from "../cli/usage/breakdown-snapshot.ts";
import { runBreakdownQuery } from "../cli/usage/breakdown.ts";

/** Child-process runner for expensive scans. Every scan executes in a fresh
 * `ais __scan_worker` child (same entrypoint trick as the web daemon:
 * compiled binaries re-exec themselves; dev prepends the bun runtime). The
 * request JSON goes in on stdin, the result JSON comes back on stdout, and
 * the parent hard-kills the child at its deadline so a wedged scan can
 * never accumulate. This replaces a Bun Worker attempt: bun --compile 1.3.x
 * cannot resolve worker entrypoints from the virtual /$bunfs filesystem. */

export interface ScanSpawn {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  requestedPort?: undefined;
}

/** Request-local SWR caches for tree, transcript, sessions and limits.
 * Usage and breakdown have durable shared stores with collector-owned
 * refreshes, so this process cache must not mask their freshness state. */
const treeCache = new PollCache(15_000);
const transcriptCache = new PollCache(4_000);
const sessionsCache = new PollCache(15_000);
const limitsCache = new PollCache(45_000);

async function pendingPayload(kind: "usage" | "breakdown", params: Omit<ScanRequest, "kind">): Promise<ScanResult<unknown>> {
  let results: unknown[] = [];
  if (kind === "usage") {
    try {
      const targets = await collectTargets({
        ...(params.tool !== undefined ? { tool: params.tool } : {}),
        ...(params.identity !== undefined ? { identity: params.identity } : {}),
      });
      results = targets.map(pendingUsageResult).filter((r) => r !== undefined);
    } catch (error) {
      if (error instanceof CliUsageError) throw error; // e.g. unknown --identity: an error, not pending
      // otherwise no seed rows; the bare pending flag still tells clients to keep polling
    }
  }
  return { ok: true, payload: { results, generatedAt: new Date().toISOString(), pending: true } };
}

function cacheFor(kind: ScanKind): PollCache | undefined {
  switch (kind) {
    case "tree":
      return treeCache;
    case "transcript":
      return transcriptCache;
    case "sessions":
      return sessionsCache;
    case "limits":
      return limitsCache;
    default:
      return undefined;
  }
}

/** Cache-through runner shared by every cacheable scan kind: identical
 * results inside the TTL (failures are never cached; the next poll
 * retries). The payload's `cached` flag is the DAEMON's (the scan child is
 * fresh every time, so its own flag is meaningless). `/api/limits` keeps
 * honouring its caller-supplied `?maxAge=` (clamped to a 5s floor, same as
 * scan-worker.ts's own limitsEnvelope did) rather than the fixed default,
 * since that is a documented API parameter, not an internal cache detail. */
async function cachedScan<T>(
  kind: "tree" | "transcript" | "limits" | "sessions",
  params: Omit<ScanRequest, "kind">,
  timeoutMs: number,
): Promise<ScanResult<T>> {
  const cache = cacheFor(kind)!;
  const key = JSON.stringify({ ...params, kind });
  const fetcher = async () => {
    const result = await spawnScanWorker<T>(kind, params, timeoutMs);
    if (!result.ok) throw new Error(result.error ?? `${kind} scan failed`);
    return result;
  };
  const maxAgeMs = kind === "limits" && typeof params.maxAgeS === "number" ? Math.max(5, params.maxAgeS) * 1000 : undefined;
  // usage/breakdown/tree/sessions are the slow scans (tokscale can run for
  // minutes; tree/sessions walk every transcript): serve the last-good value
  // immediately and refresh in the background. Only usage/breakdown have a
  // "pending" seed; a cold tree/sessions request waits for its first scan.
  if (kind === "tree" || kind === "sessions") {
    let swr;
    try {
      swr = await cache.getSwr(key, fetcher, undefined, {
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), status: error instanceof CliUsageError ? 400 : 500 };
    }
    if (swr.value.payload && typeof swr.value.payload === "object") {
      const payload = swr.value.payload as Record<string, unknown>;
      payload.cached = swr.cached;
      payload.stale = swr.stale;
      if (swr.lastError !== undefined) {
        payload.lastError = swr.lastError;
        payload.lastErrorAt = swr.lastErrorAt !== undefined ? new Date(swr.lastErrorAt).toISOString() : undefined;
      } else {
        delete payload.lastError;
        delete payload.lastErrorAt;
      }
    }
    return swr.value;
  }
  const { value, cached } = maxAgeMs !== undefined ? await cache.get(key, fetcher, maxAgeMs) : await cache.get(key, fetcher);
  if (value.payload && typeof value.payload === "object") {
    (value.payload as { cached?: boolean }).cached = cached;
  }
  return value;
}

function isScriptEntrypoint(main: string): boolean {
  try {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(main) && statSync(main).isFile();
  } catch {
    return false;
  }
}

function baseArgs(): string[] {
  const main = Bun.main;
  // Same discriminator as cli/web.ts's spawnDaemon: dev Bun.main is a real
  // .ts file (prepend the bun runtime); compiled Bun.main is a virtual
  // /$bunfs path and process.execPath IS the executable.
  const inner = isScriptEntrypoint(main) ? [process.execPath, main] : [process.execPath];
  const setsid = Bun.which("setsid");
  return setsid ? [setsid, ...inner] : inner;
}

/** Tree/transcript/sessions/limits use request-local SWR. Usage and
 * breakdown read shared snapshot stores instead. Exported as a pure predicate so the routing
 * decision itself is unit-testable without spawning anything. */
const CACHED_SCAN_KINDS = new Set<ScanKind>(["tree", "transcript", "limits", "sessions"]);
export function isCachedScanKind(kind: ScanKind): kind is "tree" | "transcript" | "limits" | "sessions" {
  return CACHED_SCAN_KINDS.has(kind);
}

/** Usage and breakdown scans spawn tokscale, whose own ceiling is
 * configurable (AIS_TOKSCALE_TIMEOUT_MS). The outer scan ceiling must never
 * be shorter than that or it would cut the child off first, so it is the
 * larger of the historical cap and the tokscale ceiling plus a margin. */
export function scanTimeoutAboveTokscale(baseMs: number): number {
  return Math.max(baseMs, tokscaleSpawnTimeoutMs() + 30_000);
}

export function usageSnapshotRefreshTimeoutMs(): number {
  return scanTimeoutAboveTokscale(30 * 60_000);
}

/** Run one source cycle and turn transport failures into a safe persisted
 * category. The isolated worker promise settles only after spawnScanWorkerNow
 * has completed process-group cleanup, so the failure marker never races a
 * still-running source child. */
export async function runUsageSnapshotRefreshCycle(
  run: () => Promise<{ ok: boolean; status?: number }>,
  recordFailure: (category: UsageSnapshotRefreshFailureCategory) => Promise<unknown> = recordUsageSnapshotRefreshFailure,
  logFailure: (category: UsageSnapshotRefreshFailureCategory) => void = (category) => {
    console.warn("Usage snapshot refresh did not complete", { category });
  },
  logPersistenceFailure: (category: UsageSnapshotRefreshFailureCategory) => void = (category) => {
    console.warn("Usage snapshot refresh failure could not be recorded", { category });
  },
): Promise<void> {
  let category: UsageSnapshotRefreshFailureCategory | undefined;
  try {
    const result = await run();
    if (!result.ok) category = result.status === 504 ? "collector-timeout" : "collector-failed";
  } catch {
    category = "collector-rejected";
  }
  if (!category) return;
  try { logFailure(category); } catch { /* reporting must not prevent persistence */ }
  try {
    await recordFailure(category);
  } catch {
    try { logPersistenceFailure(category); } catch { /* safe logging is best effort */ }
  }
}

export interface UsageSnapshotScheduledJobs {
  source?: Promise<void>;
  breakdown?: Promise<unknown>;
}

/** Start at most one source cycle and one drain. The drain waits for the
 * source cycle so failure persistence finishes first, while later sampler
 * ticks can schedule a new source even if the previous drain is still busy. */
export function scheduleUsageSnapshotJobs(
  jobs: UsageSnapshotScheduledJobs,
  startSource: () => Promise<void>,
  startBreakdown: () => Promise<unknown>,
): void {
  if (!jobs.source) {
    let source!: Promise<void>;
    source = Promise.resolve().then(startSource).finally(() => {
      if (jobs.source === source) jobs.source = undefined;
    });
    jobs.source = source;
  }
  if (!jobs.breakdown) {
    const sourceCycle = jobs.source!;
    let breakdown!: Promise<unknown>;
    breakdown = sourceCycle
      .then(startBreakdown)
      .catch(() => 0)
      .finally(() => {
        if (jobs.breakdown === breakdown) jobs.breakdown = undefined;
      });
    jobs.breakdown = breakdown;
  }
}

export async function waitForUsageSnapshotJobs(jobs: UsageSnapshotScheduledJobs): Promise<void> {
  await Promise.allSettled([jobs.source, jobs.breakdown].filter((job): job is Promise<unknown> => job !== undefined));
}

let warmed = false;
let snapshotSampler: ReturnType<typeof setInterval> | undefined;
let snapshotSourcePoller: ReturnType<typeof setInterval> | undefined;
const snapshotJobs: UsageSnapshotScheduledJobs = {};
let snapshotSourcePollInFlight: Promise<void> | undefined;
let knownOpencodeDbSignatures = new Map<string, string>();

function dbSignature(path: string): string {
  try {
    const info = statSync(path);
    const device = Reflect.get(info, "dev");
    return `${device}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return "absent";
  }
}

/** SQLite sources are intentionally outside the sync watcher's bounded
 * directory snapshots. Probe only the known database and WAL paths, never
 * enumerate their transcript trees. A changed signature marks its source
 * partition dirty; the two-minute collector spacing coalesces active writes. */
async function pollKnownUsageDatabases(): Promise<void> {
  let targets;
  try {
    targets = await collectTargets({ tool: "opencode" });
  } catch {
    return; // discovery errors must not turn into deletions or marker churn
  }
  const sources = [
    { key: "special:opencode-default", db: defaultOpencodeProfileDbPath() },
    ...targets.map((target) => ({
      key: usageSnapshotTargetKey(target.toolName, target.identity.name),
      db: join(target.identity.configDir, "data", "opencode", "opencode.db"),
    })),
  ];
  const next = new Map<string, string>();
  for (const source of sources) {
    const signature = `${dbSignature(source.db)}|${dbSignature(`${source.db}-wal`)}`;
    next.set(source.key, signature);
    const prior = knownOpencodeDbSignatures.get(source.key);
    if (prior !== undefined && prior !== signature) {
      try { markUsageSnapshotDirty(source.key); } catch { /* periodic TTL remains the safety fallback */ }
    }
  }
  // Keep disappeared identities' baseline for one cycle so a transient
  // registry error cannot silently forget their source history.
  for (const [key, signature] of knownOpencodeDbSignatures) {
    if (!next.has(key)) next.set(key, signature);
  }
  knownOpencodeDbSignatures = next;
}

export function startUsageSnapshotSourcePoller(intervalMs = 15_000): void {
  if (snapshotSourcePoller) return;
  knownOpencodeDbSignatures.clear();
  const poll = () => {
    if (snapshotSourcePollInFlight) return;
    snapshotSourcePollInFlight = pollKnownUsageDatabases().finally(() => { snapshotSourcePollInFlight = undefined; });
  };
  poll();
  snapshotSourcePoller = setInterval(poll, intervalMs);
}

export function stopUsageSnapshotSourcePoller(): void {
  if (snapshotSourcePoller) clearInterval(snapshotSourcePoller);
  snapshotSourcePoller = undefined;
}

function scheduleUsageSnapshotRefresh(run: typeof runScanIsolated): void {
  // The collector owns the default window even when no UI has requested it.
  // This only queues a marker when its durable last-good cache is missing or stale.
  requestStaleUsageBreakdowns();
  scheduleUsageSnapshotJobs(snapshotJobs,
    () => runUsageSnapshotRefreshCycle(
      () => run("usageSnapshotRefresh", {}, usageSnapshotRefreshTimeoutMs()),
    ),
    () => refreshQueuedUsageBreakdowns(
        (query) => scanWorkerLimiter.run(() => runBreakdownQuery(query)),
    ),
  );
}

/** One source refresh and one breakdown drain may run per daemon. Busy ticks
 * are dropped per job, so slow work cannot build an unbounded queue. */
export function startUsageSnapshotSampler(
  run: typeof runScanIsolated = runScanIsolated,
  intervalMs = USAGE_SNAPSHOT_REFRESH_INTERVAL_MS,
): void {
  if (snapshotSampler) return;
  scheduleUsageSnapshotRefresh(run);
  snapshotSampler = setInterval(() => scheduleUsageSnapshotRefresh(run), intervalMs);
}

export function stopUsageSnapshotSampler(): void {
  if (snapshotSampler) clearInterval(snapshotSampler);
  snapshotSampler = undefined;
  stopUsageSnapshotSourcePoller();
}

/** Long-running host producer entrypoint. A service manager supervises this
 * command; SIGTERM stops new ticks and waits for bounded source, breakdown,
 * and database-poll work already in flight before returning. */
export async function runUsageSnapshotDaemon(): Promise<void> {
  const markerPath = join(aisCacheDir(), "usage", "collector.external");
  mkdirSync(join(aisCacheDir(), "usage"), { recursive: true, mode: 0o700 });
  writeFileSync(markerPath, `${process.pid}\n`, { mode: 0o600 });
  chmodSync(markerPath, 0o600);
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const onSignal = () => {
    stopUsageSnapshotSampler();
    void Promise.allSettled([
      waitForUsageSnapshotJobs(snapshotJobs),
      snapshotSourcePollInFlight,
    ].filter((job): job is Promise<void> => job !== undefined)).finally(stop);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  startUsageSnapshotSourcePoller();
  requestStaleUsageBreakdowns();
  startUsageSnapshotSampler();
  await stopped;
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}

/** Web start: enqueue the default breakdown window. A supervised external
 * collector owns production scans; an unmanaged daemon may run the bounded
 * sampler as a fallback. */
export function warmUsageCaches(run: typeof runScanIsolated = runScanIsolated): void {
  if (warmed) return;
  warmed = true;
  requestStaleUsageBreakdowns();
  if (!externalUsageCollectorOwnsRefreshes()) startUsageSnapshotSampler(run);
}

export async function runScanIsolated<T>(
  kind: ScanKind,
  params: Omit<ScanRequest, "kind">,
  timeoutMs: number,
): Promise<ScanResult<T>> {
  if (isCachedScanKind(kind)) {
    return cachedScan<T>(kind, params, timeoutMs);
  }
  return spawnScanWorker<T>(kind, params, timeoutMs);
}

/** Caps how many async jobs run at once; extra callers queue FIFO for a
 * slot instead of running unbounded. Exported (and generic, not scan-worker
 * specific) so it is unit-testable with plain fake async tasks instead of
 * real child processes. */
export class ConcurrencyLimiter {
  private active = 0;
  private stopped = false;
  private readonly queue: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    scanMetric("active");
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("scan worker is stopping"));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    scanMetric("queued");
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve: () => {
        scanMetric("queued", -1);
        this.active++;
        resolve();
      }, reject });
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error("scan worker is stopping");
    for (const queued of this.queue.splice(0)) {
      scanMetric("queued", -1);
      queued.reject(error);
    }
  }

  private release(): void {
    this.active--;
    scanMetric("active", -1);
    const next = this.stopped ? undefined : this.queue.shift();
    if (next) next.resolve();
  }
}

/** Bounds how many `__scan_worker` children can run at once. Without this,
 * a burst of cache-missing requests (several identities/tools, several
 * endpoints, or several browser tabs all polling at once) fans out one
 * child per target with no ceiling - each doing its own disk scan and
 * tokscale spawns concurrently. Extra requests queue for a slot (FIFO)
 * rather than failing; the existing per-scan timeout still applies once a
 * scan actually starts, so a queued request cannot wait past its own
 * deadline unnoticed for long. */
export function scanWorkerConcurrencyLimit(): number {
  const raw = Number.parseInt(process.env.AIS_SCAN_WORKER_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
const scanWorkerLimiter = new ConcurrencyLimiter(scanWorkerConcurrencyLimit());
const activeScanCleanup = new Map<number, () => Promise<void>>();

/** Stop accepting queued/future scan work and reap active scan process groups.
 * The daemon calls this after HTTP draining and before it exits. */
export async function stopScanWorkers(): Promise<void> {
  scanWorkerLimiter.stop();
  await Promise.all([...activeScanCleanup.values()].map((cleanup) => cleanup()));
}

/** Stop an isolated worker and reap it before its limiter slot can be reused.
 * Without setsid, signal only the direct child: negative-PID group signalling
 * is safe only when this code created that process group itself. */
export async function terminateScanProcess(
  proc: Bun.Subprocess<any, any, any>,
  isolatedGroup: boolean,
): Promise<void> {
  let signalFailure: unknown;
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    try {
      if (isolatedGroup && proc.pid) process.kill(-proc.pid, value);
      else proc.kill(value);
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
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
  const forcedKill = !exited || groupHasLiveMembers();
  if (forcedKill) {
    signal("SIGKILL");
    const reportAfter = Date.now() + 2_000;
    let reported = false;
    while (groupHasLiveMembers()) {
      if (!reported && Date.now() >= reportAfter) {
        scanMetric("cleanupFailures");
        reported = true;
      }
      // Keep the limiter slot until every owned process is gone. Re-signal
      // at a bounded cadence in case a member was temporarily uninterruptible.
      await Bun.sleep(250);
      signal("SIGKILL");
    }
  }
  if (forcedKill) scanMetric("forcedKills");
  try {
    await proc.exited;
  } catch (error) {
    scanMetric("cleanupFailures");
    throw error;
  }
  if (signalFailure !== undefined) {
    scanMetric("cleanupFailures");
    throw signalFailure;
  }
}

async function spawnScanWorker<T>(
  kind: ScanKind,
  params: Omit<ScanRequest, "kind">,
  timeoutMs: number,
): Promise<ScanResult<T>> {
  return scanWorkerLimiter.run(() => spawnScanWorkerNow<T>(kind, params, timeoutMs));
}

async function spawnScanWorkerNow<T>(
  kind: ScanKind,
  params: Omit<ScanRequest, "kind">,
  timeoutMs: number,
): Promise<ScanResult<T>> {
  const req: ScanRequest = { kind, ...params };
  const args = baseArgs();
  const isolatedGroup = Bun.which("setsid") !== null;
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = withUsableCwd(() => Bun.spawn([...args, "__scan_worker"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    }));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "failed to start scan worker", status: 500 };
  }

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= terminateScanProcess(proc, isolatedGroup).finally(() => {
      activeScanCleanup.delete(proc.pid!);
    });
    return cleanupPromise;
  };
  if (proc.pid) activeScanCleanup.set(proc.pid, cleanup);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text().catch(() => "");
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    proc.stdin.write(JSON.stringify(req));
    proc.stdin.end();
    const stdout = await Promise.race([output, deadline]);
    if (stdout === null) {
      scanMetric("timeouts");
      return { ok: false, error: `${kind} scan timed out after ${Math.round(timeoutMs / 1000)}s`, status: 504 };
    }
    let parsed: ScanResult<T>;
    try {
      parsed = JSON.parse(stdout) as ScanResult<T>;
    } catch {
      const errorText = await Promise.race([stderr, Bun.sleep(100).then(() => "")]);
      parsed = { ok: false, error: errorText.trim() || "scan worker produced no output", status: 500 };
    }
    return parsed;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "scan worker failed", status: 500 };
  } finally {
    if (timer) clearTimeout(timer);
    await cleanup();
  }
}

/** Entry point for `ais __scan_worker`: one scan request on stdin, one JSON
 * response on stdout, then exit. */
export async function runScanWorkerStdio(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).text();
  let req: ScanRequest;
  try {
    req = JSON.parse(input) as ScanRequest;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid scan request", status: 400 })}\n`);
    return;
  }
  const result = await runScan(req);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
