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
  "glm-5.3-flash": { cost_per_1m_in: 0.075, cost_per_1m_out: 0.25, cost_per_1m_in_cached: 0.015, cost_per_1m_out_cached: 0 },
  "glm-5.3": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
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

/** OpenCode Go plan models — USD per million tokens from the Go plan's own
 * published price table (https://opencode.ai/docs/go, cross-checked against
 * the models.dev opencode-go catalog; checked 3 September 2026). These
 * value usage AGAINST the plan's dollar-denominated windows ($12/5h,
 * $30/week, $60/month) — the plan bills in dollars, so this estimate is how
 * much of those windows the tokens consumed. Cache writes are new input at
 * the ordinary input rate; absent write prices mean the model doesn't
 * bill writes separately. */
export const OPENCODE_GO_MODEL_PRICES: Record<string, ModelTokenPrice> = {
  "grok-4.6": { cost_per_1m_in: 2, cost_per_1m_out: 6, cost_per_1m_in_cached: 0.5, cost_per_1m_out_cached: 0 },
  "grok-4.5": { cost_per_1m_in: 2, cost_per_1m_out: 6, cost_per_1m_in_cached: 0.3, cost_per_1m_out_cached: 0 },
  "gpt-5.6-luna": { cost_per_1m_in: 0.2, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.02, cost_per_1m_out_cached: 0.25 },
  "glm-5.3-flash": { cost_per_1m_in: 0.15, cost_per_1m_out: 0.5, cost_per_1m_in_cached: 0.03, cost_per_1m_out_cached: 0 },
  "glm-5.3": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
  "glm-5.2": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
  "glm-5.1": { cost_per_1m_in: 1.4, cost_per_1m_out: 4.4, cost_per_1m_in_cached: 0.26, cost_per_1m_out_cached: 0 },
  "glm-5": { cost_per_1m_in: 1, cost_per_1m_out: 3.2, cost_per_1m_in_cached: 0.2, cost_per_1m_out_cached: 0 },
  "kimi-k3": { cost_per_1m_in: 3, cost_per_1m_out: 15, cost_per_1m_in_cached: 0.3, cost_per_1m_out_cached: 0 },
  "kimi-k2.7-code": { cost_per_1m_in: 0.95, cost_per_1m_out: 4, cost_per_1m_in_cached: 0.19, cost_per_1m_out_cached: 0 },
  "kimi-k2.6": { cost_per_1m_in: 0.95, cost_per_1m_out: 4, cost_per_1m_in_cached: 0.16, cost_per_1m_out_cached: 0 },
  "kimi-k2.5": { cost_per_1m_in: 0.6, cost_per_1m_out: 3, cost_per_1m_in_cached: 0.1, cost_per_1m_out_cached: 0 },
  "longcat-2.0": { cost_per_1m_in: 0.3, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.006, cost_per_1m_out_cached: 0 },
  "mimo-v2.5": { cost_per_1m_in: 0.14, cost_per_1m_out: 0.28, cost_per_1m_in_cached: 0.0028, cost_per_1m_out_cached: 0 },
  "mimo-v2.5-pro": { cost_per_1m_in: 0.435, cost_per_1m_out: 0.87, cost_per_1m_in_cached: 0.003625, cost_per_1m_out_cached: 0 },
  "mimo-v2-pro": { cost_per_1m_in: 1, cost_per_1m_out: 3, cost_per_1m_in_cached: 0.2, cost_per_1m_out_cached: 0 },
  "mimo-v2-omni": { cost_per_1m_in: 0.4, cost_per_1m_out: 2, cost_per_1m_in_cached: 0.08, cost_per_1m_out_cached: 0 },
  "minimax-m3": { cost_per_1m_in: 0.3, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.06, cost_per_1m_out_cached: 0 },
  "minimax-m2.7": { cost_per_1m_in: 0.3, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.06, cost_per_1m_out_cached: 0.375 },
  "minimax-m2.5": { cost_per_1m_in: 0.3, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.03, cost_per_1m_out_cached: 0.375 },
  "muse-spark-1.3-contributor": { cost_per_1m_in: 0.1, cost_per_1m_out: 0.2, cost_per_1m_in_cached: 0.002, cost_per_1m_out_cached: 0 },
  "muse-spark-1.2-contributor": { cost_per_1m_in: 0.1, cost_per_1m_out: 0.2, cost_per_1m_in_cached: 0.002, cost_per_1m_out_cached: 0 },
  "qwen3.8-max": { cost_per_1m_in: 2, cost_per_1m_out: 6, cost_per_1m_in_cached: 0.25, cost_per_1m_out_cached: 2.5 },
  "qwen3.8-flash": { cost_per_1m_in: 0.15, cost_per_1m_out: 0.47, cost_per_1m_in_cached: 0.016, cost_per_1m_out_cached: 0.2 },
  "qwen3.7-max": { cost_per_1m_in: 2.5, cost_per_1m_out: 7.5, cost_per_1m_in_cached: 0.5, cost_per_1m_out_cached: 3.125 },
  "qwen3.7-plus": { cost_per_1m_in: 0.4, cost_per_1m_out: 1.6, cost_per_1m_in_cached: 0.04, cost_per_1m_out_cached: 0.5 },
  "qwen3.6-plus": { cost_per_1m_in: 0.5, cost_per_1m_out: 3, cost_per_1m_in_cached: 0.05, cost_per_1m_out_cached: 0.625 },
  "qwen3.5-plus": { cost_per_1m_in: 0.2, cost_per_1m_out: 1.2, cost_per_1m_in_cached: 0.02, cost_per_1m_out_cached: 0.25 },
  "deepseek-v4-pro": { cost_per_1m_in: 0.66, cost_per_1m_out: 1.98, cost_per_1m_in_cached: 0.022, cost_per_1m_out_cached: 0 },
  "deepseek-v4-flash": { cost_per_1m_in: 0.22, cost_per_1m_out: 0.66, cost_per_1m_in_cached: 0.007, cost_per_1m_out_cached: 0 },
  "deepseek-v4-flash-vision-exp": { cost_per_1m_in: 0.22, cost_per_1m_out: 0.66, cost_per_1m_in_cached: 0.007, cost_per_1m_out_cached: 0 },
  "hy4-preview": { cost_per_1m_in: 0.834, cost_per_1m_out: 2.501, cost_per_1m_in_cached: 0.042, cost_per_1m_out_cached: 0 },
  "hy3": { cost_per_1m_in: 0.14, cost_per_1m_out: 0.58, cost_per_1m_in_cached: 0.035, cost_per_1m_out_cached: 0 },
};

/** Stealth codenames OpenCode serves its Go models under, mapped back to
 * their real models — taken verbatim from opencode's own stats
 * normalization (packages/stats/core/src/domain/model-normalization.ts,
 * MODEL_NAME_ALIASES, dev branch). "ox-alpha-free" is GLM-5.3-Flash under
 * an alias: pricing it at models.dev's placeholder $0 valued the user's
 * entire Go-plan history at $1.44 while the plan itself billed ~$30 for
 * the same window (observed + corrected 2026-09-03). */
const OPENCODE_GO_MODEL_ALIASES: Record<string, string> = {
  "ox-alpha": "glm-5.3-flash",
  "ox-alpha-free": "glm-5.3-flash",
  "x-preview-f": "glm-5.3-flash",
  "x-preview-f-free": "glm-5.3-flash",
};

/** Resolve an opencode-go model id to its priced entry: alias the stealth
 * codenames, then strip the "-free"/":free"/":global" suffixes opencode's
 * own normalizer strips (same rule, same source). */
function normaliseOpencodeGoModelId(model: string): string {
  const base = normaliseModelId(model).replace(/(-free|:free|:global)+$/, "");
  return OPENCODE_GO_MODEL_ALIASES[base] ?? base;
}

const PROVIDER_PRICES: Partial<Record<"zai" | "alibaba" | "opencode-go", Record<string, ModelTokenPrice>>> = {
  zai: ZAI_MODEL_PRICES,
  alibaba: ALI_MODEL_PRICES,
  "opencode-go": OPENCODE_GO_MODEL_PRICES,
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
  provider: "zai" | "alibaba" | "opencode-go",
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number | undefined {
  const prices = PROVIDER_PRICES[provider];
  const modelId = provider === "opencode-go" ? normaliseOpencodeGoModelId(model) : normaliseModelId(model);
  const price = prices?.[modelId];
  if (!price) return undefined;
  return (
    (inputTokens + cacheWriteTokens) * price.cost_per_1m_in +
    outputTokens * price.cost_per_1m_out +
    cacheReadTokens * price.cost_per_1m_in_cached
  ) / 1_000_000;
}
