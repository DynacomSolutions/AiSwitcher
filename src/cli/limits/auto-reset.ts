import { CODEX_AUTO_RESET_PATH, type AutoResetView } from "../../gateway/auto-reset-view.ts";
import type { ParsedArgs } from "../args.ts";
import { connect } from "../gateway/apps.ts";
import { toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { providerForTool } from "../usage/providers.ts";
import type { ToolLimitResult } from "./types.ts";

export async function loadLimitsAutoReset(flags: ParsedArgs["flags"]): Promise<AutoResetView | undefined> {
  const tool = toolConfigFromFlag(flags)?.toolName;
  if (tool !== undefined && tool !== "codex") return undefined;
  try {
    const { admin } = await connect({
      fetch: ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })) as typeof fetch,
    });
    const { json } = await admin.call("GET", CODEX_AUTO_RESET_PATH);
    if (Array.isArray(json.pools)) return json as unknown as AutoResetView;
  } catch {
    // Limits still works on hosts without an admin token and with older gateways.
  }
  return undefined;
}

export function applyLimitsAutoReset(results: ToolLimitResult[], view: AutoResetView | undefined, identityFilter?: string): ToolLimitResult[] {
  if (!view) return results;
  const provider = providerForTool("codex");
  const settings = new Map(view.pools.map((setting) => [setting.name, setting]));
  const applied = results.map((row) => {
    if (row.provider !== provider || !row.identity.swapPool) return row;
    const autoReset = settings.get(row.identity.name);
    if (!autoReset) return row;
    settings.delete(row.identity.name);
    return { ...row, autoReset };
  });
  for (const [name, autoReset] of settings) {
    if (identityFilter !== undefined && identityFilter !== name) continue;
    applied.push({
      toolName: "codex", provider, identity: { name, label: name, configDir: "" },
      status: "unavailable", windows: [], autoReset,
    });
  }
  return applied;
}
