import { connect, type Admin, type GatewayCliDeps } from "../../cli/gateway/apps.ts";
import { readSecretsKey } from "../../cli/gateway/secrets-file.ts";
import type { GatewayApp } from "./plan.ts";
import { syncT3Instances, type SyncItem, type SyncT3InstancesOptions } from "./sync.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads the gateway app list now (`GET /apps`). Every call asks the gateway again: nothing is kept between calls. */
export async function fetchGatewayApps(admin: Admin): Promise<GatewayApp[]> {
  const { json } = await admin.call("GET", "/apps");
  const list = Array.isArray(json.apps) ? (json.apps as Record<string, unknown>[]) : [];
  return list.map((a) => {
    const t = (a.target ?? {}) as { kind?: unknown; identity?: unknown };
    return {
      name: str(a.name),
      provider: str(a.provider),
      state: str(a.state),
      target: { kind: t.kind === "pin" ? "pin" : "pool", ...(typeof t.identity === "string" ? { identity: t.identity } : {}) },
    } as GatewayApp;
  });
}

export type LiveSyncOptions = Omit<SyncT3InstancesOptions, "apps" | "gatewayRoot"> & { gatewayRoot?: string };

/** Reads the app list and the proxy base from the gateway and applies the difference to T3's settings. */
export async function syncT3InstancesLive(deps: GatewayCliDeps, opts: LiveSyncOptions = {}): Promise<SyncItem[]> {
  const { admin } = await connect(deps);
  const root = opts.gatewayRoot ?? (await readSecretsKey("AIS_GATEWAY_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_PROXY_URL;
  if (!root) throw new Error("Proxy base URL unknown: set AIS_GATEWAY_PROXY_URL in ~/.secrets");
  const apps = await fetchGatewayApps(admin);
  return syncT3Instances({ ...opts, apps, gatewayRoot: root, ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}) });
}
