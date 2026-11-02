import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CredentialCache } from "../../src/gateway/credentials.ts";
import { adapterFor } from "../../src/gateway/providers/index.ts";
import type { GatewayProvider } from "../../src/gateway/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "gateway");
const cache = new CredentialCache({ resolveConfigDir: async (provider) => join(FIXTURES, provider) });

describe("provider adapters", () => {
  test("each adapter builds headers from its fixture credential", async () => {
    const expected: Record<GatewayProvider, Record<string, string>> = {
      claude: { authorization: "Bearer SYNTHETIC_FIXTURE-claude-access-0001", "anthropic-beta": "oauth-2025-04-20" },
      codex: { authorization: "Bearer SYNTHETIC_FIXTURE-codex-access-0001", "chatgpt-account-id": "SYNTHETIC_FIXTURE-account-0001" },
      kimi: { authorization: "Bearer SYNTHETIC_FIXTURE-kimi-access-0001" },
      grok: { authorization: "Bearer SYNTHETIC_FIXTURE-grok-access-0001" },
      zai: { authorization: "Bearer SYNTHETIC_FIXTURE-zai-key-0001" },
      ali: { "x-api-key": "SYNTHETIC_FIXTURE-ali-key-0001" },
      opencode: { authorization: "Bearer SYNTHETIC_FIXTURE-opencode-key-0001" },
    };
    for (const provider of Object.keys(expected) as GatewayProvider[]) {
      const cred = await cache.get(provider, "id1");
      expect(adapterFor(provider).authHeaders(cred)).toEqual(expected[provider]);
    }
  });

  test("gateway token headers are stripped", () => {
    for (const provider of ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"] as const) {
      const strip = adapterFor(provider).stripRequestHeaders;
      expect(strip).toContain("authorization");
      expect(strip).toContain("x-api-key");
      expect(strip.every((h) => h === h.toLowerCase())).toBe(true);
    }
    expect(adapterFor("codex").stripRequestHeaders).toContain("chatgpt-account-id");
  });

  test("upstream bases come from the AIS tool configs", () => {
    expect(adapterFor("claude").upstreamBase("anthropic")).toBe("https://api.anthropic.com");
    expect(adapterFor("zai").upstreamBase("openai")).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(adapterFor("zai").upstreamBase("anthropic")).toBe("https://api.z.ai/api/anthropic");
    expect(adapterFor("ali").upstreamBase("anthropic")).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
    expect(adapterFor("kimi").upstreamBase("openai")).toBe("https://api.kimi.com/coding/v1");
    expect(adapterFor("opencode").upstreamBase("openai")).toBe("https://opencode.ai/zen/go/v1");
  });

  test("unsupported provider and style pairs throw a clear error", () => {
    expect(() => adapterFor("ali").upstreamBase("openai")).toThrow(/ali.*openai/);
    expect(() => adapterFor("opencode").upstreamBase("anthropic")).toThrow(/opencode.*anthropic/);
  });

  test("refreshable flag and usage style", () => {
    expect(["claude", "codex", "kimi", "grok"].map((p) => adapterFor(p as GatewayProvider).refreshable)).toEqual([true, true, true, true]);
    expect(["zai", "ali", "opencode"].map((p) => adapterFor(p as GatewayProvider).refreshable)).toEqual([false, false, false]);
    expect(adapterFor("claude").usageStyle("anthropic")).toBe("anthropic");
    expect(adapterFor("codex").usageStyle("openai")).toBe("openai-responses");
    expect(adapterFor("zai").usageStyle("anthropic")).toBe("anthropic");
    expect(adapterFor("zai").usageStyle("openai")).toBe("openai-chat");
  });
});
