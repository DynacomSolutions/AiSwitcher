import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import type { BrowserBinding, BrowserTarget } from "../browser/types.ts";
import { HttpError } from "./types.ts";

/** A binding seen within this window counts as connected (the gateway exposes no live flag). */
export const CONNECTED_WINDOW_MS = 120_000;

export interface BrowserBindingDto {
  name: string;
  target: BrowserTarget;
  profileLabel: string;
  state: BrowserBinding["state"];
  createdAt?: string;
  lastSeenAt?: string;
  /** Active and last seen within CONNECTED_WINDOW_MS. */
  connected: boolean;
}

export interface BrowserBindingsView {
  /** False when this process has no gateway admin URL and token. */
  configured: boolean;
  bindings: BrowserBindingDto[];
  /** Short reason when the admin API could not be read; never carries a token. */
  error?: string;
}

export interface BrowserBindingsDeps {
  fetch?: typeof fetch;
  secretsPath?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Overrides the secrets file and env lookup (tests). */
  admin?: { url: string; token: string };
}

async function adminConfig(deps: BrowserBindingsDeps): Promise<{ url: string; token: string } | undefined> {
  if (deps.admin) return deps.admin;
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : undefined;
}

/** Maps the admin `GET /browser/bindings` body, dropping malformed entries; active before revoked, then by name. */
export function mapBrowserBindings(json: unknown, now: number): BrowserBindingDto[] {
  const list = (json as { bindings?: unknown } | null | undefined)?.bindings;
  if (!Array.isArray(list)) return [];
  const out: BrowserBindingDto[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.name !== "string" || r.name === "") continue;
    const t = r.target as Record<string, unknown> | null | undefined;
    const target: BrowserTarget | undefined =
      t?.kind === "pool" && typeof t.pool === "string" ? { kind: "pool", pool: t.pool }
      : t?.kind === "identity" && typeof t.identity === "string" ? { kind: "identity", identity: t.identity }
      : undefined;
    if (!target) continue;
    const state = r.state === "revoked" ? "revoked" : "active";
    const lastSeenAt = typeof r.lastSeenAt === "string" && r.lastSeenAt !== "" ? r.lastSeenAt : undefined;
    const seen = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
    out.push({
      name: r.name,
      target,
      profileLabel: typeof r.profileLabel === "string" ? r.profileLabel : "",
      state,
      ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
      connected: state === "active" && Number.isFinite(seen) && now - seen <= CONNECTED_WINDOW_MS,
    });
  }
  return out.sort((a, b) => Number(a.state === "revoked") - Number(b.state === "revoked") || a.name.localeCompare(b.name));
}

/** Lists browser bindings through the gateway admin API. Failures come back as a short `error`, never thrown. */
export async function loadBrowserBindings(deps: BrowserBindingsDeps = {}): Promise<BrowserBindingsView> {
  const cfg = await adminConfig(deps);
  if (!cfg) return { configured: false, bindings: [] };
  try {
    const res = await (deps.fetch ?? fetch)(`${cfg.url}/browser/bindings`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) return { configured: true, bindings: [], error: `admin answered ${res.status}` };
    return { configured: true, bindings: mapBrowserBindings(await res.json(), (deps.now ?? Date.now)()) };
  } catch {
    return { configured: true, bindings: [], error: "admin unreachable" };
  }
}

/** Revokes one binding through the gateway admin API. Throws HttpError with a safe message. */
export async function revokeBrowserBinding(name: string, deps: BrowserBindingsDeps = {}): Promise<{ ok: true }> {
  const cfg = await adminConfig(deps);
  if (!cfg) throw new HttpError(503, "gateway admin is not configured on this console");
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${cfg.url}/browser/bindings/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
  } catch {
    throw new HttpError(502, "gateway admin unreachable");
  }
  if (res.status === 404) throw new HttpError(404, `no browser binding "${name}"`);
  if (!res.ok) throw new HttpError(502, `gateway admin answered ${res.status}`);
  return { ok: true };
}
