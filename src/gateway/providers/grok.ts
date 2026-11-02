import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - credential: <configDir>/auth.json, one entry per account with `key` (the
 *   access token), refresh_token and oidc_issuer (oauth-reconcile.ts
 *   readNativeGrok). Refresh is OIDC discovery (oauth-refresh.ts).
 * - base and usage style: NOT established from the repo (no grok inference
 *   host appears in AIS). TODO(task-3): confirm both from the grok CLI.
 */
export const GROK_UPSTREAM_BASE_TODO = "https://api.x.ai/v1";
export const GROK_USAGE_STYLE_TODO = "openai-chat" as const;

export const grokAdapter: ProviderAdapter = {
  provider: "grok",
  upstreamBase: () => GROK_UPSTREAM_BASE_TODO,
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: () => GROK_USAGE_STYLE_TODO,
};
