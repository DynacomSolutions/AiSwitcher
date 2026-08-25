/**
 * Reference prices used for the local, token-count-based COST estimate in
 * `ais usage`. They intentionally value included subscription usage too:
 * `EXTRA COST` is the separate column for money actually charged beyond a
 * plan's allowance.
 *
 * Z.ai prices are USD per million tokens from
 * https://docs.z.ai/guides/overview/pricing (checked 8 August 2026).
 * Alibaba's Token Plan endpoint is in Singapore. Its public Model Studio
 * Singapore prices are CNY per million tokens, converted at 6.7682 CNY/USD
 * (checked 8 August 2026). These are estimates, not Token Plan credit
 * deductions: Alibaba documents that credits also depend on request mode,
 * caching, and tool calls.
 */
export interface ModelTokenPrice {
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  cost_per_1m_in_cached: number;
  cost_per_1m_out_cached: number;
}

const USD_PER_CNY = 1 / 6.7682;

function cnyPrice(input: number, output: number, cachedInput = input * 0.2): ModelTokenPrice {
  return {
    cost_per_1m_in: input * USD_PER_CNY,
    cost_per_1m_out: output * USD_PER_CNY,
    cost_per_1m_in_cached: cachedInput * USD_PER_CNY,
    cost_per_1m_out_cached: 0,
  };
}

export const ZAI_MODEL_PRICES: Record<string, ModelTokenPrice> = {
  "glm-5.2": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
  "glm-5.1": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
  "glm-5-turbo": { cost_per_1m_in: 1.2, cost_per_1m_out: 4, cost_per_1m_in_cached: 0.24, cost_per_1m_out_cached: 0 },
  "glm-5": { cost_per_1m_in: 1, cost_per_1m_out: 3.2, cost_per_1m_in_cached: 0.2, cost_per_1m_out_cached: 0 },
  "glm-4.7": { cost_per_1m_in: 0.6, cost_per_1m_out: 2.2, cost_per_1m_in_cached: 0.11, cost_per_1m_out_cached: 0 },
  "glm-4.7-flash": { cost_per_1m_in: 0.07, cost_per_1m_out: 0.4, cost_per_1m_in_cached: 0.01, cost_per_1m_out_cached: 0 },
  "glm-4.6": { cost_per_1m_in: 0.6, cost_per_1m_out: 2.2, cost_per_1m_in_cached: 0.11, cost_per_1m_out_cached: 0 },
  "glm-4.6v": { cost_per_1m_in: 0.3, cost_per_1m_out: 0.9, cost_per_1m_in_cached: 0.05, cost_per_1m_out_cached: 0 },
  "glm-4.5": { cost_per_1m_in: 0.6, cost_per_1m_out: 2.2, cost_per_1m_in_cached: 0.11, cost_per_1m_out_cached: 0 },
  "glm-4.5-air": { cost_per_1m_in: 0.2, cost_per_1m_out: 1.1, cost_per_1m_in_cached: 0.03, cost_per_1m_out_cached: 0 },
  "glm-4.5v": { cost_per_1m_in: 0.6, cost_per_1m_out: 1.8, cost_per_1m_in_cached: 0.11, cost_per_1m_out_cached: 0 },
};

export const ALI_MODEL_PRICES: Record<string, ModelTokenPrice> = {
  "qwen3.8-max": cnyPrice(14.988, 44.965),
  // The preview model shares the same public qwen3.8-max estimate.
  "qwen3.8-max-preview": cnyPrice(14.988, 44.965),
  "qwen3.7-max": cnyPrice(14.988, 44.965),
  "qwen3.7-plus": cnyPrice(2.998, 11.991),
  "qwen3.6-plus": cnyPrice(3.7471, 22.4826),
  "qwen3.6-flash": cnyPrice(1.87355, 11.2413),
  "glm-5.2": cnyPrice(10.492, 32.974, 10.492 * 0.25),
  "deepseek-v4-pro": cnyPrice(17.986, 35.972),
};

function normaliseModelId(model: string): string {
  const slash = model.indexOf("/");
  return (slash === -1 ? model : model.slice(slash + 1)).toLowerCase();
}

/** Returns an estimate for full, uncached input plus output tokens. Crush
 * persists session-level totals only, not the cached-token split, so applying
 * the discounted cached-input rate here would falsely imply that split. */
export function estimateModelTokenCost(provider: "zai" | "alibaba", model: string, inputTokens: number, outputTokens: number): number | undefined {
  const prices = provider === "zai" ? ZAI_MODEL_PRICES : ALI_MODEL_PRICES;
  const price = prices[normaliseModelId(model)];
  if (!price) return undefined;
  return (inputTokens * price.cost_per_1m_in + outputTokens * price.cost_per_1m_out) / 1_000_000;
}

/** Pi records uncached input, cache reads, and cache writes separately. Use
 * that real split when valuing plan-included Pi activity; cache writes are
 * new input at the ordinary input rate, while reads receive the provider's
 * cached-input rate. */
export function estimateDetailedModelTokenCost(
  provider: "zai" | "alibaba",
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number | undefined {
  const prices = provider === "zai" ? ZAI_MODEL_PRICES : ALI_MODEL_PRICES;
  const price = prices[normaliseModelId(model)];
  if (!price) return undefined;
  return (
    (inputTokens + cacheWriteTokens) * price.cost_per_1m_in +
    outputTokens * price.cost_per_1m_out +
    cacheReadTokens * price.cost_per_1m_in_cached
  ) / 1_000_000;
}
