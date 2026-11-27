import { CODEX_AUTO_RESET_PATH, type AutoResetStatus, type AutoResetView } from "../../gateway/auto-reset-view.ts";
import { DEFAULT_LIMIT_TIME_ZONES, formatInZone } from "../../shared/limit-times.ts";
import { CliUsageError } from "../errors.ts";
import { connect, type GatewayCliDeps } from "./apps.ts";

export async function runAutoResetCommand(args: string[], json: boolean, deps: GatewayCliDeps): Promise<void> {
  const [action = "list", kind, name, value, ...extra] = args;
  const list = action === "list" && args.length <= 1;
  if (!list && (action !== "set" || kind !== "pool" || !name ||
    (value !== "on" && value !== "off") || extra.length > 0)) {
    throw new CliUsageError("Usage: ais gateway auto-reset list [--json] | set pool <name> on|off");
  }
  const { admin } = await connect(deps);
  if (list) {
    const response = await admin.call("GET", CODEX_AUTO_RESET_PATH);
    const { pools } = response.json as unknown as AutoResetView;
    if (json) {
      deps.out(JSON.stringify({ pools }, null, 2));
      return;
    }
    if (pools.length === 0) deps.out("No managed Codex pools.");
    for (const row of pools) deps.out(`pool ${row.name}  ${formatAutoResetStatus(row)}`);
    return;
  }
  const response = await admin.call("PUT", `${CODEX_AUTO_RESET_PATH}/pool`, { name, enabled: value === "on" });
  deps.out(json ? JSON.stringify(response.json) : `pool ${name}  automatic reset ${value}`);
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
