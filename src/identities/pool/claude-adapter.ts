import { existsSync } from "node:fs";
import { swapCredentialFiles } from "../claude-swap.ts";
import { fetchMemberUsage, type FetchUsageDeps, type MemberUsage } from "../claude-usage-api.ts";
import { nativeStorePathFor } from "../oauth-reconcile.ts";
import { CLAUDE_CONFIG } from "../tool-configs.ts";
import type { PoolAdapter } from "./adapter.ts";

/** Claude: credentials live in `.credentials.json` plus `.claude.json`
 * `oauthAccount`; a running session re-reads them every turn. */
export const claudeAdapter: PoolAdapter<MemberUsage> = {
  tool: "claude",
  config: CLAUDE_CONFIG,
  liveSwap: true,
  hasCredentials: (configDir) => existsSync(nativeStorePathFor("claude", configDir)),
  swapCredentials: (input) => swapCredentialFiles(input),
  fetchUsage: (member, deps) => {
    const d = (deps ?? {}) as FetchUsageDeps & { registryPath?: string };
    return fetchMemberUsage(member, { ...d, claudeRegistryPath: d.claudeRegistryPath ?? d.registryPath });
  },
};
