import { bearer, BASE_STRIP_HEADERS, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - base https://api.anthropic.com: the host of CLAUDE_USAGE_URL in
 *   src/identities/claude-usage-api.ts (same OAuth account, same host as the
 *   CLI's /v1/messages); the platform.claude.com token host in oauth-refresh.ts
 *   is the refresh endpoint only.
 * - Authorization Bearer + `anthropic-beta: oauth-2025-04-20`:
 *   getUsage() in claude-usage-api.ts (CLAUDE_USAGE_BETA), the headers an OAuth
 *   grant needs. The client's own betas are merged in (comma-joined, deduplicated).
 * - credential: <configDir>/.credentials.json claudeAiOauth (credential-paths.ts).
 */
export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  upstreamBase: () => "https://api.anthropic.com",
  authHeaders: (cred, incoming) => {
    const betas = new Set<string>();
    for (const beta of (incoming.get("anthropic-beta") ?? "").split(",")) if (beta.trim()) betas.add(beta.trim());
    betas.add("oauth-2025-04-20");
    return { authorization: bearer(cred.accessToken), "anthropic-beta": [...betas].join(",") };
  },
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: true,
  usageStyle: () => "anthropic",
};
