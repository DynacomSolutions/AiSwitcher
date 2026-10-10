import { statSync } from "node:fs";
import { join } from "node:path";
import { PollCache } from "./expensive.ts";
import { aisCacheDir } from "../shared/ais-home.ts";
import { CliUsageError } from "../cli/errors.ts";
import { collectTargets, pendingUsageResult } from "../cli/usage/run.ts";
import { tokscaleSpawnTimeoutMs } from "../cli/usage/tokscale.ts";
import { withUsableCwd } from "../shared/exec.ts";
import { runScan, type ScanKind, type ScanRequest, type ScanResult } from "./scan-worker.ts";

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

/** DAEMON-side result caches for the poll-heavy scans. The child is
 * short-lived, so scan-worker.ts's own PollCache can never carry a result
 * across HTTP requests; these hold it in the daemon instead.
 *
 * usage/limits/breakdown used to skip this entirely: only tree/transcript
 * were cached here, so every /api/usage and /api/limits request (WebUI
 * polls both on an interval, plus react-query's own refetch-on-focus/
 * reconnect) spawned a brand-new `__scan_worker` child that re-ran the full
 * scan from scratch - including, for usage, a fresh tokscale invocation
 * per target (main report + hourly) PLUS the (now-fixed, see
 * cli/usage/tokscale.ts) `--version` cache-freshness check, every single
 * time. scan-worker.ts's own module-level PollCache instances for these
 * kinds were never actually reachable across requests (a new process means
 * a new module scope), so the "cached" flag they produced was always a lie.
 * Bringing usage/limits/breakdown into this SAME daemon-side cache (the
 * mechanism tree/transcript already use, and the one scan-worker.ts's own
 * doc comments describe as the intended design) is what makes repeated
 * polls inside the TTL actually skip the child entirely, instead of
 * silently re-scanning every time. The transcript TTL is deliberately just
 * under the WebUI's 3s chat poll: a poll is cheap (no child spawned) while
 * appended lines surface within one interval, keeping an in-progress
 * transcript live. usage/limits TTLs match the values scan-worker.ts's own
 * (previously dead) caching already documented as the intended budget. */
const treeCache = new PollCache(15_000);
const transcriptCache = new PollCache(4_000);
const usageCache = new PollCache(45_000, join(aisCacheDir(), "swr", "usage"));
const limitsCache = new PollCache(45_000);
const breakdownCache = new PollCache(60_000, join(aisCacheDir(), "swr", "breakdown"));

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
    case "usage":
      return usageCache;
    case "limits":
      return limitsCache;
    case "breakdown":
      return breakdownCache;
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
  kind: "tree" | "transcript" | "usage" | "limits" | "breakdown",
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
  // usage/breakdown are the slow scans (tokscale can run for minutes): serve
  // the last-good value immediately and refresh in the background.
  if (kind === "usage" || kind === "breakdown") {
    let swr;
    try {
      swr = await cache.getSwr(key, fetcher, undefined, {
        pending: () => pendingPayload(kind, params) as Promise<ScanResult<T>>,
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

/** Every poll-driven kind (tree/transcript, and now usage/limits/
 * breakdown) serves repeats from the daemon cache instead of spawning a
 * fresh child per request; see cachedScan's doc comment above. "sessions"
 * is a lighter local listing with no tokscale/provider-API cost and stays
 * uncached, same as before. Exported as a pure predicate so the routing
 * decision itself is unit-testable without spawning anything. */
const CACHED_SCAN_KINDS = new Set<ScanKind>(["tree", "transcript", "usage", "limits", "breakdown"]);
export function isCachedScanKind(kind: ScanKind): kind is "tree" | "transcript" | "usage" | "limits" | "breakdown" {
  return CACHED_SCAN_KINDS.has(kind);
}

/** Usage and breakdown scans spawn tokscale, whose own ceiling is
 * configurable (AIS_TOKSCALE_TIMEOUT_MS). The outer scan ceiling must never
 * be shorter than that or it would cut the child off first, so it is the
 * larger of the historical cap and the tokscale ceiling plus a margin. */
export function scanTimeoutAboveTokscale(baseMs: number): number {
  return Math.max(baseMs, tokscaleSpawnTimeoutMs() + 30_000);
}

let warmed = false;

/** Daemon start: one background refresh of the keys the TUI and web request by
 * default (/api/usage, /api/usage/breakdown?days=30), so the cache is warm
 * before the first client. Never awaited; the scan limiter still applies. */
export function warmUsageCaches(run: typeof runScanIsolated = runScanIsolated): void {
  if (warmed) return;
  warmed = true;
  void run("usage", {}, scanTimeoutAboveTokscale(60_000)).catch(() => undefined);
  void run("breakdown", { days: 30 }, scanTimeoutAboveTokscale(240_000)).catch(() => undefined);
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
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
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
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}
const scanWorkerLimiter = new ConcurrencyLimiter(scanWorkerConcurrencyLimit());

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
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let settled = false;
  const finish = (result: ScanResult<T>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      proc?.kill();
    } catch {
      // already exited
    }
  };
  let timer!: ReturnType<typeof setTimeout>;
  const result = await new Promise<ScanResult<T>>((resolve) => {
    timer = setTimeout(() => {
      finish({ ok: false, error: `${kind} scan timed out after ${Math.round(timeoutMs / 1000)}s`, status: 504 });
      resolve({ ok: false, error: `${kind} scan timed out after ${Math.round(timeoutMs / 1000)}s`, status: 504 });
    }, timeoutMs);
    try {
      proc = withUsableCwd(() =>
        Bun.spawn([...baseArgs(), "__scan_worker"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : "failed to start scan worker", status: 500 });
      return;
    }
    const child = proc;
    void new Response(child.stdout).text().then((stdout) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(stdout) as ScanResult<T>;
        finish(parsed);
        resolve(parsed);
      } catch {
        void new Response(child.stderr).text().then((stderr) => {
          const failure = { ok: false, error: stderr.trim() || "scan worker produced no output", status: 500 } as ScanResult<T>;
          finish(failure);
          resolve(failure);
        });
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
  finish(result);
  return result;
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
