import type { GatewayDeps } from "./app.ts";
import { upstreamHeaders } from "./app.ts";
import { providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import { availableCount, claudeUsageBody, type AccountOp } from "./routes.ts";
import { allowedMembers, utilisationOf } from "./select.ts";
import type { ApiStyle, GatewayApp } from "./types.ts";

/**
 * Account-feature requests (usage, reset credits, profile, plugins, ...) forwarded to the provider with the REAL login of the member
 * the app maps to. The client only ever holds the gateway token; the member's token is added here and never returned.
 *
 * Which member: a pinned app uses its identity. A pool app uses the member that OWNS the resource when the request names one (a
 * claude reset grant id; a codex account with an unspent reset credit), else the member the pool would route to now (lowest
 * utilisation; a member with no figure after those with one). The reserve is not applied: an account call is exactly what a user
 * makes when the account is full (spending a reset credit).
 */

/** Largest account request body held in memory; account calls carry a few hundred bytes. */
export const ACCOUNT_BODY_LIMIT = 1024 * 1024;
const ORG_TTL_MS = 10 * 60_000;
const CLAUDE_BASE = "https://api.anthropic.com";
const CLAUDE_RESETS_PROBE = `${CLAUDE_BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/** Per-gateway memory: each member's organisation uuid (learned from its own profile). */
export interface AccountState {
  orgs: Map<string, { org: string; until: number }>;
}

export function newAccountState(): AccountState {
  return { orgs: new Map() };
}

export interface AccountRequest {
  app: GatewayApp;
  deps: GatewayDeps;
  state: AccountState;
  op: AccountOp;
  method: string;
  /** The provider URL without query string. */
  url: string;
  /** `?a=b` or "". */
  search: string;
  /** The client's headers (the adapter replaces the credential ones). */
  headers: Headers;
  body: Uint8Array | undefined;
  style: ApiStyle;
  signal: AbortSignal;
}

export interface AccountResult {
  res: Response;
  /** The member whose login was used, when one was chosen. */
  identity?: string;
  /** What kind of call this was, for the log. Never contains an id or a token. */
  cls: string;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One call as `name`: the member's login, one locked refresh and retry on 401. */
async function callAs(r: AccountRequest, name: string, init: { method: string; url: string; body?: Uint8Array }): Promise<Response> {
  const provider = r.app.provider;
  const adapter = adapterFor(provider);
  let cred = await r.deps.creds.get(provider, name);
  const send = (c: typeof cred): Promise<Response> => {
    if (r.signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const req: RequestInit = { method: init.method, headers: upstreamHeaders(adapter, c, r.headers), signal: r.signal, redirect: "manual" };
    if (init.body && init.body.length > 0 && init.method !== "GET" && init.method !== "HEAD") req.body = init.body;
    return r.deps.fetch(init.url, req);
  };
  let res = await send(cred);
  if (res.status === 401 && adapter.refreshable) {
    try {
      cred = await r.deps.creds.refreshAfter401(provider, name, cred.accessToken);
    } catch {
      return res; // the provider's 401 goes to the client
    }
    await discard(res);
    res = await send(cred);
  }
  return res;
}

async function canon(r: AccountRequest, name: string): Promise<string> {
  try {
    return (await r.deps.canonical?.(r.app.provider, name)) ?? name;
  } catch {
    return name;
  }
}

/** Members by utilisation, lowest first; members without a figure after those with one. */
async function ranked(r: AccountRequest, names: string[]): Promise<string[]> {
  const rows = await Promise.all(
    names.map(async (n, i) => {
      let util: number | undefined;
      try {
        util = utilisationOf(await r.deps.usageFor(r.app.provider, n));
      } catch {
        util = undefined;
      }
      return { n, i, util };
    }),
  );
  rows.sort((a, b) => (a.util ?? Infinity) - (b.util ?? Infinity) || a.i - b.i);
  return rows.map((x) => x.n);
}

type OwnerFinder = (names: string[]) => Promise<string | undefined>;

async function chooseMember(r: AccountRequest, owner?: OwnerFinder): Promise<string | undefined> {
  if (r.app.target.kind === "pin") return canon(r, r.app.target.identity);
  let names: string[];
  try {
    names = await allowedMembers(r.app, r.deps);
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  if (owner && names.length > 1) {
    const o = await owner(names).catch(() => undefined);
    if (o) return canon(r, o);
  }
  const first = (await ranked(r, names))[0];
  return first === undefined ? undefined : canon(r, first);
}

/** The first of `names` (in order) for which `test` holds on a GET of `url` as that member. */
async function firstMemberWhere(r: AccountRequest, names: string[], url: string, test: (body: unknown) => boolean): Promise<string | undefined> {
  const probe = new Headers(r.headers);
  probe.delete("content-type");
  const probeReq: AccountRequest = { ...r, headers: probe, body: undefined };
  const hits = await Promise.all(
    names.map(async (n) => {
      try {
        const res = await callAs(probeReq, n, { method: "GET", url });
        if (!res.ok) {
          await discard(res);
          return false;
        }
        return test(await res.json().catch(() => undefined));
      } catch {
        return false;
      }
    }),
  );
  const at = hits.findIndex(Boolean);
  return at === -1 ? undefined : names[at];
}

function grantIds(body: unknown): string[] {
  const grants = (body as { cedar_ember?: { grants?: unknown } } | undefined)?.cedar_ember?.grants;
  return Array.isArray(grants) ? grants.map((g) => (g as { id?: unknown } | undefined)?.id).filter((id): id is string => typeof id === "string") : [];
}

function jsonField(body: Uint8Array | undefined, field: string): string | undefined {
  if (!body || body.length === 0) return undefined;
  try {
    const v = (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> | null)?.[field];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The member's own organisation uuid, from its profile (kept 10 minutes). */
async function memberOrg(r: AccountRequest, name: string): Promise<string | undefined> {
  const key = `${r.app.provider}/${name}`;
  const nowMs = r.deps.now().getTime();
  const hit = r.state.orgs.get(key);
  if (hit && hit.until > nowMs) return hit.org;
  const probe = new Headers(r.headers);
  probe.delete("content-type");
  try {
    const res = await callAs({ ...r, headers: probe, body: undefined }, name, { method: "GET", url: `${CLAUDE_BASE}/api/oauth/profile` });
    if (!res.ok) {
      await discard(res);
      return undefined;
    }
    const org = ((await res.json().catch(() => undefined)) as { organization?: { uuid?: unknown } } | undefined)?.organization?.uuid;
    if (typeof org !== "string" || org === "") return undefined;
    r.state.orgs.set(key, { org, until: nowMs + ORG_TTL_MS });
    return org;
  } catch {
    return undefined;
  }
}

/** The provider's answer, without its connection-level headers. */
function relay(res: Response): Response {
  const headers = new Headers();
  for (const h of ["content-type", "retry-after", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Query holds `cedar_ember` switched on. */
function wantsResets(search: string): boolean {
  const v = new URLSearchParams(search).get("cedar_ember");
  return v !== null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Forwards one account request. Never throws except for a client that has left. */
export async function forwardAccount(r: AccountRequest): Promise<AccountResult> {
  const cls = `${r.app.provider}:${r.op}`;
  try {
    return await run(r, cls);
  } catch (err) {
    if (r.signal.aborted) throw err;
    return { res: providerError(r.style, 502, "account request failed"), cls };
  }
}

async function run(r: AccountRequest, cls: string): Promise<AccountResult> {
  const noMember = (): AccountResult => ({ res: providerError(r.style, 503, "no login is available for this app"), cls });
  let url = r.url;
  let owner: OwnerFinder | undefined;

  if (r.op === "claude-usage" && r.app.target.kind === "pool") {
    // Pool: the served windows of the member the pool would use; the real reset grants of that member merged in when asked for.
    const ctx = { app: r.app, cache: {}, style: r.style, deps: r.deps, signal: r.signal };
    const served = await claudeUsageBody(ctx);
    if (!wantsResets(r.search)) return { res: json(served), cls };
    const member = await chooseMember(r);
    if (!member) return { res: json(served), cls };
    try {
      const res = await callAs(r, member, { method: "GET", url: r.url + r.search });
      if (res.ok) {
        const cedar = ((await res.json().catch(() => undefined)) as { cedar_ember?: unknown } | undefined)?.cedar_ember;
        if (cedar !== undefined) served.cedar_ember = cedar;
      } else await discard(res);
    } catch {
      if (r.signal.aborted) throw new DOMException("aborted", "AbortError");
    }
    return { res: json(served), identity: member, cls };
  }

  let rewriteOrg = false;
  if (r.op === "claude-org") {
    const m = /^\/api\/organizations\/([^/]+)(\/.*)$/i.exec(new URL(url).pathname);
    rewriteOrg = m !== null;
    const grant = m?.[2] === "/reset_rate_limits" && r.method === "POST" ? jsonField(r.body, "grant_id") : undefined;
    if (grant) owner = (names) => firstMemberWhere(r, names, CLAUDE_RESETS_PROBE, (b) => grantIds(b).includes(grant));
  } else if (r.op === "codex-consume") {
    owner = (names) => firstMemberWhere(r, names, CODEX_CREDITS_URL, (b) => (availableCount(b) ?? 0) > 0);
  }

  const member = await chooseMember(r, owner);
  if (!member) return noMember();

  if (rewriteOrg) {
    const org = await memberOrg(r, member);
    const u = new URL(url);
    const m = /^\/api\/organizations\/([^/]+)(\/.*)$/i.exec(u.pathname);
    if (org && m && decodeURIComponent(m[1]!) !== org) url = `${u.origin}/api/organizations/${encodeURIComponent(org)}${m[2]}`;
  }
  const res = await callAs(r, member, { method: r.method, url: url + r.search, ...(r.body ? { body: r.body } : {}) });
  return { res: relay(res), identity: member, cls };
}
