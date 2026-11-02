import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - credential: <configDir>/auth.json, one entry per account with `key` (the
 *   access token), refresh_token and oidc_issuer (oauth-reconcile.ts
 *   readNativeGrok). Refresh is OIDC discovery (oauth-refresh.ts).
 * - base: the installed grok binary (~/.grok/downloads/grok-1.0.70-linux-x86_64,
 *   `strings`) holds both https://api.x.ai/v1 (API-key route) and
 *   https://cli-chat-proxy.grok.com/v1 (with .../chat/completions, env override
 *   GROK_CLI_CHAT_PROXY_BASE_URL). The OAuth session token is the CLI-chat
 *   route, so the proxy is used. Which host accepts a session token is read
 *   from string names, not observed on the wire: TODO(task-3) Task 9 proves it.
 * - style: the grok docs bundled in the binary state `api_backend` defaults to
 *   "chat_completions" (/v1/chat/completions).
 */
export const GROK_UPSTREAM_BASE_UNPROVEN = "https://cli-chat-proxy.grok.com/v1";
export const GROK_USAGE_STYLE = "openai-chat" as const;

export const grokAdapter: ProviderAdapter = {
  provider: "grok",
  upstreamBase: () => GROK_UPSTREAM_BASE_UNPROVEN,
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: () => GROK_USAGE_STYLE,
};
