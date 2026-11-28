import { userInfo } from "node:os";
import { TOOL_CONFIGS } from "../identities/resolve-tool.ts";
import { isSwapPool } from "../../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import { boolFlag, listFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { refreshRegisteredCodexHomes } from "../../identities/codex-gateway-home.ts";
import type { SessionUsage } from "../../gateway/types.ts";
import { mapGatewaySessions } from "../../gateway/usage-view.ts";
import { buildSessionCost, formatSessionCost } from "./session-cost.ts";
import { writeAppSecret, type KubectlRunner } from "./kube-secret.ts";
import { appTokenKey, appendSecretsFile, readSecretsKey } from "./secrets-file.ts";

type Flags = ParsedArgs["flags"];

export interface GatewayCliDeps {
  fetch: typeof fetch;
  kubectl: KubectlRunner;
  /** Path of the secrets file (default ~/.secrets). */
  secretsPath?: string;
  out(line: string): void;
  now(): number;
  /** True when `name` (or an alias) is a swap pool in the local registry. Defaults to reading it. */
  /** Registry of configured Codex homes (default ~/.ais/gateway-codex-homes.json). */
  codexHomesPath?: string;
  isPoolName?(provider: string, name: string): Promise<boolean>;
}

async function localIsPoolName(provider: string, name: string): Promise<boolean> {
  try {
    const cfg = (TOOL_CONFIGS as Record<string, { identitiesJsonPath: string } | undefined>)[provider];
    if (!cfg) return false;
    const found = findIdentityByNameOrAlias((await loadIdentitiesFile(cfg.identitiesJsonPath)).identities, name);
    return found !== undefined && isSwapPool(found);
  } catch {
    // An unreadable local registry must not block; the admin API is authoritative.
    return false;
  }
}

/** Friendly early rejection of a swap-pool name used as a pinned identity. */
async function rejectPoolPin(deps: GatewayCliDeps, provider: string, target: AppTarget | undefined, flagged: boolean): Promise<void> {
  if (!flagged || target?.kind !== "pin" || target.identity === undefined) return;
  if (await (deps.isPoolName ?? localIsPoolName)(provider, target.identity)) {
    throw new CliUsageError(`"${target.identity}" is a swap pool, not one account: --identity would pin to the pool's active login only. Use --pool instead`);
  }
}

/** Said when `--identities` is used. A pool app uses every live pool member. */
const POOL_LIST_REFUSED = "pool apps follow the live pool; member lists are not accepted";

/** The target of a stored app for an update. An old member list on a pool is dropped. */
function currentTarget(t: unknown): AppTarget {
  const target = t as AppTarget & { identities?: unknown };
  return target?.kind === "pool" ? { kind: "pool" } : target;
}

interface AppTarget {
  kind: "pin" | "pool";
  identity?: string;
}

interface AppBody {
  owner: string;
  namespace: string;
  provider: string;
  style: string;
  target: AppTarget;
  models?: string[];
  dailyTokens?: number;
  reservePercent?: number;
}

/** Providers with one API style only; kimi and zai offer both, so the caller must choose. */
const FIXED_STYLE: Record<string, string> = { claude: "anthropic", ali: "anthropic", codex: "openai", grok: "openai", opencode: "openai" };
const CHOOSE_STYLE = new Set(["kimi", "zai"]);

export class Admin {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch,
  ) {}

  async call(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new Error(`gateway admin unreachable at ${this.base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`gateway admin ${method} ${path} failed (${res.status}): ${typeof json.error === "string" ? json.error : "no reason given"}`);
    }
    return { status: res.status, json };
  }
}

export async function connect(deps: Pick<GatewayCliDeps, "secretsPath" | "fetch">): Promise<{ admin: Admin; secretsPath: string | undefined }> {
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!url || !token) throw new CliUsageError("AIS_GATEWAY_ADMIN_URL and AIS_GATEWAY_ADMIN_TOKEN must be set in ~/.secrets");
  return { admin: new Admin(url.replace(/\/+$/, ""), token, deps.fetch), secretsPath: deps.secretsPath };
}

function intFlag(flags: Flags, name: string): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new CliUsageError(`--${name} must be a number, got "${raw}"`);
  return n;
}

function targetFromFlags(flags: Flags, required: boolean): AppTarget | undefined {
  const pool = flags.pool !== undefined;
  const identity = stringFlag(flags, "identity");
  if (pool && identity !== undefined) throw new CliUsageError("Use either --pool or --identity=<id>, not both");
  if (flags.identities !== undefined) throw new CliUsageError(POOL_LIST_REFUSED);
  if (identity !== undefined) return { kind: "pin", identity };
  if (pool) return { kind: "pool" };
  if (required) throw new CliUsageError("Choose a target: --pool or --identity=<id>");
  return undefined;
}

function applyOptional(body: AppBody, flags: Flags): void {
  const models = listFlag(flags, "models");
  if (models !== undefined) body.models = models;
  const daily = intFlag(flags, "daily-tokens");
  if (daily !== undefined) body.dailyTokens = daily;
  const reserve = intFlag(flags, "reserve");
  if (reserve !== undefined) body.reservePercent = reserve;
}

function buildNew(flags: Flags): AppBody {
  const namespace = stringFlag(flags, "namespace");
  const provider = stringFlag(flags, "provider");
  if (!namespace) throw new CliUsageError("Missing required --namespace=<ns>");
  if (!provider) throw new CliUsageError("Missing required --provider=<provider>");
  let style = stringFlag(flags, "style");
  if (style === undefined) {
    if (CHOOSE_STYLE.has(provider)) throw new CliUsageError(`--style is required for ${provider}: anthropic or openai`);
    style = FIXED_STYLE[provider];
    // An unknown provider: let the admin API name the valid ones.
    style ??= "anthropic";
  }
  const target = targetFromFlags(flags, true)!;
  const body: AppBody = { owner: stringFlag(flags, "owner") ?? userInfo().username, namespace, provider, style, target };
  applyOptional(body, flags);
  return body;
}

const proxyUrl = async (deps: GatewayCliDeps, flags: Flags, app: string): Promise<string> => {
  const base = stringFlag(flags, "url") ?? (await readSecretsKey("AIS_GATEWAY_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_PROXY_URL;
  if (!base) throw new CliUsageError("Proxy base URL unknown: set AIS_GATEWAY_PROXY_URL in ~/.secrets or pass --url=<base>");
  return `${base.replace(/\/+$/, "")}/${app}`;
};

/** Delivers a freshly minted token: kube Secret, then the local secrets file, then the one printed copy. */
async function deliverToken(deps: GatewayCliDeps, app: string, namespace: string, url: string, token: string): Promise<void> {
  const redact = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split(token).join("[redacted]");
  let kubeError: unknown;
  let fileError: unknown;
  try {
    await writeAppSecret(namespace, app, { url, username: app, token }, deps.kubectl);
  } catch (e) {
    kubeError = e;
  }
  try {
    await appendSecretsFile(appTokenKey(app), token, deps.secretsPath, Math.floor(deps.now() / 1000));
  } catch (e) {
    fileError = e;
  }
  deps.out(`app: ${app}`);
  deps.out(`url: ${url}`);
  deps.out(`token (shown once): ${token}`);
  // Registered Codex homes get the new token too; a failure here must not hide the message above.
  try {
    const r = await refreshRegisteredCodexHomes(app, token, deps.codexHomesPath);
    if (r.updated > 0 || r.failed.length > 0) deps.out(`codex homes: auth.json rewritten in ${r.updated} registered folder(s)`);
    for (const f of r.failed) deps.out(`codex homes: not updated, ${f}`);
  } catch (e) {
    deps.out(`codex homes: not updated, ${(e instanceof Error ? e.message : String(e)).split(token).join("[redacted]")}`);
  }
  if (kubeError === undefined && fileError === undefined) {
    deps.out(`secret: ais-gateway-${app} written in ${namespace}; token saved as ${appTokenKey(app)} in ~/.secrets`);
    return;
  }
  const parts: string[] = [];
  if (kubeError !== undefined) parts.push(redact(kubeError));
  if (fileError !== undefined) parts.push(`secrets file not updated: ${redact(fileError)}`);
  const hint = kubeError !== undefined ? `fix kubectl access, then run: ais gateway app rotate ${app}` : "copy the token above now";
  throw new Error(`${parts.join("; ")} (the token was minted; ${hint})`);
}

function mintedToken(json: Record<string, unknown>): string {
  if (typeof json.token !== "string" || json.token === "") throw new Error("gateway admin returned no token; nothing was written");
  return json.token;
}

/** The app is revoked, so add or rotate is refused. Carries the CliUsageError name so callers handle it like any usage error. */
export class RevokedAppError extends CliUsageError {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** A revoked app is final: its name and tokens never come back, so add and rotate refuse it. */
function revokedMessage(name: string, action: "add" | "rotate"): string {
  return `App "${name}" is revoked; a revoked app stays revoked and its tokens never work again, so it cannot be ${action === "add" ? "added again" : "rotated"}. Register a new name: ais gateway app add <new-name> ...`;
}

function appName(positionals: string[]): string {
  const name = positionals[0];
  if (!name) throw new CliUsageError("App name required, e.g. ais gateway app add <name> ...");
  return name;
}

/**
 * `ais gateway app rotate`: mints a new token and delivers it (kube Secret, ~/.secrets, registered Codex homes, the
 * one printed copy). The console's rotate action calls this same function, so both update the same places.
 * Returns the minted token so a caller that captures `deps.out` can still hand it over when delivery throws.
 */
export async function rotateApp(admin: Admin, deps: GatewayCliDeps, flags: Flags, name: string): Promise<{ token: string; url: string; previousTokensExpireAt: string }> {
  const { json: cur } = await admin.call("GET", `/apps/${name}`);
  if (cur.state === "revoked") throw new RevokedAppError(revokedMessage(name, "rotate"));
  const url = await proxyUrl(deps, flags, name);
  const minted = await admin.call("POST", `/apps/${name}/tokens`, {});
  const token = mintedToken(minted.json);
  const previousTokensExpireAt = str(minted.json.previousTokensExpireAt);
  try {
    await deliverToken(deps, name, str(cur.namespace), url, token);
  } catch (e) {
    throw new RotateDeliveryError(e instanceof Error ? e.message : String(e), { token, url, previousTokensExpireAt });
  }
  deps.out("previous tokens keep working until " + previousTokensExpireAt);
  return { token, url, previousTokensExpireAt };
}

/** The token was minted but at least one delivery step failed; `minted` carries it (message is already redacted). */
export class RotateDeliveryError extends Error {
  // Private, so printing the error object (Bun shows own enumerable fields) can never show the token.
  readonly #minted: { token: string; url: string; previousTokensExpireAt: string };
  constructor(message: string, minted: { token: string; url: string; previousTokensExpireAt: string }) {
    super(message);
    this.name = "RotateDeliveryError";
    this.#minted = minted;
  }
  get minted(): { token: string; url: string; previousTokensExpireAt: string } {
    return this.#minted;
  }
}

export async function runAppCommand(action: string | undefined, positionals: string[], flags: Flags, deps: GatewayCliDeps): Promise<void> {
  const { admin } = await connect(deps);
  switch (action) {
    case "add": {
      const name = appName(positionals);
      const body = buildNew(flags);
      await rejectPoolPin(deps, body.provider, body.target, true);
      const url = await proxyUrl(deps, flags, name);
      const existing = await admin.call("GET", `/apps/${name}`, undefined, [404]);
      if (existing.status !== 404 && existing.json.state === "revoked") throw new RevokedAppError(revokedMessage(name, "add"));
      if (existing.status !== 404) throw new CliUsageError(`App "${name}" already exists; use: ais gateway app update ${name} to change settings, or ais gateway app rotate ${name} for a new token`);
      await admin.call("PUT", `/apps/${name}`, body);
      const minted = await admin.call("POST", `/apps/${name}/tokens`, {});
      await deliverToken(deps, name, body.namespace, url, mintedToken(minted.json));
      return;
    }
    case "list": {
      const { json } = await admin.call("GET", "/apps");
      const apps = (json.apps as Record<string, unknown>[]) ?? [];
      if (boolFlag(flags, "json")) return deps.out(JSON.stringify(json, null, 2));
      if (apps.length === 0) return deps.out("no apps");
      deps.out(table(["APP", "PROVIDER", "STYLE", "TARGET", "STATE", "NAMESPACE"], apps.map((a) => [str(a.name), str(a.provider), str(a.style), targetText(a.target), str(a.state), str(a.namespace)])));
      return;
    }
    case "show": {
      const { json } = await admin.call("GET", `/apps/${appName(positionals)}`);
      deps.out(JSON.stringify(json, null, 2));
      return;
    }
    case "update": {
      const name = appName(positionals);
      if (flags.identities !== undefined) throw new CliUsageError(POOL_LIST_REFUSED);
      const { json: cur } = await admin.call("GET", `/apps/${name}`);
      const body: AppBody = {
        owner: stringFlag(flags, "owner") ?? str(cur.owner),
        namespace: stringFlag(flags, "namespace") ?? str(cur.namespace),
        provider: stringFlag(flags, "provider") ?? str(cur.provider),
        style: stringFlag(flags, "style") ?? str(cur.style),
        target: targetFromFlags(flags, false) ?? currentTarget(cur.target),
      };
      await rejectPoolPin(deps, body.provider, body.target, stringFlag(flags, "identity") !== undefined);
      for (const k of ["models", "dailyTokens", "reservePercent"] as const) if (cur[k] !== undefined) (body as unknown as Record<string, unknown>)[k] = cur[k];
      applyOptional(body, flags);
      await admin.call("PUT", `/apps/${name}`, body);
      deps.out(`updated ${name}`);
      return;
    }
    case "rotate": {
      await rotateApp(admin, deps, flags, appName(positionals));
      return;
    }
    case "revoke": {
      const name = appName(positionals);
      await admin.call("POST", `/apps/${name}/revoke`);
      deps.out(`revoked ${name}: every token stopped working now; the name cannot be used again`);
      return;
    }
    default:
      throw new CliUsageError("Usage: ais gateway app add|list|show|update|rotate|revoke <name> ...");
  }
}

export async function runUsageCommand(flags: Flags, deps: GatewayCliDeps, positionals: string[] = []): Promise<void> {
  if (positionals[0] === "sessions") return runSessionCostCommand(flags, deps);
  if (positionals.length > 0) throw new CliUsageError("Usage: ais gateway usage [sessions] [flags]");
  const { admin } = await connect(deps);
  const q = new URLSearchParams();
  q.set("days", String(intFlag(flags, "days") ?? 7));
  const app = stringFlag(flags, "app");
  const provider = stringFlag(flags, "provider");
  if (app !== undefined) q.set("app", app);
  if (provider !== undefined) q.set("provider", provider);
  const { json } = await admin.call("GET", `/usage?${q.toString()}`);
  if (boolFlag(flags, "json")) return deps.out(JSON.stringify(json, null, 2));
  const rows = (json.usage as Record<string, unknown>[]) ?? [];
  if (rows.length === 0) return deps.out("no usage");
  deps.out(table(["APP", "PROVIDER", "DAYS", "TOKENS"], rows.map((r) => [str(r.app), str(r.provider), str(r.days), Number(r.tokens ?? 0).toLocaleString("en-GB")])));
}

/** `ais gateway usage sessions`: cost per session from the ledger (admin `GET /usage/sessions`). See session-cost.ts for the session and task rules. */
async function runSessionCostCommand(flags: Flags, deps: GatewayCliDeps): Promise<void> {
  const { admin } = await connect(deps);
  const q = new URLSearchParams();
  q.set("days", String(intFlag(flags, "days") ?? 7));
  for (const name of ["app", "provider", "prefix"] as const) {
    const v = stringFlag(flags, name);
    if (v !== undefined) q.set(name, v);
  }
  const prefix = stringFlag(flags, "prefix");
  if (prefix === "") throw new CliUsageError("--prefix must not be empty");
  // A repeated id would count its session twice when the list splits into several calls.
  const sessionIds = [...new Set((stringFlag(flags, "session") ?? "").split(",").map((v) => v.trim()).filter((v) => v !== ""))];
  const limit = intFlag(flags, "limit") ?? 50;
  if (!Number.isInteger(limit) || limit < 1) throw new CliUsageError("--limit must be a whole number of at least 1");
  // The admin takes at most 500 ids a call; a longer list goes in several calls and the answers are joined.
  const sessions: SessionUsage[] = [];
  for (let at = 0; at === 0 || at < sessionIds.length; at += 500) {
    const p = new URLSearchParams(q);
    for (const id of sessionIds.slice(at, at + 500)) p.append("session", id);
    const { json } = await admin.call("GET", `/usage/sessions?${p.toString()}`);
    // An older gateway ignores `prefix` and sends no cost fields. Both would give a wrong total with no warning, so refuse them.
    if (prefix !== undefined && json.prefix !== prefix) throw new Error("gateway admin is older than this CLI: it ignores --prefix. Update the gateway or use --session");
    const list = Array.isArray(json.sessions) ? (json.sessions as Array<{ identities?: Array<Record<string, unknown>> }>) : [];
    if (list.some((s) => (s.identities ?? []).some((i) => typeof i.estCostUsd !== "number"))) throw new Error("gateway admin is older than this CLI: it sends no cost fields. Update the gateway");
    sessions.push(...mapGatewaySessions(json));
  }
  const report = buildSessionCost(sessions);
  if (boolFlag(flags, "json")) return deps.out(JSON.stringify({ estimate: true, costUnit: "USD", sessions, ...report }, null, 2));
  deps.out(formatSessionCost(report, { limit, task: sessionIds.length > 0 || prefix !== undefined }));
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function targetText(t: unknown): string {
  const target = t as AppTarget | undefined;
  if (!target) return "";
  if (target.kind === "pin") return `pin:${target.identity}`;
  return "pool";
}

export function table(head: string[], rows: string[][]): string {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
