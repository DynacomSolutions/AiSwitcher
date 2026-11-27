import {
  AUTO_RESET_PATH, autoResetProviderPath, isAutoResetProvider, type AutoResetLastClaim, type AutoResetProviderView, type AutoResetStatus, type AutoResetView,
} from "../../gateway/auto-reset-view.ts";
import { DEFAULT_LIMIT_TIME_ZONES, formatInZone } from "../../shared/limit-times.ts";
import { CliUsageError } from "../errors.ts";
import { connect, type GatewayCliDeps } from "./apps.ts";

const USAGE = "Usage: ais gateway auto-reset list [--json] | set pool <name> on|off [--provider <name>]";

/** Automatic reset is a setting of a pool. The CLI has no identity form. */
export async function runAutoResetCommand(args: string[], json: boolean, deps: GatewayCliDeps, providerFlag?: string): Promise<void> {
  const [action = "list", kind, name, value, ...extra] = args;
  const list = action === "list" && args.length <= 1;
  if (kind === "identity") {
    throw new CliUsageError("Automatic reset is a pool setting only. Identity settings are removed. Use: set pool <name> on|off");
  }
  if (!list && (action !== "set" || kind !== "pool" || !name || (value !== "on" && value !== "off") || extra.length > 0)) {
    throw new CliUsageError(USAGE);
  }
  if (providerFlag !== undefined && !isAutoResetProvider(providerFlag)) {
    throw new CliUsageError(`--provider must be codex or claude, got "${providerFlag}". Other providers have no reset API.`);
  }
  const { admin } = await connect(deps);
  if (list) {
    const response = await admin.call("GET", AUTO_RESET_PATH);
    if (json) {
      deps.out(JSON.stringify(response.json, null, 2));
      return;
    }
    const view = response.json as unknown as AutoResetView;
    const supported = view.providers.filter((row): row is AutoResetProviderView => row.supported);
    if (supported.every((row) => row.pools.length === 0)) deps.out("No managed pools.");
    for (const row of supported) {
      for (const pool of row.pools) deps.out(`${row.provider} pool ${pool.name}  ${formatAutoResetStatus(pool)}`);
    }
    for (const row of view.providers) if (!row.supported) deps.out(`${row.provider}  automatic reset is not supported: ${row.reason}`);
    return;
  }
  const provider = providerFlag ?? await providerOfPool(admin, name!);
  const response = await admin.call("PUT", `${autoResetProviderPath(provider)}/pool`, { name, enabled: value === "on" });
  deps.out(json ? JSON.stringify(response.json) : `${provider} pool ${name}  automatic reset ${value}`);
}

/** The provider that owns a pool name. A name in two providers needs `--provider`. */
async function providerOfPool(admin: Awaited<ReturnType<typeof connect>>["admin"], name: string): Promise<string> {
  const view = (await admin.call("GET", AUTO_RESET_PATH)).json as unknown as AutoResetView;
  const owners = view.providers.filter((row): row is AutoResetProviderView => row.supported && row.pools.some((pool) => pool.name === name));
  if (owners.length === 0) throw new CliUsageError(`No pool named "${name}". Run: ais gateway auto-reset list`);
  if (owners.length > 1) throw new CliUsageError(`Pool "${name}" exists for ${owners.map((row) => row.provider).join(" and ")}. Add --provider <name>.`);
  return owners[0]!.provider;
}

const formatTime = (iso: string) => DEFAULT_LIMIT_TIME_ZONES.map((zone) => formatInZone(Date.parse(iso), zone)).join(", ");

export function formatAutoResetClaim(claim: AutoResetLastClaim | undefined): string {
  if (!claim) return "none";
  return [
    `${claim.status} at ${formatTime(claim.startedAt)} (${claim.identity} in ${claim.pool})`,
    ...(claim.creditExpiresAt ? [`credit expiry ${formatTime(claim.creditExpiresAt)}`] : []),
  ].join(", ");
}

export function formatAutoResetStatus(setting: AutoResetStatus): string {
  return `automatic reset ${setting.enabled ? "on" : "off"}, last claim: ${formatAutoResetClaim(setting.lastClaim)}`;
}
