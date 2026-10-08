import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { activeMemberAt, readSwapEvents, type SwapEvent } from "../../identities/claude-swap.ts";
import type { PoolIdentity } from "../../identities/swap-pool.ts";

/**
 * Per-member split of a swap pool's transcript usage. A pool shares one
 * projects/ folder, so the usual attribution-by-configDir sees only the
 * pool. Each assistant message is attributed to the member that was active
 * at its timestamp according to the claude-swap ledger. Messages before the
 * first ledger event are "(before first swap)". Approximate by design: all
 * sessions of a pool share one active member at any instant.
 */

export interface MemberSplitRow {
  member: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PoolUsageSplit {
  pool: string;
  days: number;
  members: MemberSplitRow[];
}

async function* jsonlFiles(dir: string, sinceMs: number): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path, sinceMs);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if ((await stat(path)).mtimeMs >= sinceMs) yield path;
      } catch {
        // vanished
      }
    }
  }
}

export function attributeLine(line: string, events: SwapEvent[], pool: string, sinceMs: number): { member: string; usage: Omit<MemberSplitRow, "member" | "messages"> } | undefined {
  if (!line.includes('"usage"')) return undefined;
  let parsed: { timestamp?: string; message?: { usage?: Record<string, number | undefined> } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const usage = parsed.message?.usage;
  const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  if (!usage || !Number.isFinite(at) || at < sinceMs) return undefined;
  return {
    member: activeMemberAt(events, pool, at) ?? "(before first swap)",
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

export async function poolMemberUsageSplit(pool: PoolIdentity, options: { days: number; ledgerPath: string; now?: number }): Promise<PoolUsageSplit> {
  const events = await readSwapEvents(options.ledgerPath);
  const sinceMs = (options.now ?? Date.now()) - options.days * 86_400_000;
  const rows = new Map<string, MemberSplitRow>();
  for await (const file of jsonlFiles(join(pool.configDir, "projects"), sinceMs)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const hit = attributeLine(line, events, pool.name, sinceMs);
      if (!hit) continue;
      const row = rows.get(hit.member) ?? { member: hit.member, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      row.messages += 1;
      row.input += hit.usage.input;
      row.output += hit.usage.output;
      row.cacheRead += hit.usage.cacheRead;
      row.cacheWrite += hit.usage.cacheWrite;
      rows.set(hit.member, row);
    }
  }
  return { pool: pool.name, days: options.days, members: [...rows.values()].sort((a, b) => b.output - a.output) };
}
