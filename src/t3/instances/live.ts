import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Admin, connect, type GatewayCliDeps } from "../../cli/gateway/apps.ts";
import { readSecretsKey } from "../../cli/gateway/secrets-file.ts";
import { writeFileAtomic } from "../../identities/pool/fs.ts";
import { planT3Instances, type GatewayApp } from "./plan.ts";
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

/** The scoped credential of the t3-instances scope (`ais gateway instances-token`). It lists apps and hands out app tokens, nothing else. */
export const INSTANCES_TOKEN_KEY = "AIS_GATEWAY_INSTANCES_TOKEN";

async function setting(deps: GatewayCliDeps, key: string): Promise<string | undefined> {
  return (process.env[key]?.trim() || (await readSecretsKey(key, deps.secretsPath))?.trim()) || undefined;
}

/**
 * Reads the app list and the proxy base from the gateway and applies the difference to T3's settings.
 * With AIS_GATEWAY_INSTANCES_TOKEN set and no admin token (a pod) the list comes from the scoped credential and each
 * app token is read from the gateway now (POST /apps/<app>/instance-token); with `tokenDir` the tokens are also written there, one
 * file per app (mode 0600). Without it the admin token reads the list and the app tokens come from the token folder or ~/.secrets.
 */
export async function syncT3InstancesLive(deps: GatewayCliDeps, opts: LiveSyncOptions = {}): Promise<SyncItem[]> {
  // The scoped credential is for a pod, which has no admin token. A host that has the admin token uses it (and its own app tokens).
  const scoped = (await setting(deps, "AIS_GATEWAY_ADMIN_TOKEN")) ? undefined : await setting(deps, INSTANCES_TOKEN_KEY);
  const url = scoped ? await setting(deps, "AIS_GATEWAY_ADMIN_URL") : undefined;
  const admin = scoped && url ? new Admin(url.replace(/\/+$/, ""), scoped, deps.fetch) : (await connect(deps)).admin;
  const root = opts.gatewayRoot ?? (await setting(deps, "AIS_GATEWAY_PROXY_URL"));
  if (!root) throw new Error("Proxy base URL unknown: set AIS_GATEWAY_PROXY_URL in ~/.secrets");
  const apps = await fetchGatewayApps(admin);
  const out: LiveSyncOptions & { apps: GatewayApp[] } = { ...opts, apps };
  if (scoped && url) {
    // The apps the plan uses, asked one by one, now. A refused or unknown app has no token: the sync skips it and keeps its instance.
    const tokens = new Map<string, string | undefined>();
    for (const name of new Set(planT3Instances(apps).map((p) => p.app))) {
      const { status, json } = await admin.call("POST", `/apps/${encodeURIComponent(name)}/instance-token`, undefined, [403, 404]);
      tokens.set(name, status < 300 && typeof json.token === "string" ? json.token : undefined);
    }
    out.tokenFor = async (name) => tokens.get(name);
    if (opts.tokenDir && !opts.check) {
      await mkdir(opts.tokenDir, { recursive: true });
      for (const [name, token] of tokens) {
        if (!token) continue;
        const file = join(opts.tokenDir, name);
        await writeFileAtomic(file, `${token}\n`);
        await chmod(file, 0o600);
      }
    }
  }
  return syncT3Instances({ ...out, gatewayRoot: root, ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}) });
}
