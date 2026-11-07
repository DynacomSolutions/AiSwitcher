import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aisHome } from "../shared/ais-home.ts";
import { type ListModelPrice, normaliseChatModelId, setFetchedChatPriceLookup } from "./model-pricing.ts";

/**
 * Chat model prices fetched from LiteLLM's public price list, so new models
 * are priced with no code edit. Lookups read memory only and never touch the
 * network; a refresh runs in the background at most once a day and a failed
 * refresh keeps the last good cache. CHAT_MODEL_PRICES stays the fallback.
 */
export const MODEL_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a failed refresh, wait this long before trying again. */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface CacheFile {
  fetchedAt: number;
  prices: Record<string, [number, number, number, number]>;
}

/** Reduces the LiteLLM document to per-million prices keyed by normalised id.
 * Only first-party ids (no provider path, or `anthropic/` and `openai/`) are
 * used; the first such entry for a normalised id wins. */
export function parseLitellmPrices(doc: unknown): CacheFile["prices"] {
  const out: CacheFile["prices"] = {};
  if (!doc || typeof doc !== "object") return out;
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const slash = key.indexOf("/");
    if (slash !== -1 && !/^(anthropic|openai)\//.test(key)) continue;
    const e = raw as Record<string, unknown>;
    if (e.mode !== undefined && e.mode !== "chat" && e.mode !== "responses" && e.mode !== "completion") continue;
    const inp = e.input_cost_per_token;
    const outp = e.output_cost_per_token;
    if (typeof inp !== "number" || typeof outp !== "number" || !(inp >= 0) || !(outp >= 0)) continue;
    const id = normaliseChatModelId(key);
    if (id in out) continue;
    const cr = typeof e.cache_read_input_token_cost === "number" ? e.cache_read_input_token_cost : inp;
    const cw = typeof e.cache_creation_input_token_cost === "number" ? e.cache_creation_input_token_cost : inp;
    out[id] = [inp * 1e6, outp * 1e6, cr * 1e6, cw * 1e6].map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number, number];
  }
  return out;
}

export interface PriceSourceDeps {
  fetch?: typeof fetch;
  cachePath?: string;
  url?: string;
  now?: () => number;
  /** Receives JSON log lines for refresh failures. */
  log?: (line: string) => void;
}

export class ModelPriceSource {
  private prices: CacheFile["prices"] = {};
  private fetchedAt = 0;
  private lastAttempt = 0;
  private inflight: Promise<void> | undefined;
  private loaded = false;
  private readonly doFetch: typeof fetch;
  private readonly cachePath: string;
  private readonly url: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(deps: PriceSourceDeps = {}) {
    this.doFetch = deps.fetch ?? fetch;
    this.cachePath = deps.cachePath ?? process.env.AIS_MODEL_PRICES_CACHE ?? join(aisHome(), "cache", "model-prices.json");
    this.url = deps.url ?? process.env.AIS_MODEL_PRICES_URL ?? MODEL_PRICES_URL;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.warn(l));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const c = JSON.parse(readFileSync(this.cachePath, "utf8")) as Partial<CacheFile>;
      if (c && typeof c.fetchedAt === "number" && c.prices && typeof c.prices === "object") {
        this.prices = c.prices;
        this.fetchedAt = c.fetchedAt;
      }
    } catch {
      // No or unreadable cache: start empty; the hand table covers lookups.
    }
  }

  /** Synchronous, network-free lookup by normalised id. Schedules a background refresh when the list is stale. */
  lookup(normalisedId: string): ListModelPrice | undefined {
    this.load();
    this.refreshIfStale();
    const p = this.prices[normalisedId];
    return p ? { usdPer1mInput: p[0], usdPer1mOutput: p[1], usdPer1mCacheRead: p[2], usdPer1mCacheWrite: p[3] } : undefined;
  }

  /** Starts a background refresh when the list is older than a day (and no recent attempt failed). Never throws. */
  refreshIfStale(): void {
    this.load();
    const t = this.now();
    if (this.inflight || t - this.fetchedAt < REFRESH_INTERVAL_MS || t - this.lastAttempt < RETRY_INTERVAL_MS) return;
    this.lastAttempt = t;
    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
  }

  /** Resolves when any running refresh has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.doFetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const prices = parseLitellmPrices(await res.json());
      if (Object.keys(prices).length === 0) throw new Error("empty price list");
      this.prices = prices;
      this.fetchedAt = this.now();
      this.persist();
    } catch (e) {
      this.log(JSON.stringify({ event: "model_prices_refresh_failed", reason: e instanceof Error ? e.message : "error" }));
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.${process.pid}.tmp`;
      const body: CacheFile = { fetchedAt: this.fetchedAt, prices: this.prices };
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, this.cachePath);
    } catch {
      // Read-only home (pod): the in-memory list still serves this process.
    }
  }
}

/** Process-wide source. Off under `bun test` and when AIS_MODEL_PRICES=off. */
export const modelPriceSource: ModelPriceSource | undefined =
  process.env.NODE_ENV === "test" || process.env.AIS_MODEL_PRICES === "off" ? undefined : new ModelPriceSource();

if (modelPriceSource) {
  setFetchedChatPriceLookup((id) => modelPriceSource.lookup(id));
  modelPriceSource.refreshIfStale();
}
