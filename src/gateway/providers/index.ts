import type { GatewayProvider } from "../types.ts";
import { aliAdapter } from "./ali.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import { kimiAdapter } from "./kimi.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { ProviderAdapter } from "./shared.ts";
import { zaiAdapter } from "./zai.ts";

export type { ProviderAdapter, ProviderCredential, UsageStyle } from "./shared.ts";

const ADAPTERS: Record<GatewayProvider, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
  zai: zaiAdapter,
  ali: aliAdapter,
  opencode: opencodeAdapter,
};

export function adapterFor(provider: GatewayProvider): ProviderAdapter {
  return ADAPTERS[provider];
}
