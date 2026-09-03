import type { ToolConfig } from "../../identities/types.ts";

const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  "claude-cli": "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  "codex-cli": "openai",
  xai: "xai",
  grok: "xai",
  kimi: "kimi",
  "kimi-coding": "kimi",
  "local-kimi": "kimi",
  moonshot: "kimi",
  zai: "zai",
  // OpenCode names its plan credentials with underscores in tokscale output
  // but HYPHENS in its own auth.json ("zai-coding-plan" et al, confirmed on
  // disk) — both spellings must collapse onto the same upstream.
  "zai_coding_plan": "zai",
  "zai-coding-plan": "zai",
  alibaba: "alibaba",
  "alibaba-plan": "alibaba",
  "alibaba_token_plan": "alibaba",
  "alibaba-token-plan": "alibaba",
  "opencode-go": "opencode-go",
  "party-cli": "unattributed",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  kimi: "Kimi",
  zai: "Z.ai",
  alibaba: "Alibaba",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode",
  unattributed: "Unattributed",
  detecting: "Detecting providers",
};

/** Collapses provider aliases emitted by different clients into the actual
 * upstream provider. This is intentionally client-agnostic: OpenAI usage is
 * OpenAI whether it came from Codex directly or Pi's openai-codex adapter. */
export function canonicalUsageProvider(provider: string): string {
  const normalised = provider.trim().toLowerCase();
  if (!normalised) return "unattributed";
  return PROVIDER_ALIASES[normalised] ?? normalised;
}

/** Fallback for a wrapper whose local usage source failed before it could
 * expose the provider recorded in its own session entries. */
export function providerForTool(toolName: ToolConfig["toolName"]): string {
  switch (toolName) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "grok":
      return "xai";
    case "kimi":
      return "kimi";
    case "zai":
      return "zai";
    case "ali":
      return "alibaba";
    case "opencode":
      // Multi-provider client (like pi): its sessions record the real
      // upstream per message, so there is no single fallback — this is
      // only the label used before/without any local session data.
      return "opencode";
    case "pi":
      return "detecting";
  }
}

export function usageProviderLabel(provider: string): string {
  const canonical = canonicalUsageProvider(provider);
  const known = PROVIDER_LABELS[canonical];
  if (known) return known;
  return canonical
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
