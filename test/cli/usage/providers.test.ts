import { describe, expect, test } from "bun:test";
import { TOOL_CONFIGS } from "../../../src/cli/identities/resolve-tool.ts";
import { canonicalUsageProvider, providerForTool, usageProviderLabel } from "../../../src/cli/usage/providers.ts";

describe("canonicalUsageProvider", () => {
  test("collapses client-specific aliases into the upstream provider", () => {
    expect(canonicalUsageProvider("claude-cli")).toBe("anthropic");
    expect(canonicalUsageProvider("openai-codex")).toBe("openai");
    expect(canonicalUsageProvider("codex-cli")).toBe("openai");
    expect(canonicalUsageProvider("grok")).toBe("xai");
    expect(canonicalUsageProvider("moonshot")).toBe("kimi");
    expect(canonicalUsageProvider("kimi-coding")).toBe("kimi");
    expect(canonicalUsageProvider("alibaba-plan")).toBe("alibaba");
    expect(canonicalUsageProvider("party-cli")).toBe("unattributed");
  });

  test("tokscale's opencode client provider names map to the same upstreams other clients report", () => {
    expect(canonicalUsageProvider("zai_coding_plan")).toBe("zai");
    expect(canonicalUsageProvider("alibaba_token_plan")).toBe("alibaba");
  });

  test("normalises case and surrounding whitespace before lookup", () => {
    expect(canonicalUsageProvider("  ZAI_CODING_PLAN ")).toBe("zai");
    expect(canonicalUsageProvider("Anthropic")).toBe("anthropic");
  });

  test("empty/whitespace-only input is unattributed, never an upstream name", () => {
    expect(canonicalUsageProvider("")).toBe("unattributed");
    expect(canonicalUsageProvider("   ")).toBe("unattributed");
  });

  test("unknown provider names pass through (lowercased), so a new upstream still renders", () => {
    expect(canonicalUsageProvider("SomeNewCloud")).toBe("somenewcloud");
  });
});

describe("providerForTool", () => {
  // THE regression test for the 2026-09-03 `ais usage` crash: "opencode"
  // was added to the toolName union (and its registry to TOOL_CONFIGS)
  // without a matching providerForTool case, so every unscoped `ais usage`
  // run hit canonicalUsageProvider(undefined) -> "provider.trim" TypeError.
  // A new ToolConfig must fail HERE, loudly, not in a user's terminal.
  test("every registered tool maps to a defined provider string", () => {
    for (const cfg of Object.values(TOOL_CONFIGS)) {
      expect(providerForTool(cfg.toolName)).toBeString();
      expect(providerForTool(cfg.toolName)).not.toBe("");
    }
  });

  test("each tool's provider is one the report knows how to label", () => {
    for (const cfg of Object.values(TOOL_CONFIGS)) {
      expect(usageProviderLabel(providerForTool(cfg.toolName))).not.toMatch(/undefined/i);
    }
  });

  test("single-provider wrappers map to their one upstream", () => {
    expect(providerForTool("claude")).toBe("anthropic");
    expect(providerForTool("codex")).toBe("openai");
    expect(providerForTool("grok")).toBe("xai");
    expect(providerForTool("kimi")).toBe("kimi");
    expect(providerForTool("zai")).toBe("zai");
    expect(providerForTool("ali")).toBe("alibaba");
  });

  test("multi-provider wrappers (pi, opencode) get a placeholder fallback, not a wrong upstream", () => {
    expect(providerForTool("pi")).toBe("detecting");
    expect(providerForTool("opencode")).toBe("opencode");
  });
});

describe("usageProviderLabel", () => {
  test("known canonical providers get their display label", () => {
    expect(usageProviderLabel("anthropic")).toBe("Anthropic");
    expect(usageProviderLabel("zai")).toBe("Z.ai");
    expect(usageProviderLabel("opencode")).toBe("OpenCode");
    expect(usageProviderLabel("opencode-go")).toBe("OpenCode Go");
  });

  test("unknown providers title-case on - and _ separators instead of crashing", () => {
    expect(usageProviderLabel("zai_coding_plan")).toBe("Z.ai");
    expect(usageProviderLabel("some-new_cloud")).toBe("Some New Cloud");
  });
});
