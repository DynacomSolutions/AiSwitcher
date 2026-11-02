import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - credential: <configDir>/auth.json tokens.access_token (codex-auth.ts);
 *   the account id comes from codexAccountOf (tokens.account_id or the JWT
 *   claim).
 * - `chatgpt-account-id` header: docs/agents/claude-swap-pools.md ("the
 *   `chatgpt-account-id` header comes from memory", Codex 0.145.0 source).
 * - base https://chatgpt.com/backend-api/codex: string table of the installed
 *   codex-cli native binary (@openai/codex linux-x64 vendor bin), found with
 *   `strings`; the same table has the `ChatGPT-Account-ID` header name. Not yet
 *   proven live (Task 9).
 */
export const CODEX_UPSTREAM_BASE = "https://chatgpt.com/backend-api/codex";

export const codexAdapter: ProviderAdapter = {
  provider: "codex",
  upstreamBase: () => CODEX_UPSTREAM_BASE,
  authHeaders: (cred) => ({
    authorization: bearer(cred.accessToken),
    ...(cred.accountId ? { "chatgpt-account-id": cred.accountId } : {}),
  }),
  stripRequestHeaders: [...BASE_STRIP_HEADERS, "chatgpt-account-id"],
  refreshable: true,
  usageStyle: () => "openai-responses",
};
