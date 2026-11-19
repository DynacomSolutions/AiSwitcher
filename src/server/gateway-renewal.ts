import { Admin } from "../cli/gateway/apps.ts";
import { gatewayAdminConfig, type GatewayAppsDeps } from "./gateway-apps.ts";
import type { RefreshStatusDto } from "./auth-refresh.ts";

/**
 * Gateway-owned logins are renewed by the gateway, not by this host. The console reads the gateway admin route
 * `GET /logins/renewal` server-side (the admin token never reaches the page) and merges it with the host
 * scheduler state into one row per login for the Auth page.
 */

export interface GatewayRenewalLoginDto {
  provider: string;
  identity: string;
  lastRefreshAt: string | null;
  lastRefreshReplica: string | null;
  lastError: { at: string; code: string; detail: string } | null;
  expiresAt: string | null;
  nextRefreshAt: string | null;
  revoked: boolean;
}

export interface GatewayRenewalView {
  /** ok: the route answered. unconfigured: no admin URL or token here. unavailable: unreachable, 404 or malformed. */
  state: "ok" | "unconfigured" | "unavailable";
  logins: GatewayRenewalLoginDto[];
  /** Short reason when unavailable; never carries a token. */
  error?: string;
}

const RENEWAL_TIMEOUT_MS = 5_000;

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Maps one admin login, or undefined when it is malformed. Only gateway-renewed entries are kept. */
export function mapGatewayRenewalLogin(raw: unknown): GatewayRenewalLoginDto | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.provider !== "string" || r.provider === "" || typeof r.identity !== "string" || r.identity === "") return undefined;
  if (r.renewedBy !== undefined && r.renewedBy !== "gateway") return undefined;
  const e = r.lastError as Record<string, unknown> | null | undefined;
  const lastError =
    e && typeof e === "object" && typeof e.at === "string"
      ? { at: e.at, code: typeof e.code === "string" ? e.code : "other", detail: typeof e.detail === "string" ? e.detail : "" }
      : null;
  return {
    provider: r.provider,
    identity: r.identity,
    lastRefreshAt: strOrNull(r.lastRefreshAt),
    lastRefreshReplica: strOrNull(r.lastRefreshReplica),
    lastError,
    expiresAt: strOrNull(r.expiresAt),
    nextRefreshAt: strOrNull(r.nextRefreshAt),
    revoked: r.revoked === true,
  };
}

/** Reads the gateway's renewal state. Never throws: a missing route, a down gateway or bad JSON is "unavailable". */
export async function loadGatewayRenewal(deps: GatewayAppsDeps = {}): Promise<GatewayRenewalView> {
  const cfg = await gatewayAdminConfig(deps).catch(() => undefined);
  if (!cfg) return { state: "unconfigured", logins: [] };
  const inner = deps.fetch ?? fetch;
  const ms = deps.timeoutMs ?? RENEWAL_TIMEOUT_MS;
  const timed = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => inner(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
  try {
    const { json } = await new Admin(cfg.url, cfg.token, timed).call("GET", "/logins/renewal");
    if (!Array.isArray(json.logins)) return { state: "unavailable", logins: [], error: "gateway renewal answer was not understood" };
    return { state: "ok", logins: json.logins.flatMap((l) => mapGatewayRenewalLogin(l) ?? []) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /\((\d{3})\)/.exec(message)?.[1];
    return { state: "unavailable", logins: [], error: status === "404" ? "gateway has no renewal route yet" : message.includes("unreachable") ? "gateway admin unreachable" : `gateway admin answered ${status ?? "with an error"}` };
  }
}

/**
 * The logins ("provider/identity") the gateway renews, read from its renewal list and cached for a short time. `undefined`
 * when the list cannot be read (no admin address, an unreachable gateway, an old gateway without the route): callers fail
 * closed. A failed read is not retried for a while, so a down gateway does not stall every caller.
 */
export function gatewayOwnership(load: () => Promise<GatewayRenewalView> = () => loadGatewayRenewal(), ttlMs = 60_000, now: () => number = Date.now): () => Promise<Set<string> | undefined> {
  let cache: { at: number; set: Set<string> } | undefined;
  let failedAt: number | undefined;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.set;
    if (failedAt !== undefined && now() - failedAt < 15_000) return undefined;
    const view = await load().catch(() => undefined);
    if (view?.state !== "ok") {
      failedAt = now();
      return undefined;
    }
    failedAt = undefined;
    cache = { at: now(), set: new Set(view.logins.map((l) => `${l.provider}/${l.identity}`)) };
    return cache.set;
  };
}

/** Who renews a login. `pool`: a pool holds no login of its own. */
export type Renewer = "gateway" | "host" | "pool";

export interface RenewalRowDto {
  tool: string;
  identity: string;
  renewer: Renewer;
  /** gateway rows: the gateway's own state, or null when the gateway state could not be read. */
  gateway: GatewayRenewalLoginDto | null;
  /** gateway rows: why `gateway` is null. */
  gatewayState?: GatewayRenewalView["state"];
  /** host rows: this host's refresher state. Never set for gateway or pool rows, so a stale stamp cannot show. */
  host: Pick<RefreshStatusDto, "lastAttemptAt" | "lastSuccessAt" | "lastError" | "lastDetail" | "revoked" | "consecutiveFailures" | "running"> | null;
  /** Plain statement of who renews this login and why. */
  note: string;
}

const GATEWAY_DETAIL = /gateway/i;

/**
 * One row per login. A login is gateway-owned when the gateway lists it, or when the host stood down for it
 * (the host detail names the gateway). Pools hold no login. Everything else is renewed by this host.
 */
export function buildRenewalRows(host: RefreshStatusDto[], gateway: GatewayRenewalView, poolKeys: ReadonlySet<string> = new Set()): RenewalRowDto[] {
  const gw = new Map(gateway.logins.map((l) => [`${l.provider}/${l.identity}`, l]));
  const hostByKey = new Map(host.map((h) => [`${h.tool}/${h.identity}`, h]));
  const keys = new Set<string>([...hostByKey.keys(), ...gw.keys()]);
  const rows: RenewalRowDto[] = [];
  for (const key of keys) {
    const h = hostByKey.get(key);
    const g = gw.get(key);
    const slash = key.indexOf("/");
    const tool = key.slice(0, slash);
    const identity = key.slice(slash + 1);
    if (poolKeys.has(key) && !g) {
      rows.push({ tool, identity, renewer: "pool", gateway: null, host: null, note: "A pool holds no login of its own. The gateway renews each member account." });
      continue;
    }
    if (g || (h?.lastDetail && GATEWAY_DETAIL.test(h.lastDetail))) {
      rows.push({
        tool,
        identity,
        renewer: "gateway",
        gateway: g ?? null,
        ...(g ? {} : { gatewayState: gateway.state }),
        host: null,
        note: g ? "Renewed by the gateway" : "Renewed by the gateway. Its renewal state is unavailable.",
      });
      continue;
    }
    const opencode = tool === "opencode";
    rows.push({
      tool,
      identity,
      renewer: "host",
      gateway: null,
      host: h
        ? { lastAttemptAt: h.lastAttemptAt, lastSuccessAt: h.lastSuccessAt, lastError: h.lastError, lastDetail: h.lastDetail, revoked: h.revoked, consecutiveFailures: h.consecutiveFailures, running: h.running }
        : null,
      note: opencode ? "Renewed by this host, only when the login is close to expiry" : "Renewed by this host",
    });
  }
  return rows.sort((a, b) => a.tool.localeCompare(b.tool) || a.identity.localeCompare(b.identity));
}
