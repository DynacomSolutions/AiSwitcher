import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - credential: <configDir>/auth.json tokens.access_token (codex-auth.ts);
 *   the account id comes from codexAccountOf (tokens.account_id or the JWT
 *   claim).
 * - `chatgpt-account-id` header: docs/agents/claude-swap-pools.md ("the
 *   `chatgpt-account-id` header comes from memory", Codex 0.145.0 source).
 * - base: NOT established from the repo. codex-limits.ts only names the host
 *   chatgpt.com. TODO(task-3): confirm the path against the installed codex
 *   binary before relying on it.
 */
export const CODEX_UPSTREAM_BASE_TODO = "https://chatgpt.com/backend-api/codex";

export const codexAdapter: ProviderAdapter = {
  provider: "codex",
  upstreamBase: () => CODEX_UPSTREAM_BASE_TODO,
  authHeaders: (cred) => ({
    authorization: bearer(cred.accessToken),
    ...(cred.accountId ? { "chatgpt-account-id": cred.accountId } : {}),
  }),
  stripRequestHeaders: [...BASE_STRIP_HEADERS, "chatgpt-account-id"],
  refreshable: true,
  usageStyle: () => "openai-responses",
};
