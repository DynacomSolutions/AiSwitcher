import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { categorizeByLabel } from "./bucket.ts";
import type { FetchedLimitResult } from "./types.ts";

const BILLING_EVENT_MSG = "billing: fetched credits config";

interface BillingLogEntry {
  ts?: string;
  msg?: string;
  ctx?: {
    config?: {
      creditUsagePercent?: number;
      currentPeriod?: { type?: string; start?: string; end?: string };
    };
  };
}

// Bare date, no "resets"/"period ends" wording of its own — report.ts
// already prefixes every window's resetsAt with "resets " generically, so a
// label here would double up into "resets period ends 7/20/2026".
function formatResetsAt(end: string | undefined): string | undefined {
  if (!end) return undefined;
  const parsed = new Date(end);
  return Number.isNaN(parsed.getTime()) ? end : parsed.toLocaleDateString();
}

/** No live/on-demand path exists for Grok (confirmed: `/usage show` is
 * TUI-only, `agent stdio`'s advertised capabilities carry no billing method).
 * The only available data is this incidental per-turn side effect — reverse
 * scan for the last "billing: fetched credits config" line rather than a
 * live query. Always `status: "cached"`, never "live", since freshness here
 * is entirely a function of when this identity was last actually used. */
export async function fetchGrokLimits(identity: Identity): Promise<FetchedLimitResult> {
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

    const config = entry.ctx?.config;
    const usedPercent = config?.creditUsagePercent;
    if (usedPercent === undefined) continue;

    const category = categorizeByLabel(config?.currentPeriod?.type ?? "week");
    return {
      ...base,
      windows: [
        {
          label: category === "other" ? "credits" : category,
          category,
          usedPercent,
          resetsAt: formatResetsAt(config?.currentPeriod?.end),
        },
      ],
      status: "cached",
      capturedAt: entry.ts,
    };
  }

  return {
    ...base,
    windows: [],
    status: "unavailable",
    error: "no billing data observed yet (needs at least one real session)",
  };
}
