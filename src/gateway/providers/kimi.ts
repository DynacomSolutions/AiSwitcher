import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - openai base https://api.kimi.com/coding/v1: the parent of USAGES_URL
 *   (https://api.kimi.com/coding/v1/usages) in src/cli/limits/kimi-limits.ts,
 *   called with `Authorization: Bearer <OAuth access token>`.
 * - credential: <configDir>/credentials/kimi-code.json (credential-paths.ts).
 * - anthropic base https://api.kimi.com/coding: header comment and
 *   DEFAULT_BASE_URL in the installed pi-provider-kimi-code package
 *   (~/.npm-global/lib/node_modules/pi-provider-kimi-code/index.ts lines 5,
 *   45-46: "Anthropic Messages compatible"; the openai variant adds /v1).
 */
export const KIMI_ANTHROPIC_BASE = "https://api.kimi.com/coding";

export const kimiAdapter: ProviderAdapter = {
  provider: "kimi",
  upstreamBase: (style) => (style === "anthropic" ? KIMI_ANTHROPIC_BASE : "https://api.kimi.com/coding/v1"),
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: (style) => (style === "anthropic" ? "anthropic" : "openai-chat"),
};
