import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { aisSwapLedgerPath } from "../../shared/ais-home.ts";
import type { PoolAdapter, SwapEvent, SwapReason } from "./adapter.ts";
import type { PoolIdentity } from "./swap-pool.ts";

/** Per-tool swap ledger (`~/.ais/state/<tool>-swap.jsonl`). */

export const ledgerPathFor = (tool: PoolAdapter["tool"]): string => aisSwapLedgerPath(tool);

export async function appendSwapEvent(event: SwapEvent, ledgerPath: string): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** All ledger events, oldest first. Torn or foreign lines are skipped. */
export async function readSwapEvents(ledgerPath: string): Promise<SwapEvent[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const events: SwapEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<SwapEvent>;
      if (typeof e.ts === "string" && typeof e.pool === "string" && typeof e.to === "string" && Number.isFinite(Date.parse(e.ts))) {
        events.push({
          ts: e.ts,
          pool: e.pool,
          from: typeof e.from === "string" ? e.from : null,
          to: e.to,
          reason: (e.reason ?? "manual") as SwapReason,
          ...(typeof e.hardLimitUntilMs === "number" && Number.isFinite(e.hardLimitUntilMs) ? { hardLimitUntilMs: e.hardLimitUntilMs } : {}),
        });
      }
    } catch {
      // torn line
    }
  }
  return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The member active in `pool` at `atMs`, per the ledger (undefined before
 * the first recorded swap). */
export function activeMemberAt(events: SwapEvent[], pool: string, atMs: number): string | undefined {
  let active: string | undefined;
  for (const e of events) {
    if (e.pool !== pool) continue;
    if (Date.parse(e.ts) > atMs) break;
    active = e.to;
  }
  return active;
}

/** Ledger events for `pool`, normalised to its current name. Events keep the
 * pool name of their day, so a renamed pool's history is matched by its
 * current name, its configDir basename (the original name) or an alias. */
export function eventsForPool(events: SwapEvent[], pool: PoolIdentity): SwapEvent[] {
  const names = new Set([pool.name, basename(pool.configDir), ...(pool.aliases ?? [])]);
  return events.filter((e) => names.has(e.pool)).map((e) => ({ ...e, pool: pool.name }));
}
