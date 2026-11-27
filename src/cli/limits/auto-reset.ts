import { AUTO_RESET_PATH, isAutoResetProvider, type AutoResetView } from "../../gateway/auto-reset-view.ts";
import type { ParsedArgs } from "../args.ts";
import { connect } from "../gateway/apps.ts";
import { toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { providerForTool } from "../usage/providers.ts";
import type { ToolLimitResult } from "./types.ts";

export async function loadLimitsAutoReset(flags: ParsedArgs["flags"]): Promise<AutoResetView | undefined> {
  const tool = toolConfigFromFlag(flags)?.toolName;
  if (tool !== undefined && !isAutoResetProvider(tool)) return undefined;
  try {
    const { admin } = await connect({
      fetch: ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })) as typeof fetch,
    });
    const { json } = await admin.call("GET", AUTO_RESET_PATH);
    if (Array.isArray(json.providers)) {
      const view = json as unknown as AutoResetView;
      return tool === undefined ? view : { providers: view.providers.filter((row) => row.provider === tool) };
    }
  } catch {
    // Limits still works on hosts without an admin token and with older gateways.
  }
  return undefined;
}

/**
 * Pool rows carry the setting. A member row carries only the last claim that its pool made on it.
 * A pool without a limits row of its own gets a placeholder row.
 */
export function applyLimitsAutoReset(results: ToolLimitResult[], view: AutoResetView | undefined, identityFilter?: string): ToolLimitResult[] {
  if (!view) return results;
  let applied = results;
  for (const row of view.providers) {
    if (!row.supported) continue;
    const provider = providerForTool(row.provider);
    const pools = new Map(row.pools.map((pool) => [pool.name, pool]));
    applied = applied.map((result) => {
      if (result.toolName !== row.provider || result.provider !== provider) return result;
      const pool = pools.get(result.identity.name);
      if (pool) {
        pools.delete(pool.name);
        return { ...result, autoReset: pool };
      }
      const autoResetClaim = row.memberClaims[result.identity.name];
      return autoResetClaim ? { ...result, autoResetClaim } : result;
    });
    for (const [name, autoReset] of pools) {
      if (identityFilter !== undefined && identityFilter !== name) continue;
      applied.push({
        toolName: row.provider, provider, identity: { name, label: name, configDir: "" },
        status: "unavailable", windows: [], autoReset,
      });
    }
  }
  return applied;
}
