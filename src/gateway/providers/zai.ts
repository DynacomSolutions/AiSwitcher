import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - openai base https://api.z.ai/api/coding/paas/v4: ZAI_BASE_URL in
 *   src/identities/zai-auth.ts (the base_url AIS writes into crush.json).
 * - anthropic base https://api.z.ai/api/anthropic: docs/agents/history.md
 *   (Z.ai's chelper tool sets ANTHROPIC_BASE_URL to it for Claude Code).
 * - Authorization Bearer: zai-limits.ts, and chelper's ANTHROPIC_AUTH_TOKEN
 *   for the anthropic style.
 * - credential: providers.zai.api_key in <configDir>/crush.json (readZaiApiKey).
 *   A static API key, so there is nothing to refresh.
 */
export const zaiAdapter: ProviderAdapter = {
  provider: "zai",
  upstreamBase: (style) => (style === "anthropic" ? "https://api.z.ai/api/anthropic" : "https://api.z.ai/api/coding/paas/v4"),
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: false,
  usageStyle: (style) => (style === "anthropic" ? "anthropic" : "openai-chat"),
};
