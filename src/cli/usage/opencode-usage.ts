import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateDetailedModelTokenCost } from "../../identities/model-pricing.ts";
import type { Identity } from "../../identities/types.ts";
import { localDateKey } from "./local-day.ts";
import { canonicalUsageProvider } from "./providers.ts";
import type { DateSpan, TokscaleEntry, TokscaleReport } from "./tokscale.ts";

/**
 * Reads the DEFAULT OpenCode profile's own database — the usage that exists
 * OUTSIDE any AIS identity (the user running `opencode` directly, unscoped).
 * AIS's opencode wrapper redirects XDG_DATA_HOME into identity dirs, so
 * identity usage flows through tokscale; the default profile's
 * `<data>/opencode/opencode.db` is otherwise invisible, and that is exactly
 * where heavy real-world usage lives (observed live 2026-09-03: a 1.3GB db,
 * 4,595 messages / 57.7M input tokens on the OpenCode Go plan that no
 * identity ever saw).
 *
 * Rows carry the real upstream per message (`providerID`/`modelID` + a token
 * breakdown), so one profile naturally becomes several provider results —
 * the same provider-first shape pi-usage produces from Pi's JSONL. Tokscale
 * is bypassed for this source because it is scoped per identity via
 * XDG_DATA_HOME redirection and never sees the unredirected default
 * profile at all.
 *
 * The db records `cost: 0` for OpenCode Go traffic (the plan bills in
 * dollar-windows, not per token), so every row's cost is ESTIMATED from the
 * OpenCode Go price table — which is precisely "how much of the plan's
 * dollar window did these tokens consume".
 */

/** The synthetic identity default-profile usage falls back to ONLY when no
 * identity's credential matches the profile's key — the credential
 * identifies the account, and the account identifies the identity, so an
 * unmatched profile is the exceptional case, never the label for known
 * accounts (the user's default profile held dynacom's OpenCode Go key, and
 * logging that usage as "default" was wrong — fixed 2026-09-03). */
export const OPENCODE_DEFAULT_PROFILE_IDENTITY = {
  name: "default",
  label: "Default profile",
};

/** The default profile's own auth store: provider id -> API key. */
async function readProfileCredentials(profileAuthPath: string): Promise<Map<string, string>> {
  const credentials = new Map<string, string>();
  try {
    const parsed = JSON.parse(await Bun.file(profileAuthPath).text()) as Record<string, { key?: unknown }>;
    for (const [provider, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length > 0) {
        credentials.set(canonicalUsageProvider(provider), entry.key);
      }
    }
  } catch {
    // unreadable/absent -> no credentials to match
  }
  return credentials;
}

/** Every AIS identity that holds opencode-style API credentials, mapped per
 * canonical provider -> key: the opencode registry (data/opencode/auth.json)
 * and the pi registry (auth.json api_key entries — OAuth entries hold no
 * comparable key). */
async function identityCredentialIndex(): Promise<Array<{ identity: Identity; credentials: Map<string, string> }>> {
  const { OPENCODE_CONFIG, PI_CONFIG } = await import("../../identities/tool-configs.ts");
  const { loadIdentitiesFile } = await import("../../identities/store.ts");
  const index: Array<{ identity: Identity; credentials: Map<string, string> }> = [];

  const registries = [
    { config: OPENCODE_CONFIG, read: async (configDir: string) => readProfileCredentials(join(configDir, "data", "opencode", "auth.json")) },
    {
      config: PI_CONFIG,
      read: async (configDir: string) => {
        const credentials = new Map<string, string>();
        try {
          const parsed = JSON.parse(await Bun.file(join(configDir, "auth.json")).text()) as Record<string, { type?: unknown; key?: unknown }>;
          for (const [provider, entry] of Object.entries(parsed)) {
            if (entry && typeof entry.key === "string" && entry.key.length > 0) {
              credentials.set(canonicalUsageProvider(provider), entry.key);
            }
          }
        } catch {
          // skip unreadable
        }
        return credentials;
      },
    },
  ];

  for (const { config, read } of registries) {
    try {
      const file = await loadIdentitiesFile(config.identitiesJsonPath);
      for (const identity of file.identities) {
        index.push({ identity, credentials: await read(identity.configDir) });
      }
    } catch {
      // registry absent -> no candidates from it
    }
  }
  return index;
}

/** Maps each of the default profile's providers to the AIS identity that
 * holds the SAME credential — the key identifies the account, and the
 * account identifies the identity, so profile usage logs under the identity
 * whose key it ran on. Providers with no matching identity are absent from
 * the map (caller falls back to the synthetic default identity). */
export async function resolveOpencodeProfileIdentities(): Promise<Map<string, Identity>> {
  const profileCredentials = await readProfileCredentials(
    defaultOpencodeProfileDbPath().replace(join("opencode", "opencode.db"), join("opencode", "auth.json")),
  );
  const resolved = new Map<string, Identity>();
  if (profileCredentials.size === 0) return resolved;

  for (const { identity, credentials } of await identityCredentialIndex()) {
    for (const [provider, key] of profileCredentials) {
      if (resolved.has(provider)) continue;
      if (credentials.get(provider) === key) resolved.set(provider, identity);
    }
  }
  return resolved;
}

export interface OpencodeProfileUsage {
  provider: string;
  report: TokscaleReport;
  dateSpan: DateSpan;
  dailyUsage: Record<string, number>;
}

interface MutableProfileUsage {
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

/** The default profile's own db — ALWAYS the unredirected
 * `~/.local/share/opencode/opencode.db`. The ambient XDG_DATA_HOME must be
 * deliberately IGNORED here: inside an AIS-launched opencode session it
 * points at that identity's data dir (already counted, correctly
 * attributed, via tokscale), so honouring it would double-count that
 * identity's rows and mislabel them as "default" (observed live
 * 2026-09-03). The default profile is by definition where opencode lands
 * when nothing redirects it. */
export function defaultOpencodeProfileDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

interface OpencodeMessageData {
  role?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  time?: { created?: number };
}

/** providerID "opencode" is opencode's first-party gateway id — literally
 * the tool's own name, which can never render as an honest provider label.
 * Negligible in real data (2 messages live); skipped rather than guessing
 * which plan it belongs to. */
const UNNAMABLE_PROVIDERS = new Set(["opencode"]);

function newMutable(timestampMs: number): MutableProfileUsage {
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

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type OpencodeProfileOutcome =
  | { kind: "usage"; providers: OpencodeProfileUsage[] }
  | { kind: "absent" }
  | { kind: "error"; message: string };

/** Reads one opencode.db and aggregates every assistant message into
 * per-provider usage. `dbPath` is injectable for tests. The row scan
 * YIELDS periodically — bun:sqlite is synchronous, and an unyielding scan
 * of a multi-GB db blocks the event loop and freezes the live render
 * (observed 2026-09-03). */
export async function readOpencodeProfileUsage(dbPath: string): Promise<OpencodeProfileOutcome> {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { kind: "absent" };
  }

  try {
    const providers = new Map<string, MutableProfileUsage>();
    let processed = 0;

    for (const { data } of db.query("SELECT data FROM message").iterate() as IterableIterator<{ data: string }>) {
      let message: OpencodeMessageData;
      try {
        message = JSON.parse(data) as OpencodeMessageData;
      } catch {
        continue;
      }
      if (message.role !== "assistant") continue;
      const rawProvider = typeof message.providerID === "string" ? message.providerID : "";
      if (!rawProvider || UNNAMABLE_PROVIDERS.has(rawProvider)) continue;
      const model = typeof message.modelID === "string" && message.modelID ? message.modelID : "unknown";
      const created = message.time?.created;
      if (typeof created !== "number" || !Number.isFinite(created)) continue;

      const provider = canonicalUsageProvider(rawProvider);
      const tokens = message.tokens ?? {};
      const input = finiteNumber(tokens.input);
      const output = finiteNumber(tokens.output);
      const cacheRead = finiteNumber(tokens.cache?.read);
      const cacheWrite = finiteNumber(tokens.cache?.write);
      const reasoning = finiteNumber(tokens.reasoning);
      const recordedCost = finiteNumber(message.cost);
      const estimatedCost =
        recordedCost > 0
          ? recordedCost
          : provider === "zai" || provider === "alibaba" || provider === "opencode-go"
            ? estimateDetailedModelTokenCost(provider, model, input, output, cacheRead, cacheWrite) ?? 0
            : 0;

      let aggregate = providers.get(provider);
      if (!aggregate) {
        aggregate = newMutable(created);
        providers.set(provider, aggregate);
      }
      aggregate.totalInput += input;
      aggregate.totalOutput += output;
      aggregate.totalCacheRead += cacheRead;
      aggregate.totalCacheWrite += cacheWrite;
      aggregate.totalMessages += 1;
      aggregate.totalCost += estimatedCost;
      aggregate.firstMs = Math.min(aggregate.firstMs, created);
      aggregate.lastMs = Math.max(aggregate.lastMs, created);
      const day = localDateKey(created);
      aggregate.dailyUsage[day] = (aggregate.dailyUsage[day] ?? 0) + input + output;

      const entryKey = `${provider}\u0000${model}`;
      const modelEntry = aggregate.entries.get(entryKey) ?? {
        client: "opencode",
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
      modelEntry.input += input;
      modelEntry.output += output;
      modelEntry.cacheRead += cacheRead;
      modelEntry.cacheWrite += cacheWrite;
      modelEntry.reasoning += reasoning;
      modelEntry.messageCount += 1;
      modelEntry.cost += estimatedCost;
      aggregate.entries.set(entryKey, modelEntry);

      // Yield the event loop every few hundred rows so spinner ticks keep
      // firing while the scan runs.
      if (++processed % 500 === 0) await Bun.sleep(0);
    }

    return {
      kind: "usage",
      providers: [...providers.entries()].map(([provider, usage]) => ({
        provider,
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
      })),
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

/** Per-provider usage for one AIS opencode IDENTITY — same reader, but the
 * identity's own redirected data root (`<configDir>/data/opencode/`). This
 * is the preferred attribution path for identity usage: the db records the
 * exact upstream per message, while the tokscale path collapses
 * multi-plan models into comma-joined pseudo-providers
 * ("opencode_go, zai_coding_plan") that fragment the report. */
export async function fetchOpencodeIdentityUsage(identity: Identity): Promise<OpencodeProfileUsage[]> {
  const dbPath = join(identity.configDir, "data", "opencode", "opencode.db");
  const outcome = await readOpencodeProfileUsage(dbPath);
  return outcome.kind === "usage" ? outcome.providers : [];
}
