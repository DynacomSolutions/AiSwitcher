import { loadAll, type LoadedFile } from "../cli/identities/resolve-tool.ts";
import type { ToolLimitResult } from "../cli/limits/types.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { loadGatewayLimits, type GatewayLimitsView } from "../identities/gateway-limits-reader.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

/**
 * The cluster gateway is the source of truth for the subscription limits of the identities it manages.
 * The console reads the gateway admin route `GET /limits` server-side (the admin token never reaches the
 * page) and merges its rows over the host scan, so a pod with stale credential files still shows live
 * utilisation windows and reset times. The reader itself lives in identities/gateway-limits-reader.ts so
 * the CLI limits scan can use it without importing the server.
 */
export {
  loadGatewayLimits,
  mapGatewayLimitRow,
  mapGatewayLimits,
  type GatewayLimitRow,
  type GatewayLimitsView,
  type LoadGatewayLimitsDeps,
} from "../identities/gateway-limits-reader.ts";

/**
 * Merges the gateway rows into a host limits payload. The gateway is authoritative for the identities it
 * manages: its row replaces the host row of the same tool and identity and keeping the host's registry entry.
 * Reset grants come from the gateway only: no host fallback. Host rows the gateway does not cover stay
 * as they are; gateway rows with no host row are added with their registry entry when one exists. An
 * unconfigured or failed gateway read leaves the payload unchanged. The tool and identity filters apply to
 * the gateway rows as well, so a filtered read never gains rows outside its filter.
 */
export async function mergeGatewayLimits(
  payload: unknown,
  view: GatewayLimitsView,
  filters: { tool?: string; identity?: string } = {},
  loadRegistries: () => Promise<LoadedFile[]> = () => loadAll(),
): Promise<unknown> {
  if (!view.configured || view.error) return payload;
  const results = (payload as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return payload;
  const keyOf = (tool: string, name: string): string => `${tool}\u0000${name}`;
  const gatewayByKey = new Map<string, ToolLimitResult>();
  for (const row of view.rows) {
    if (filters.tool !== undefined && row.toolName !== filters.tool) continue;
    if (filters.identity !== undefined && row.identity.name !== filters.identity) continue;
    gatewayByKey.set(keyOf(row.toolName, row.identity.name), row);
  }
  const hostRows = results as ToolLimitResult[];
  const used = new Set<string>();
  const merged = hostRows.map((host) => {
    const key = host?.toolName && host.identity?.name ? keyOf(host.toolName, host.identity.name) : undefined;
    const gateway = key ? gatewayByKey.get(key) : undefined;
    if (!key || !gateway) return host;
    used.add(key);
    return { ...gateway, identity: host.identity };
  });
  const added = [...gatewayByKey.entries()].filter(([key]) => !used.has(key)).map(([, row]) => row);
  if (added.length > 0) {
    // A managed identity the host scan did not return still deserves its real registry entry (label, aliases).
    const registries = await loadRegistries().catch(() => [] as LoadedFile[]);
    for (const row of added) {
      const file = registries.find((r) => r.cfg.toolName === row.toolName)?.file;
      const found = file ? findIdentityByNameOrAlias(file.identities, row.identity.name) : undefined;
      if (found) row.identity = found;
    }
    added.sort((a, b) => a.toolName.localeCompare(b.toolName) || a.identity.name.localeCompare(b.identity.name));
    merged.push(...added);
  }
  return { ...(payload as object), results: merged };
}
/**
 * Spends one Claude reset grant through the gateway admin API. The gateway spends it with the stored member
 * credential; the console never reads an account token. Answers with the admin's JSON, or throws an HttpError
 * with the gateway's short reason.
 */
export async function useClaudeResetViaGateway(
  identity: string,
  grantId: string,
  deps: { fetch?: typeof fetch; secretsPath?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const cfg = await gatewayAdminConfig({ ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}) });
  if (!cfg) throw new HttpError(503, "gateway admin is not configured on this console");
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${cfg.url}/limits/claude/${encodeURIComponent(identity)}/resets/${encodeURIComponent(grantId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch {
    throw new HttpError(502, "gateway admin unreachable");
  }
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) {
    const status = [400, 404, 409, 429, 503].includes(res.status) ? res.status : 502;
    throw new HttpError(status, typeof body?.error === "string" ? body.error.slice(0, 300) : `gateway admin answered ${res.status}`);
  }
  return body;
}
