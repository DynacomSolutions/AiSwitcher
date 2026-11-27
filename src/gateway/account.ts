import type { GatewayDeps } from "./app.ts";
import { upstreamHeaders } from "./app.ts";
import { GatewayCredentialError } from "./credentials.ts";
import { GATEWAY_ERROR_HEADER, GATEWAY_UPSTREAM_HEADER, providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import { bounded } from "./refresh-guard.ts";
import { availableCount, claudeUsageBody, claudeUsageBodyOf, normalisePath, orgSegmentIndex, syntheticClaudeProfile, type AccountOp } from "./routes.ts";
import { allowedMembers, utilisationOf } from "./select.ts";
import { CODEX_CREDITS_URL, codexCreditIds, codexResetInventory, fetchCodexCreditInventory } from "./usage-source.ts";
import type { ProviderCredential } from "./providers/shared.ts";
import type { ApiStyle, GatewayApp } from "./types.ts";

/**
 * Account-feature requests (usage, reset credits, profile, plugins, ...) forwarded to the provider with the REAL login of the member
 * the app maps to. The client only ever holds the gateway token; the member's token is added here and never returned.
 *
 * Which member: a pinned app uses its identity. A pool app uses the member that OWNS the resource when the request names one (a
 * claude reset grant id; a codex account with an unspent reset credit), else the member the pool would route to now (lowest
 * utilisation; a member with no figure after those with one). The reserve is not applied: an account call is exactly what a user
 * makes when the account is full (spending a reset credit).
 *
 * Exception: a pool app's `GET /api/oauth/profile` is answered by the gateway itself (a profile made up from the app name, no
 * upstream call, no member login), so a pool never shows a member's real email and T3 Code lists each pool as its own row.
 */

/** Largest account request body held in memory; account calls carry a few hundred bytes. */
export const ACCOUNT_BODY_LIMIT = 1024 * 1024;
const ORG_TTL_MS = 10 * 60_000;
const CLAUDE_BASE = "https://api.anthropic.com";
const CLAUDE_RESETS_PROBE = `${CLAUDE_BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`;

/** Per-gateway memory: each member's organisation uuid (learned from its own profile). */
export interface AccountState {
  orgs: Map<string, { org: string; until: number }>;
  /** Last good `GET /api/oauth/usage` body per member and query (pinned apps), with the time it was read. */
  usage: Map<string, { body: Uint8Array; at: number }>;
}

export function newAccountState(): AccountState {
  return { orgs: new Map(), usage: new Map() };
}

/** A pinned usage read younger than this is served from the gateway without calling Anthropic. */
export const PIN_USAGE_FRESH_MS = 30_000;
/** How long a last good usage body may stand in for Anthropic's 429 (its usage API rate-limits per account). */
export const PIN_USAGE_STALE_MAX_MS = 6 * 3_600_000;
/** The gateway's own usage poll of a member counts as fresh for a plain pinned read for this long. */
export const PIN_POLL_FRESH_MS = 5 * 60_000;

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

export interface CodexPostContext {
  credential: ProviderCredential;
  creditId?: string;
  redeemRequestId?: string;
  inventory(): Promise<unknown>;
  signal?: AbortSignal;
  retryAfter401?: boolean;
}

export type BeforeCodexPost = (identity: string, context: CodexPostContext) => Promise<void>;

export class CodexResetFenced extends Error {
  readonly status = 409;

  constructor(message = "This reset credit was already attempted. Check current limits.") {
    super(message);
  }
}

export class CodexResetOutcomePending extends CodexResetFenced {
  constructor() {
    super("A previous reset on this Codex account has an unresolved outcome.");
  }
}

export type CodexResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

/** Serialises gateway redemptions and records the reset generation before the provider POST. */
export type CodexRedemptionGuard = <T>(run: (beforePost: BeforeCodexPost) => Promise<T>, automatic?: boolean) => Promise<T>;

export interface CodexCreditSelection {
  id: string;
  endsAt: string;
  signal: AbortSignal;
  now: () => number;
  stillCurrent(): boolean;
  stillEligible(): Promise<boolean>;
  onPost(): void;
  onKnownOutcome?(creditId: string, outcome: CodexResetOutcome): Promise<void>;
  finishPostAfterDeadline?: boolean;
}

/** Spends one Codex reset on this exact stored member. The consume request is sent once. */
export async function consumeCodexResetForIdentity(
  identity: string,
  redeemRequestId: string,
  deps: Pick<GatewayDeps, "creds" | "fetch"> & { credential?: ProviderCredential; signal?: AbortSignal },
  selection?: CodexCreditSelection,
  beforePost?: BeforeCodexPost,
): Promise<{ identity: string; result: CodexResetOutcome; windowsReset: number; creditId?: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(redeemRequestId)) {
    throw Object.assign(new Error("A valid reset request ID is required"), { status: 400 });
  }
  const adapter = adapterFor("codex");
  const signal = selection?.signal ?? deps.signal;
  signal?.throwIfAborted();
  const credential = deps.credential ?? await deps.creds.get("codex", identity);
  if (credential.identity !== identity) throw Object.assign(new Error("Codex credential identity did not match the requested account"), { status: 409 });
  const operationSignal = () => signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  signal?.throwIfAborted();
  let credits: Response;
  try {
    credits = await deps.fetch(CODEX_CREDITS_URL, {
      method: "GET",
      headers: upstreamHeaders(adapter, credential, new Headers({ accept: "application/json" })),
      signal: operationSignal(),
      redirect: "manual",
    });
  } catch {
    throw Object.assign(new Error("Codex reset credits could not be checked"), { status: 502 });
  }
  if (!credits.ok) {
    await discard(credits);
    throw Object.assign(new Error(`Codex reset credits answered HTTP ${credits.status}`), { status: credits.status === 403 ? 403 : 502 });
  }
  const inventory = await credits.json().catch(() => undefined);
  if (availableCount(inventory) === undefined) throw Object.assign(new Error("Codex reset credits could not be verified"), { status: 502 });

  if (selection) {
    if (!await selection.stillEligible()) return { identity, result: "no_credit", windowsReset: 0 };
    const now = selection.now();
    const available = codexResetInventory(inventory, now, "automatic");
    const matches = available?.creditExpiries?.filter(({ id }) => id === selection.id);
    if (!available?.availableCount || !matches?.length || matches.some(({ endsAt }) => endsAt !== selection.endsAt || Date.parse(endsAt) <= now)) {
      return { identity, result: "no_credit", windowsReset: 0 };
    }
    selection.signal.throwIfAborted();
  }

  signal?.throwIfAborted();
  const request: RequestInit = {
    method: "POST",
    headers: upstreamHeaders(adapter, credential, new Headers({ accept: "application/json", "content-type": "application/json" })),
    body: JSON.stringify({ redeem_request_id: redeemRequestId, ...(selection ? { credit_id: selection.id } : {}) }),
    redirect: "manual",
  };
  await beforePost?.(identity, {
    credential,
    creditId: selection?.id,
    redeemRequestId,
    inventory: async () => inventory,
    signal,
  });
  if (selection && !selection.stillCurrent()) return { identity, result: "no_credit", windowsReset: 0 };
  signal?.throwIfAborted();
  request.signal = !selection || selection.finishPostAfterDeadline ? AbortSignal.timeout(10_000) : operationSignal();
  let spent: Response;
  try {
    selection?.onPost();
    spent = await deps.fetch(`${CODEX_CREDITS_URL}/consume`, request);
  } catch {
    throw Object.assign(new Error("Codex reset outcome is unknown. Refresh limits before another attempt."), { status: 502 });
  }
  if (!spent.ok && !selection) await discard(spent);
  const response = spent.ok || selection
    ? await spent.json().catch(() => undefined) as { code?: unknown; windows_reset?: unknown; credit?: { id?: unknown } } | undefined
    : undefined;
  const rawCreditId = response?.credit?.id;
  const reportedId = selection && typeof rawCreditId === "string" && rawCreditId.trim() ? rawCreditId : undefined;
  if (!spent.ok) {
    const manualStatus = [400, 403, 404, 409, 429].includes(spent.status) ? spent.status : 502;
    throw Object.assign(new Error(`Codex refused the reset (HTTP ${spent.status})`), {
      status: selection ? spent.status : manualStatus, creditedId: reportedId,
    });
  }
  const code = response?.code;
  const windowsReset = response?.windows_reset === undefined && !selection ? 0 : response?.windows_reset;
  const hasCredit = response != null && Object.hasOwn(response, "credit");
  const unknownOutcome = () => new Error("Codex reset outcome is unknown. Refresh limits before another attempt.");
  if ((code !== "reset" && code !== "nothing_to_reset" && code !== "no_credit" && code !== "already_redeemed") ||
      typeof windowsReset !== "number" || !Number.isSafeInteger(windowsReset) || windowsReset < 0 ||
      (selection && hasCredit && reportedId === undefined)) {
    throw Object.assign(unknownOutcome(), { status: 502, creditedId: reportedId });
  }
  // The standard response omits credit. The requested credit ID is then the effective credit ID.
  const creditId = reportedId ?? selection?.id;
  if (creditId !== undefined && selection?.onKnownOutcome) {
    const record = selection.onKnownOutcome;
    const write = () => bounded(record(creditId, code), 2_000, "Codex reset outcome journal");
    try {
      await write().catch(write);
    } catch {
      throw Object.assign(unknownOutcome(), { status: 502, creditedId: creditId, knownOutcome: code });
    }
  }
  return { identity, result: code, windowsReset, ...(creditId === undefined ? {} : { creditId }) };
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
async function callAs(
  r: AccountRequest,
  name: string,
  init: { method: string; url: string; body?: Uint8Array },
  beforePost?: (credential: ProviderCredential, retryAfter401: boolean) => Promise<void>,
): Promise<Response> {
  r.signal.throwIfAborted();
  const provider = r.app.provider;
  const adapter = adapterFor(provider);
  let cred = await r.deps.creds.get(provider, name);
  const send = async (credential: ProviderCredential, retryAfter401 = false): Promise<Response> => {
    r.signal.throwIfAborted();
    const req: RequestInit = { method: init.method, headers: upstreamHeaders(adapter, credential, r.headers), signal: r.signal, redirect: "manual" };
    if (init.body && init.body.length > 0 && init.method !== "GET" && init.method !== "HEAD") req.body = init.body;
    if (beforePost) await beforePost(credential, retryAfter401);
    r.signal.throwIfAborted();
    return r.deps.fetch(init.url, req);
  };
  const res = await send(cred);
  if (res.status !== 401 || !adapter.refreshable) return res;
  try {
    cred = await r.deps.creds.refreshAfter401(provider, name, cred.accessToken);
  } catch {
    return res;
  }
  await discard(res);
  return send(cred, true);
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
  // A failed lookup (unreadable registry, failed login check) is a server-side failure: it throws, and the caller answers 502.
  let names = await allowedMembers(r.app, r.deps);
  // Same filter as pickIdentity: drop logged-out members. A probe error keeps the member.
  const creds = r.deps.creds;
  if (creds?.loggedOut) {
    const alive = await Promise.all(names.map(async (n) => ((await creds.loggedOut!(r.app.provider, n).catch(() => false)) ? undefined : n)));
    names = alive.filter((n): n is string => n !== undefined);
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
async function firstMemberWhere(r: AccountRequest, names: string[], url: string, test: (body: unknown) => boolean, prefer?: (body: unknown) => boolean): Promise<string | undefined> {
  const probe = new Headers(r.headers);
  probe.delete("content-type");
  const probeReq: AccountRequest = { ...r, headers: probe, body: undefined };
  const hits = await Promise.all(
    names.map(async (n) => {
      try {
        const res = await callAs(probeReq, n, { method: "GET", url });
        if (!res.ok) {
          await discard(res);
          return 0;
        }
        const body = await res.json().catch(() => undefined);
        return prefer?.(body) ? 2 : test(body) ? 1 : 0;
      } catch {
        return 0;
      }
    }),
  );
  const at = hits.indexOf(hits.includes(2) ? 2 : 1);
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
  } catch (err) {
    // A member without a usable login is the client's case (409), not an upstream failure.
    if (err instanceof GatewayCredentialError && NO_LOGIN_CODES.has(err.code)) throw err;
    return undefined;
  }
}

/** The provider's answer, without its connection-level headers. */
function relay(res: Response, provider: string): Response {
  const headers = new Headers({ [GATEWAY_UPSTREAM_HEADER]: provider });
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

const NO_LOGIN_CODES: ReadonlySet<string> = new Set(["no-credential", "unknown-identity", "retired", "login-dead", "unmanaged-login"]);

/** Forwards one account request. Never throws except for a client that has left. */
export async function forwardAccount(r: AccountRequest): Promise<AccountResult> {
  const cls = `${r.app.provider}:${r.op}`;
  try {
    return await run(r, cls);
  } catch (err) {
    if (r.signal.aborted) throw err;
    if (err instanceof CodexResetOutcomePending) return { res: providerError(r.style, 409, err.message, "reset_outcome_pending"), cls };
    if (err instanceof CodexResetFenced) return { res: providerError(r.style, 409, err.message, "reset_already_attempted"), cls };
    // A member without a usable login is the client's case (4xx with the reason), never a server error.
    if (err instanceof GatewayCredentialError && NO_LOGIN_CODES.has(err.code)) return { res: providerError(r.style, 409, r.app.target.kind === "pin" ? err.clientMessage : "no login is available for this app", "no_login"), cls };
    return { res: providerError(r.style, 502, "the account request to the provider failed", "account_request_failed"), cls };
  }
}

async function run(r: AccountRequest, cls: string): Promise<AccountResult> {
  const noMember = (): AccountResult => ({ res: providerError(r.style, 409, "no login is available for this app", "no_login"), cls });
  let url = r.url;
  let owner: OwnerFinder | undefined;

  if (r.op === "claude-usage" && r.app.target.kind === "pool") {
    // Pool: the served windows of the member the pool would use; the real reset grants of that member merged in when asked for.
    const ctx = { app: r.app, cache: {}, style: r.style, deps: r.deps, signal: r.signal };
    const served = await claudeUsageBody(ctx);
    if (!wantsResets(r.search)) return { res: json(served), cls };
    let member: string | undefined;
    try {
      member = await chooseMember(r);
    } catch {
      member = undefined;
    }
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

  // Pool: the profile is made up per app, with no upstream call and no member login. A member's real email would make T3 Code
  // merge the usage rows of several pools into one.
  if (r.method === "GET" && r.app.target.kind !== "pin" && r.app.provider === "claude" && r.op === "forward" && normalisePath(new URL(url).pathname)?.norm === "/api/oauth/profile") {
    return { res: syntheticClaudeProfile(r.app, "Claude"), cls };
  }

  let orgAt = -1;
  let segs: string[] = [];
  if (r.op === "claude-org") {
    const u = new URL(url);
    const n = normalisePath(u.pathname);
    orgAt = n ? orgSegmentIndex(n.nsegs) : -1;
    if (!n || orgAt < 0) return { res: providerError(r.style, 502, "the account organisation could not be found", "account_org_unavailable"), cls }; // fail closed
    segs = n.segs;
    const grant = r.method === "POST" && n.nsegs[orgAt + 1] === "reset_rate_limits" && n.nsegs.length === orgAt + 2 ? jsonField(r.body, "grant_id") : undefined;
    if (grant) owner = (names) => firstMemberWhere(r, names, CLAUDE_RESETS_PROBE, (b) => grantIds(b).includes(grant));
  } else if (r.op === "codex-consume") {
    const redeem = async (beforePost?: BeforeCodexPost): Promise<AccountResult> => {
      r.signal.throwIfAborted();
      const creditId = jsonField(r.body, "credit_id") || undefined;
      const member = await chooseMember(r, (names) => firstMemberWhere(
        r, names, CODEX_CREDITS_URL, (b) => (availableCount(b) ?? 0) > 0,
        creditId ? (b) => codexCreditIds(b).ids.has(creditId) : undefined,
      ));
      if (!member) return noMember();
      const res = await callAs(r, member, { method: r.method, url: url + r.search, body: r.body }, beforePost && (async (credential, retryAfter401) => {
        if (credential.identity !== member) throw new Error("Codex credential does not match the requested account");
        await beforePost(member, {
          credential,
          creditId,
          inventory: () => fetchCodexCreditInventory(credential, r.deps.fetch, r.signal),
          signal: r.signal,
          retryAfter401,
        });
      }));
      return { res: relay(res, r.app.provider), identity: member, cls };
    };
    return r.deps.withCodexRedemption ? r.deps.withCodexRedemption(redeem) : redeem();
  }

  const member = await chooseMember(r, owner);
  if (!member) return noMember();

  if (orgAt >= 0) {
    // The organisation sent upstream is always the member's own; if it cannot be read, nothing is sent.
    const org = await memberOrg(r, member);
    if (!org) return { res: providerError(r.style, 502, "the account organisation could not be found", "account_org_unavailable"), identity: member, cls };
    const out = [...segs];
    out[1] = "api";
    if (orgAt === 4) out[2] = "oauth";
    out[orgAt - 1] = "organizations";
    out[orgAt] = encodeURIComponent(org);
    url = `${new URL(url).origin}${out.join("/")}`;
  }
  if (r.op === "claude-usage") return pinnedUsage(r, member, url, cls);
  if (r.op === "forward" && r.method === "GET" && r.app.target.kind === "pin" && normalisePath(new URL(url).pathname)?.norm === "/api/oauth/profile") return pinnedProfile(r, member, url, cls);
  const res = await callAs(r, member, { method: r.method, url: url + r.search, ...(r.body ? { body: r.body } : {}) });
  return { res: relay(res, r.app.provider), identity: member, cls };
}

/**
 * Pinned profile read. The member's own profile is forwarded. When Anthropic refuses it (401, 403, 429, 5xx) or cannot be
 * reached, the client gets a profile made up from the app name instead of the error: Claude Code treats a failed profile
 * read as "no subscription known" and then hides limits. Other answers (404 and so on) pass through.
 */
async function pinnedProfile(r: AccountRequest, member: string, url: string, cls: string): Promise<AccountResult> {
  let res: Response | undefined;
  try {
    res = await callAs(r, member, { method: r.method, url: url + r.search });
  } catch (err) {
    if (r.signal.aborted) throw err;
  }
  if (res && !(res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500)) return { res: relay(res, r.app.provider), identity: member, cls };
  if (res) await discard(res);
  return { res: syntheticClaudeProfile(r.app, "Claude"), identity: member, cls };
}

/** The member's gateway poll reading when it has the Claude windows, with its age; else undefined. */
async function pollReading(r: AccountRequest, member: string, nowMs: number): Promise<{ body: Record<string, unknown>; ageMs: number; stale: boolean } | undefined> {
  try {
    const u = await r.deps.usageFor(r.app.provider, member);
    if (!u || !u.windows?.some((w) => w.label === "five-hour" || w.label === "seven-day")) return undefined;
    const at = Date.parse(u.capturedAt);
    return { body: claudeUsageBodyOf(u), ageMs: Number.isFinite(at) ? Math.max(0, nowMs - at) : Infinity, stale: u.stale === true || u.status !== "live" };
  } catch {
    return undefined;
  }
}

/**
 * Pinned usage read. Anthropic's usage API answers 429 per account when it is read often (the gateway's own usage poll
 * shares the token), and a client then shows no limits and no reset credits. Reads are shared for a short while, and a
 * last good body or the gateway poll reading stands in for a 429 or an error, so the client keeps its limits and resets.
 */
async function pinnedUsage(r: AccountRequest, member: string, url: string, cls: string): Promise<AccountResult> {
  const resets = wantsResets(r.search);
  const key = `${r.app.provider}/${member}?${resets ? "resets" : "plain"}`;
  const nowMs = r.deps.now().getTime();
  const hit = r.state.usage.get(key);
  const cached = (): AccountResult => ({ res: new Response(hit!.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }), identity: member, cls });
  if (hit && nowMs - hit.at < PIN_USAGE_FRESH_MS) return cached();
  // The gateway's own poll (every replica has it) answers a plain read while it is fresh. A read for reset grants needs Anthropic: the poll has none.
  const poll = await pollReading(r, member, nowMs);
  const fromPoll = (): AccountResult => ({ res: new Response(JSON.stringify(poll!.body), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }), identity: member, cls });
  if (!resets && poll && !poll.stale && poll.ageMs < PIN_POLL_FRESH_MS) return fromPoll();
  /** Last good body or poll reading for an Anthropic failure; undefined when there is neither. */
  const fallback = (): AccountResult | undefined => {
    if (hit && nowMs - hit.at < PIN_USAGE_STALE_MAX_MS) return cached();
    if (poll && poll.ageMs < PIN_USAGE_STALE_MAX_MS) return fromPoll();
    return undefined;
  };
  let res: Response;
  try {
    res = await callAs(r, member, { method: r.method, url: url + r.search });
  } catch (err) {
    if (r.signal.aborted) throw err;
    const covered = fallback();
    if (covered) return covered;
    throw err;
  }
  if (res.ok) {
    const body = new Uint8Array(await res.arrayBuffer());
    r.state.usage.set(key, { body, at: nowMs });
    return { res: new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } }), identity: member, cls };
  }
  if (res.status === 429 || res.status >= 500) {
    await discard(res);
    const covered = fallback();
    if (covered) return covered;
    // Claude Code remembers a 429 (and 401, 403) per bearer for about an hour, but not a 5xx: never relay Anthropic's 429.
    const unavailable = json({ type: "error", error: { type: "api_error", message: "AIS gateway: usage is temporarily unavailable" } }, 503);
    unavailable.headers.set(GATEWAY_ERROR_HEADER, "usage_unavailable");
    return { res: unavailable, identity: member, cls };
  }
  return { res: relay(res, r.app.provider), identity: member, cls };
}

/** Reads a request body of at most `cap` bytes; undefined once the cap is passed (the rest is not read). */
export async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
