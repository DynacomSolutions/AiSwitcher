import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - openai base https://api.kimi.com/coding/v1: the parent of USAGES_URL
 *   (https://api.kimi.com/coding/v1/usages) in src/cli/limits/kimi-limits.ts,
 *   called with `Authorization: Bearer <OAuth access token>`.
 * - credential: <configDir>/credentials/kimi-code.json (credential-paths.ts).
 * - anthropic base: NOT established from the repo. TODO(task-3): confirm
 *   Kimi Code's Anthropic-compatible path.
 */
export const KIMI_ANTHROPIC_BASE_TODO = "https://api.kimi.com/coding";

export const kimiAdapter: ProviderAdapter = {
  provider: "kimi",
  upstreamBase: (style) => (style === "anthropic" ? KIMI_ANTHROPIC_BASE_TODO : "https://api.kimi.com/coding/v1"),
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: (style) => (style === "anthropic" ? "anthropic" : "openai-chat"),
};
