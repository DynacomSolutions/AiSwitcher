import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - base https://api.anthropic.com: the host of CLAUDE_USAGE_URL in
 *   src/identities/claude-usage-api.ts (same OAuth account, same host as the
 *   CLI's /v1/messages); the platform.claude.com token host in oauth-refresh.ts
 *   is the refresh endpoint only.
 * - Authorization Bearer + `anthropic-beta: oauth-2025-04-20`:
 *   getUsage() in claude-usage-api.ts (CLAUDE_USAGE_BETA), the headers an OAuth
 *   grant needs. The caller's own anthropic-version and other betas pass through.
 * - credential: <configDir>/.credentials.json claudeAiOauth (credential-paths.ts).
 */
export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  upstreamBase: () => "https://api.anthropic.com",
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken), "anthropic-beta": "oauth-2025-04-20" }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: () => "anthropic",
};
