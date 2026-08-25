import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { estimateDetailedModelTokenCost } from "../../identities/model-pricing.ts";
import type { Identity } from "../../identities/types.ts";
import { localDateKey } from "./local-day.ts";
import { canonicalUsageProvider } from "./providers.ts";
import type { DateSpan, TokscaleEntry, TokscaleReport } from "./tokscale.ts";

export interface PiProviderUsage {
  provider: string;
  /** Pi adapters that spawn a native AIS-wrapped CLI are already present in
   * that CLI's history. Kept internal so the combined report can prefer the
   * native counters without hiding the traffic from --tool=pi. */
  nativeCoverageTool?: "claude" | "codex";
  report: TokscaleReport;
  dateSpan: DateSpan;
  dailyUsage: Record<string, number>;
}

interface PiAttribution {
  provider: string;
  nativeCoverageTool?: "claude" | "codex";
  fraction: number;
}

interface MutableProviderUsage {
  entries: Map<string, TokscaleEntry>;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalMessages: number;
  totalCost: number;
  firstMs: number;
  lastMs: number;
  dailyUsage: Record<string, number>;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  await visit(root);
  return files.sort();
}

function newProviderUsage(timestampMs: number): MutableProviderUsage {
  return {
    entries: new Map(),
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages: 0,
    totalCost: 0,
    firstMs: timestampMs,
    lastMs: timestampMs,
    dailyUsage: {},
  };
}

function partyMemberAttribution(member: string): Omit<PiAttribution, "fraction"> {
  const normalised = member.trim().toLowerCase();
  if (normalised.startsWith("claude")) return { provider: "anthropic", nativeCoverageTool: "claude" };
  if (normalised.startsWith("codex")) return { provider: "openai", nativeCoverageTool: "codex" };
  if (normalised.startsWith("openai")) return { provider: "openai" };
  if (normalised.startsWith("grok") || normalised.startsWith("xai")) return { provider: "xai" };
  if (normalised.startsWith("kimi") || normalised.startsWith("moonshot")) return { provider: "kimi" };
  if (normalised.startsWith("zai") || normalised.startsWith("z-ai") || normalised.startsWith("z.ai")) return { provider: "zai" };
  if (normalised.startsWith("alibaba") || normalised.startsWith("qwen")) return { provider: "alibaba" };
  if (normalised.startsWith("anthropic")) return { provider: "anthropic" };
  return { provider: "unattributed" };
}

/** Pi's CLI providers are transport adapters, not upstream providers. Party
 * messages aggregate several provider calls into one record, so distribute
 * their aggregate counters across the named members while preserving the
 * recorded total. Native CLI-backed shares are marked for later de-duplication. */
function attributionsFor(rawProvider: string, model: string): PiAttribution[] {
  const normalisedProvider = rawProvider.trim().toLowerCase();
  if (normalisedProvider === "claude-cli") return [{ provider: "anthropic", nativeCoverageTool: "claude", fraction: 1 }];
  if (normalisedProvider === "codex-cli") return [{ provider: "openai", nativeCoverageTool: "codex", fraction: 1 }];
  if (normalisedProvider === "party-cli") {
    const members = model.startsWith("party:") ? model.slice("party:".length).split("+").filter(Boolean) : [];
    if (members.length === 0) return [{ provider: "unattributed", fraction: 1 }];
    return members.map((member) => ({ ...partyMemberAttribution(member), fraction: 1 / members.length }));
  }
  return [{ provider: canonicalUsageProvider(normalisedProvider), fraction: 1 }];
}

/**
 * Reads Pi's native session JSONL rather than asking tokscale to treat Pi as
 * one client. Every assistant message carries its actual provider/model and
 * token counters, so one Pi identity naturally becomes several provider
 * results. Stable message metadata is deduplicated across copied/forked
 * session branches; otherwise a fork that retains its ancestry would count
 * the same provider call once per descendant file.
 */
export async function fetchPiUsage(identity: Identity): Promise<PiProviderUsage[]> {
  const files = await jsonlFiles(join(identity.configDir, "sessions"));
  const providers = new Map<string, MutableProviderUsage>();
  const seenMessages = new Set<string>();

  for (const file of files) {
    let text: string;
    try {
      text = await Bun.file(file).text();
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;

      const message = entry.message as Record<string, unknown>;
      if (message.role !== "assistant") continue;
      const rawProvider = typeof message.provider === "string" ? message.provider : "unattributed";
      const model = typeof message.model === "string" && message.model ? message.model : "unknown";
      const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp)) continue;

      const id = typeof entry.id === "string" ? entry.id : "";
      const dedupeKey = `${id}\u0000${entry.timestamp}\u0000${rawProvider}\u0000${model}`;
      if (seenMessages.has(dedupeKey)) continue;
      seenMessages.add(dedupeKey);

      const usage = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : {};
      const input = finiteNumber(usage.input);
      const output = finiteNumber(usage.output);
      const cacheRead = finiteNumber(usage.cacheRead);
      const cacheWrite = finiteNumber(usage.cacheWrite);
      const reasoning = finiteNumber(usage.reasoning);
      const costObject = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
      const recordedCost = finiteNumber(costObject.total);
      for (const attribution of attributionsFor(rawProvider, model)) {
        const { provider, nativeCoverageTool, fraction } = attribution;
        const estimatedCost =
          recordedCost > 0
            ? recordedCost
            : provider === "zai" || provider === "alibaba"
              ? estimateDetailedModelTokenCost(provider, model, input, output, cacheRead, cacheWrite) ?? 0
              : 0;
        const aggregateKey = `${provider}\u0000${nativeCoverageTool ?? ""}`;
        let aggregate = providers.get(aggregateKey);
        if (!aggregate) {
          aggregate = newProviderUsage(timestamp);
          providers.set(aggregateKey, aggregate);
        }
        const attributedInput = input * fraction;
        const attributedOutput = output * fraction;
        const attributedCacheRead = cacheRead * fraction;
        const attributedCacheWrite = cacheWrite * fraction;
        const attributedReasoning = reasoning * fraction;
        const attributedCost = estimatedCost * fraction;
        aggregate.totalInput += attributedInput;
        aggregate.totalOutput += attributedOutput;
        aggregate.totalCacheRead += attributedCacheRead;
        aggregate.totalCacheWrite += attributedCacheWrite;
        aggregate.totalMessages += 1;
        aggregate.totalCost += attributedCost;
        aggregate.firstMs = Math.min(aggregate.firstMs, timestamp);
        aggregate.lastMs = Math.max(aggregate.lastMs, timestamp);
        const day = localDateKey(timestamp);
        aggregate.dailyUsage[day] = (aggregate.dailyUsage[day] ?? 0) + attributedInput + attributedOutput;

        const entryKey = `${provider}\u0000${model}`;
        const modelEntry = aggregate.entries.get(entryKey) ?? {
          client: "pi",
          provider,
          model,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          messageCount: 0,
          cost: 0,
        };
        modelEntry.input += attributedInput;
        modelEntry.output += attributedOutput;
        modelEntry.cacheRead += attributedCacheRead;
        modelEntry.cacheWrite += attributedCacheWrite;
        modelEntry.reasoning += attributedReasoning;
        modelEntry.messageCount += 1;
        modelEntry.cost += attributedCost;
        aggregate.entries.set(entryKey, modelEntry);
      }
    }
  }

  return [...providers.entries()].map(([key, usage]) => {
    const [provider, nativeCoverageTool] = key.split("\u0000") as [string, "claude" | "codex" | ""];
    return {
      provider,
      ...(nativeCoverageTool ? { nativeCoverageTool } : {}),
      report: {
        entries: [...usage.entries.values()],
        totalInput: usage.totalInput,
        totalOutput: usage.totalOutput,
        totalCacheRead: usage.totalCacheRead,
        totalCacheWrite: usage.totalCacheWrite,
        totalMessages: usage.totalMessages,
        totalCost: usage.totalCost,
      },
      dateSpan: { firstMs: usage.firstMs, lastMs: usage.lastMs },
      dailyUsage: usage.dailyUsage,
    };
  });
}
