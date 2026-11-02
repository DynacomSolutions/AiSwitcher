import { BASE_STRIP_HEADERS, unsupportedStyle, type ProviderAdapter } from "./shared.ts";

/**
 * Sources:
 * - base: ALI_BASE_URL in src/identities/ali-auth.ts (Token plan,
 *   Anthropic-compatible; crush calls `<base_url>/v1/messages`). AIS knows no
 *   OpenAI-style upstream for it, so that style throws.
 * - credential: providers.alibaba.api_key in <configDir>/crush.json
 *   (readAliApiKey). A static API key, so there is nothing to refresh.
 * - header: AIS writes the provider as type "anthropic", which crush sends as
 *   the Anthropic SDK does (`x-api-key`). This is inferred from the type, not
 *   observed on the wire. TODO(task-3): confirm Alibaba accepts it live.
 */
export const aliAdapter: ProviderAdapter = {
  provider: "ali",
  upstreamBase: (style) => {
    if (style !== "anthropic") throw unsupportedStyle("ali", style);
    return "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
  },
  authHeaders: (cred) => ({ "x-api-key": cred.accessToken }),
  stripRequestHeaders: BASE_STRIP_HEADERS,
  refreshable: false,
  usageStyle: () => "anthropic",
};
