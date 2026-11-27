import { CODEX_AUTO_RESET_PATH, type AutoResetStatus, type AutoResetView } from "../../gateway/auto-reset-view.ts";
import { DEFAULT_LIMIT_TIME_ZONES, formatInZone } from "../../shared/limit-times.ts";
import { CliUsageError } from "../errors.ts";
import { connect, type GatewayCliDeps } from "./apps.ts";

export async function runAutoResetCommand(args: string[], json: boolean, deps: GatewayCliDeps): Promise<void> {
  const [action = "list", kind, name, value, ...extra] = args;
  const list = action === "list" && args.length <= 1;
  if (!list && (action !== "set" || (kind !== "pool" && kind !== "identity") || !name ||
    (value !== "on" && value !== "off") || extra.length > 0)) {
    throw new CliUsageError("Usage: ais gateway auto-reset list [--json] | set pool|identity <name> on|off");
  }
  const { admin } = await connect(deps);
  if (list) {
    const response = await admin.call("GET", CODEX_AUTO_RESET_PATH);
    if (json) {
      deps.out(JSON.stringify(response.json, null, 2));
      return;
    }
    const settings = response.json as unknown as AutoResetView;
    if (settings.pools.length === 0 && settings.identities.length === 0) deps.out("No managed Codex pools or identities.");
    for (const [scope, rows] of [["pool", settings.pools], ["identity", settings.identities]] as const) {
      for (const row of rows) deps.out(`${scope} ${row.name}  ${formatAutoResetStatus(row)}`);
    }
    return;
  }
  const response = await admin.call("PUT", `${CODEX_AUTO_RESET_PATH}/${kind}`, { name, enabled: value === "on" });
  deps.out(json ? JSON.stringify(response.json) : `${kind} ${name}  automatic reset ${value}`);
}

export function formatAutoResetStatus(setting: AutoResetStatus): string {
  const claim = setting.lastClaim;
  const formatTime = (iso: string) => DEFAULT_LIMIT_TIME_ZONES.map((zone) => formatInZone(Date.parse(iso), zone)).join(", ");
  const lastClaim = claim ? [
    `${claim.status} at ${formatTime(claim.startedAt)} (${claim.identity} in ${claim.pool})`,
    ...(claim.creditExpiresAt ? [`credit expiry ${formatTime(claim.creditExpiresAt)}`] : []),
  ].join(", ") : "none";
  return `automatic reset ${setting.enabled ? "on" : "off"}, last claim: ${lastClaim}`;
}
