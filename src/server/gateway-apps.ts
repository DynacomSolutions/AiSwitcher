import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { Admin, RotateDeliveryError, rotateApp, type GatewayCliDeps } from "../cli/gateway/apps.ts";
import { runKubectl } from "../cli/gateway/kube-secret.ts";
import { DEFAULT_RESERVE_PERCENT } from "../gateway/select.ts";
import { mapGatewayUsage } from "../gateway/usage-view.ts";
import { HttpError } from "./types.ts";

/**
 * Gateway apps for the console: a thin proxy over the gateway admin API, read and
 * written server-side so the admin token never reaches the page. Rotation runs the
 * CLI's own `rotateApp`, so the kube Secret, ~/.secrets and Codex homes are updated
 * exactly as `ais gateway app rotate` does.
 */

export interface GatewayAppTokenDto {
  prefix: string;
  createdAt: string;
  /** Set on older tokens once a newer one was minted (the rotation overlap). */
  expiresAt?: string;
}

export interface GatewayAppDto {
  name: string;
  owner: string;
  namespace: string;
  provider: string;
  style: string;
  target: { kind: "pin"; identity: string } | { kind: "pool"; identities?: string[] };
  models?: string[];
  dailyTokens?: number;
  /** As stored; absent means the gateway default applies. */
  reservePercent?: number;
  /** What the gateway enforces: reservePercent, else DEFAULT_RESERVE_PERCENT. */
  effectiveReservePercent: number;
  state: "active" | "revoked";
  createdAt?: string;
  lastUsedAt?: string;
  tokens: GatewayAppTokenDto[];
  /** Ledger tokens (input, output, cache writes) over the last day and 7 days; null when the usage read failed. */
  usage1d: number | null;
  usage7d: number | null;
}

export interface GatewayAppsView {
  /** False when this process has no gateway admin URL and token. */
  configured: boolean;
  apps: GatewayAppDto[];
  defaultReservePercent: number;
  /** Short reason when the app list could not be read; never carries a token. */
  error?: string;
  /** Set when the apps loaded but the usage figures did not. */
  usageError?: string;
}

export interface GatewayAppPatch {
  reservePercent?: number | null;
  models?: string[] | null;
  dailyTokens?: number | null;
}

export interface GatewayRotateResult {
  app: string;
  /** The new token. Returned once; the gateway keeps only its prefix. */
  token: string;
  url: string;
  previousTokensExpireAt: string;
  /** Delivery lines from the CLI path (Secret, secrets file, Codex homes), token removed. */
  messages: string[];
  /** Set when a delivery step failed; the token is still valid. */
  deliveryError?: string;
}

export interface GatewayAppsDeps {
  fetch?: typeof fetch;
  secretsPath?: string;
  timeoutMs?: number;
  /** Overrides the secrets file and env lookup (tests). */
  admin?: { url: string; token: string };
  /** Rotation delivery seams (tests); default to the CLI's kubectl runner and clock. */
  kubectl?: GatewayCliDeps["kubectl"];
  codexHomesPath?: string;
  now?: () => number;
}

// The admin `GET /usage` used to take several seconds with ~60 apps; give reads room.
const DEFAULT_TIMEOUT_MS = 15_000;

export async function gatewayAdminConfig(deps: Pick<GatewayAppsDeps, "admin" | "secretsPath">): Promise<{ url: string; token: string } | undefined> {
  if (deps.admin) return deps.admin;
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : undefined;
}

function timedFetch(deps: GatewayAppsDeps): typeof fetch {
  const inner = deps.fetch ?? fetch;
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => inner(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

async function adminFor(deps: GatewayAppsDeps): Promise<Admin> {
  const cfg = await gatewayAdminConfig(deps);
  if (!cfg) throw new HttpError(503, "gateway admin is not configured on this console");
  return new Admin(cfg.url, cfg.token, timedFetch(deps));
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function checkName(name: string): string {
  if (!NAME.test(name)) throw new HttpError(400, "invalid app name");
  return name;
}

/** Admin errors carry the admin's own reason; map them to a console status without leaking anything else. */
function adminError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (status === "404") return new HttpError(404, "no such app");
  if (status === "400" || status === "409") return new HttpError(Number(status), message.replace(/^gateway admin \S+ \S+ failed \(\d+\): /, ""));
  return new HttpError(502, message.includes("unreachable") ? "gateway admin unreachable" : message);
}

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Maps one admin app view, or undefined when it is malformed. */
export function mapGatewayApp(raw: unknown, usage1d: Map<string, number> | undefined, usage7d: Map<string, number> | undefined): GatewayAppDto | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.name !== "string" || r.name === "") return undefined;
  const t = r.target as Record<string, unknown> | null | undefined;
  const target: GatewayAppDto["target"] | undefined =
    t?.kind === "pin" && typeof t.identity === "string" ? { kind: "pin", identity: t.identity }
    : t?.kind === "pool" ? (Array.isArray(t.identities) ? { kind: "pool", identities: t.identities.filter((x): x is string => typeof x === "string") } : { kind: "pool" })
    : undefined;
  if (!target) return undefined;
  const tokens: GatewayAppTokenDto[] = (Array.isArray(r.tokens) ? r.tokens : []).flatMap((x: unknown) => {
    const tk = x as Record<string, unknown> | null;
    if (!tk || typeof tk.prefix !== "string") return [];
    return [{ prefix: tk.prefix, createdAt: strOf(tk.createdAt) ?? "", ...(strOf(tk.expiresAt) ? { expiresAt: strOf(tk.expiresAt)! } : {}) }];
  });
  // Newest first: the current token heads the list.
  tokens.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const reservePercent = numOf(r.reservePercent);
  const dailyTokens = numOf(r.dailyTokens);
  const models = Array.isArray(r.models) ? r.models.filter((x): x is string => typeof x === "string") : undefined;
  return {
    name: r.name,
    owner: strOf(r.owner) ?? "",
    namespace: strOf(r.namespace) ?? "",
    provider: strOf(r.provider) ?? "",
    style: strOf(r.style) ?? "",
    target,
    ...(models ? { models } : {}),
    ...(dailyTokens !== undefined ? { dailyTokens } : {}),
    ...(reservePercent !== undefined ? { reservePercent } : {}),
    effectiveReservePercent: reservePercent ?? DEFAULT_RESERVE_PERCENT,
    state: r.state === "revoked" ? "revoked" : "active",
    ...(strOf(r.createdAt) ? { createdAt: strOf(r.createdAt)! } : {}),
    ...(strOf(r.lastUsedAt) ? { lastUsedAt: strOf(r.lastUsedAt)! } : {}),
    tokens,
    usage1d: usage1d ? (usage1d.get(r.name) ?? 0) : null,
    usage7d: usage7d ? (usage7d.get(r.name) ?? 0) : null,
  };
}

/** Every app with its tokens' prefixes and 1/7-day usage. Failures come back as a short `error`, never thrown. */
export async function loadGatewayApps(deps: GatewayAppsDeps = {}): Promise<GatewayAppsView> {
  const base = { defaultReservePercent: DEFAULT_RESERVE_PERCENT };
  if (!(await gatewayAdminConfig(deps))) return { ...base, configured: false, apps: [] };
  const admin = await adminFor(deps);
  const usage = async (days: number): Promise<Map<string, number>> => {
    const { json } = await admin.call("GET", `/usage?days=${days}`);
    return new Map(mapGatewayUsage(json).map((u) => [u.app, u.tokens]));
  };
  const [apps, day, week] = await Promise.allSettled([admin.call("GET", "/apps"), usage(1), usage(7)]);
  if (apps.status === "rejected") return { ...base, configured: true, apps: [], error: adminError(apps.reason).message };
  const d = day.status === "fulfilled" ? day.value : undefined;
  const w = week.status === "fulfilled" ? week.value : undefined;
  const list = Array.isArray(apps.value.json.apps) ? apps.value.json.apps : [];
  const out = list.flatMap((a) => mapGatewayApp(a, d, w) ?? []);
  out.sort((a, b) => Number(a.state === "revoked") - Number(b.state === "revoked") || a.name.localeCompare(b.name));
  const failed = [day, week].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
  return { ...base, configured: true, apps: out, ...(failed ? { usageError: adminError(failed.reason).message } : {}) };
}

/** Validates the editable fields of a console update; null clears a field. */
export function parseGatewayAppPatch(raw: unknown): GatewayAppPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HttpError(400, "body must be a JSON object");
  const r = raw as Record<string, unknown>;
  const patch: GatewayAppPatch = {};
  if ("reservePercent" in r) {
    const v = r.reservePercent;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100)) throw new HttpError(400, "reservePercent must be a whole number from 1 to 100, or null for the default");
    patch.reservePercent = v as number | null;
  }
  if ("dailyTokens" in r) {
    const v = r.dailyTokens;
    if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v > 0)) throw new HttpError(400, "dailyTokens must be a positive whole number, or null for no cap");
    patch.dailyTokens = v as number | null;
  }
  if ("models" in r) {
    const v = r.models;
    if (v !== null && !(Array.isArray(v) && v.every((m) => typeof m === "string" && m.trim() !== ""))) throw new HttpError(400, "models must be a list of model ids, or null for any model");
    patch.models = v === null ? null : [...new Set((v as string[]).map((m) => m.trim()))];
  }
  return patch;
}

/** Merges the patch over the current app (like `ais gateway app update`) and PUTs it; null or an empty list clears a field. */
export async function updateGatewayApp(name: string, patch: GatewayAppPatch, deps: GatewayAppsDeps = {}): Promise<GatewayAppDto> {
  const admin = await adminFor(deps);
  try {
    const { json: cur } = await admin.call("GET", `/apps/${checkName(name)}`);
    const body: Record<string, unknown> = { owner: cur.owner, namespace: cur.namespace, provider: cur.provider, style: cur.style, target: cur.target };
    for (const k of ["models", "dailyTokens", "reservePercent"] as const) if (cur[k] !== undefined && cur[k] !== null) body[k] = cur[k];
    for (const k of ["models", "dailyTokens", "reservePercent"] as const) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === null || (Array.isArray(v) && v.length === 0)) delete body[k];
      else body[k] = v;
    }
    const { json } = await admin.call("PUT", `/apps/${name}`, body);
    const app = mapGatewayApp(json, undefined, undefined);
    if (!app) throw new HttpError(502, "gateway admin returned no app");
    return app;
  } catch (e) {
    throw adminError(e);
  }
}

/** Revokes an app: immediate and final. */
export async function revokeGatewayApp(name: string, deps: GatewayAppsDeps = {}): Promise<{ app: string; state: "revoked" }> {
  const admin = await adminFor(deps);
  try {
    await admin.call("POST", `/apps/${checkName(name)}/revoke`);
    return { app: name, state: "revoked" };
  } catch (e) {
    throw adminError(e);
  }
}

/** Mints a new token through the CLI's rotate path and returns it once, with the delivery outcome. */
export async function rotateGatewayApp(name: string, deps: GatewayAppsDeps = {}): Promise<GatewayRotateResult> {
  const admin = await adminFor(deps);
  const lines: string[] = [];
  const cli: GatewayCliDeps = {
    fetch: deps.fetch ?? fetch,
    kubectl: deps.kubectl ?? runKubectl,
    ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}),
    ...(deps.codexHomesPath ? { codexHomesPath: deps.codexHomesPath } : {}),
    out: (line) => lines.push(line),
    now: deps.now ?? Date.now,
  };
  const clean = (token: string) => lines.filter((l) => !l.includes(token)).map((l) => l.split(token).join("[redacted]"));
  try {
    const r = await rotateApp(admin, cli, {}, checkName(name));
    return { app: name, ...r, messages: clean(r.token) };
  } catch (e) {
    if (e instanceof RotateDeliveryError) {
      const m = e.minted;
      return { app: name, ...m, messages: clean(m.token), deliveryError: e.message };
    }
    // CliUsageError (no proxy URL) or an admin failure: nothing was minted, or the admin refused.
    if (e instanceof Error && e.name === "CliUsageError") throw new HttpError(503, e.message);
    throw adminError(e);
  }
}
