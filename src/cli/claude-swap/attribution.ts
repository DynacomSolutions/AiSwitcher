import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { activeMemberAt, eventsForPool, readSwapEvents, type SwapEvent } from "../../identities/claude-swap.ts";
import { estimateChatModelTokenCost } from "../../identities/model-pricing.ts";
import type { PoolIdentity } from "../../identities/swap-pool.ts";
import type { Identity } from "../../identities/types.ts";
import { localDateKey } from "../usage/local-day.ts";
import type { TokscaleEntry } from "../usage/tokscale.ts";

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

export function attributeLine(
  line: string,
  events: SwapEvent[],
  pool: string,
  sinceMs: number,
): { member: string; at: number; model?: string; id?: string; usage: Omit<MemberSplitRow, "member" | "messages"> } | undefined {
  if (!line.includes('"usage"')) return undefined;
  let parsed: { timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, number | undefined> } };
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
    at,
    ...(parsed.message?.model ? { model: parsed.message.model } : {}),
    ...(parsed.message?.id ? { id: parsed.message.id } : {}),
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

export async function poolMemberUsageSplit(pool: PoolIdentity, options: { days: number; ledgerPath: string; now?: number }): Promise<PoolUsageSplit> {
  const events = eventsForPool(await readSwapEvents(options.ledgerPath), pool);
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

export interface PoolMemberUsage {
  /** Registry member name, or undefined when the share cannot be attributed. */
  member: string | undefined;
  entries: TokscaleEntry[];
  firstMs: number;
  lastMs: number;
  dailyUsage: Record<string, number>;
}

/** Per-member, per-model usage of a pool's whole transcript history, for
 * `ais usage`: a pool is not an account, so its messages are charged to the
 * member active at each timestamp. Messages before the first ledger event go
 * to the first event's `from` (else `to`), else the pool's active/first
 * member; a member no longer in the pool is reported as unattributed.
 * Costs are list-price estimates; callers with a real figure (tokscale) override them.
 * Messages are de-duplicated by message id, as transcripts repeat them. */
export async function poolMemberModelUsage(pool: PoolIdentity, members: Identity[], ledgerPath: string): Promise<PoolMemberUsage[]> {
  const events = eventsForPool(await readSwapEvents(ledgerPath), pool);
  const fallback = events[0] ? events[0].from ?? events[0].to : pool.swapPool.active ?? pool.swapPool.accounts[0];
  const known = new Set(members.map((m) => m.name));
  const byMember = new Map<string | undefined, PoolMemberUsage>();
  const seen = new Set<string>();
  for await (const file of jsonlFiles(join(pool.configDir, "projects"), 0)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const hit = attributeLine(line, events, pool.name, 0);
      if (!hit) continue;
      if (hit.id) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
      }
      const name = hit.member === "(before first swap)" ? fallback : hit.member;
      const member = name !== undefined && known.has(name) ? name : undefined;
      const row = byMember.get(member) ?? { member, entries: [], firstMs: hit.at, lastMs: hit.at, dailyUsage: {} };
      byMember.set(member, row);
      const model = hit.model ?? "unknown";
      let entry = row.entries.find((e) => e.model === model);
      if (!entry) {
        entry = { client: "claude", provider: "anthropic", model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 };
        row.entries.push(entry);
      }
      const { input, output, cacheRead, cacheWrite } = hit.usage;
      entry.input += input;
      entry.output += output;
      entry.cacheRead += cacheRead;
      entry.cacheWrite += cacheWrite;
      entry.messageCount += 1;
      entry.cost += estimateChatModelTokenCost(model, input, output, cacheRead, cacheWrite) ?? 0;
      row.firstMs = Math.min(row.firstMs, hit.at);
      row.lastMs = Math.max(row.lastMs, hit.at);
      const day = localDateKey(hit.at);
      row.dailyUsage[day] = (row.dailyUsage[day] ?? 0) + input + output;
    }
  }
  return [...byMember.values()];
}
