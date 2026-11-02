import { bearer, BASE_STRIP_HEADERS, unsupportedStyle, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - base https://opencode.ai/zen/go/v1: the parent of OPENCODE_GO_USAGE_URL
 *   (https://opencode.ai/zen/go/v1/usage) in src/cli/limits/opencode-limits.ts,
 *   called with `Authorization: Bearer <key>`. AIS knows no Anthropic-style
 *   Go upstream, so that style throws.
 * - credential: the `opencode-go` key in <configDir>/data/opencode/auth.json
 *   (credential-paths.ts, opencode-limits.ts). The v2 opencode.db rows are not
 *   read by the gateway. A static key, so there is nothing to refresh.
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
