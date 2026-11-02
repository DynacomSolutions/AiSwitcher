import { bearer, BASE_STRIP_HEADERS, unsupportedStyle, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - base https://opencode.ai/zen/go/v1: the parent of OPENCODE_GO_USAGE_URL
 *   (https://opencode.ai/zen/go/v1/usage) in src/cli/limits/opencode-limits.ts,
 *   called with `Authorization: Bearer <key>`. AIS knows no Anthropic-style
 *   Go upstream, so that style throws.
 * - credential: the `opencode-go` key. v2 opencode writes only
 *   <configDir>/data/opencode/opencode.db (credential table); auth.json can be
 *   stale (opencode-limits.ts header). The cache prefers the db and falls back
 *   to auth.json. A static key, so there is nothing to refresh.
 */
export const opencodeAdapter: ProviderAdapter = {
  provider: "opencode",
  upstreamBase: (style) => {
    if (style !== "openai") throw unsupportedStyle("opencode", style);
    return "https://opencode.ai/zen/go/v1";
  },
  authHeaders: (cred) => ({ authorization: bearer(cred.accessToken) }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: false,
  usageStyle: () => "openai-chat",
};
