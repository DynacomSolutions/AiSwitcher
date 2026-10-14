import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { resolveRealBinary } from "../../shared/resolve-binary.ts";
import { categorizeByLabel } from "./bucket.ts";
import { NdjsonReader, waitForResponse } from "./codex-limits.ts";
import type { FetchedLimitResult, LimitWindow } from "./types.ts";

const BILLING_EVENT_MSG = "billing: fetched credits config";

interface BillingConfig {
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
}

interface BillingLogEntry {
  ts?: string;
  msg?: string;
  ctx?: { config?: BillingConfig };
}

/** Whole spawn + initialize + billing budget. The call answers in ~400 ms
 * when healthy; this only bounds a hung binary. */
const LIVE_TIMEOUT_MS = 20_000;

// Bare date, no "resets"/"period ends" wording of its own — report.ts
// already prefixes every window's resetsAt with "resets " generically, so a
// label here would double up into "resets period ends 7/20/2026".
function formatResetsAt(end: string | undefined): string | undefined {
  if (!end) return undefined;
  const parsed = new Date(end);
  return Number.isNaN(parsed.getTime()) ? end : parsed.toLocaleDateString();
}

/** Shared by the live ACP read and the log scrape: both carry the same
 * billing `config` object. Undefined when it has no usage percentage. */
export function windowsFromBillingConfig(config: BillingConfig | undefined): LimitWindow[] | undefined {
  const usedPercent = config?.creditUsagePercent;
  if (usedPercent === undefined) return undefined;
  const end = config?.currentPeriod?.end;
  const category = categorizeByLabel(config?.currentPeriod?.type ?? "week");
  return [
    {
      label: category === "other" ? "credits" : category,
      category,
      usedPercent,
      resetsAt: formatResetsAt(end),
      ...(Number.isFinite(Date.parse(end ?? "")) ? { resetsAtMs: Date.parse(end!) } : {}),
    },
  ];
}

/** Live billing read: grok's ACP server (`grok agent --no-leader stdio`)
 * answers the `_x.ai/billing` extension method (the name without the
 * underscore is -32601). Throws on any failure; the caller falls back to
 * the log scrape. Notifications and other ids are skipped by waitForResponse. */
export async function fetchGrokBillingLive(identity: Identity): Promise<BillingConfig> {
  const binaryPath = resolveRealBinary("grok");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const proc = Bun.spawn([binaryPath, "agent", "--no-leader", "stdio"], {
      env: { ...process.env, GROK_HOME: identity.configDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    try {
      const reader = new NdjsonReader(proc.stdout);
      const encoder = new TextEncoder();
      const send = (msg: Record<string, unknown>) => {
        proc.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`));
        proc.stdin.flush();
      };
      send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      const init = await waitForResponse(reader, 1);
      if (init.error) throw new Error(init.error.message ?? "grok rejected initialize.");
      send({ id: 2, method: "_x.ai/billing", params: {} });
      const billing = await waitForResponse(reader, 2);
      if (billing.error) throw new Error(billing.error.message ?? "grok rejected _x.ai/billing.");
      const config = (billing.result as { config?: BillingConfig } | undefined)?.config;
      if (!config) throw new Error("grok returned no billing config.");
      return config;
    } finally {
      try {
        proc.kill();
      } catch {
        // Best-effort cleanup — nothing to do if the process is already gone.
      }
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`grok did not respond within ${LIVE_TIMEOUT_MS / 1000}s.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Last "billing: fetched credits config" line in the identity's unified
 * log, or an unavailable-reason string. Grok 1.0.50 only writes that line
 * when billing is explicitly fetched, so this is a stale-data fallback
 * (`status: "cached"`; freshness depends on when the identity last fetched
 * billing), also the only source under `--cached`. */
export async function fetchGrokLimitsFromLog(identity: Identity): Promise<FetchedLimitResult> {
  const base: Pick<FetchedLimitResult, "toolName" | "identity"> = { toolName: "grok", identity };
  const logPath = join(identity.configDir, "logs", "unified.jsonl");

  let text: string;
  try {
    text = await Bun.file(logPath).text();
  } catch {
    return { ...base, windows: [], status: "unavailable", error: "no usage log found (identity never used yet)" };
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: BillingLogEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.msg !== BILLING_EVENT_MSG) continue;

    const windows = windowsFromBillingConfig(entry.ctx?.config);
    if (!windows) continue;
    return { ...base, windows, status: "cached", capturedAt: entry.ts };
  }

  return {
    ...base,
    windows: [],
    status: "unavailable",
    error: "no billing data observed yet (needs at least one real session)",
  };
}

/** Live ACP billing read first; on any failure fall back to the log scrape,
 * and if that has nothing either, report the live error (the log's "needs a
 * session" hint would mislead when the real problem is the live call).
 * `live` is injectable for tests. `cached` skips the spawn entirely. */
export async function fetchGrokLimits(
  identity: Identity,
  cached = false,
  live: (identity: Identity) => Promise<BillingConfig> = fetchGrokBillingLive,
): Promise<FetchedLimitResult> {
  if (cached) return fetchGrokLimitsFromLog(identity);
  let liveError: string;
  try {
    const windows = windowsFromBillingConfig(await live(identity));
    if (windows) {
      return { toolName: "grok", identity, windows, status: "live", capturedAt: new Date().toISOString() };
    }
    liveError = "grok billing response had no usage percentage.";
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }
  const fromLog = await fetchGrokLimitsFromLog(identity);
  return fromLog.status === "unavailable" ? { ...fromLog, error: liveError } : fromLog;
}
