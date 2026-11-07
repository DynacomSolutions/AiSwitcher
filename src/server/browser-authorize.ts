import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { isRetired } from "../identities/retired.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { renderAuthorize, renderError } from "./browser-authorize-page.ts";

type Target = { kind: "pool"; pool: string } | { kind: "identity"; identity: string };

/** Config for the extension sign-in page. The admin token stays on the server and is never sent to the browser. */
export interface BrowserAuthConfig {
  /** Gateway proxy base URL (public pairing endpoints), including any path prefix. */
  proxyUrl: string;
  /** Gateway admin base URL, used server-side only. */
  adminUrl: string;
  adminToken: string;
  /** WebSocket base URL handed to the extension, including any path prefix. */
  relayUrl: string;
  /** Allowed Chrome extension ids; empty allows any well-formed id. */
  extensionIds: string[];
  fetch?: typeof fetch;
  targets?: () => Promise<{ pools: string[]; identities: string[] }>;
}

const MAX_LABEL = 80;
const MAX_STATE = 200;
const MAX_FORM_BYTES = 8192;
const REDIRECT_RE = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/[A-Za-z0-9._~\/-]*$/;
const STATE_RE = /^[A-Za-z0-9._~-]+$/;
const CSRF_COOKIE = "ais_authorize_csrf";

/** The redirect address if valid (and allowed), else a message naming the problem. */
export function checkRedirect(uri: string | null | undefined, allowed: readonly string[]): { ok: string } | { error: string } {
  const m = uri ? REDIRECT_RE.exec(uri) : null;
  if (!uri || !m) return { error: "The request has no valid extension redirect address." };
  if (allowed.length > 0 && !allowed.includes(m[1]!)) return { error: "This extension is not allowed to connect to this AIS." };
  return { ok: uri };
}

/** Builds the config from env (and ~/.secrets for the admin values); undefined when the gateway is not configured. */
export async function browserAuthFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BrowserAuthConfig | undefined> {
  const proxyUrl = env.AIS_GATEWAY_PROXY_URL;
  const adminUrl = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL")) ?? env.AIS_GATEWAY_ADMIN_URL;
  const adminToken = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN")) ?? env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!proxyUrl || !adminUrl || !adminToken) return undefined;
  const relayUrl = env.AIS_CONSOLE_GATEWAY_WSS_URL ?? proxyUrl.replace(/^http/, "ws");
  const extensionIds = (env.AIS_CONSOLE_EXTENSION_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { proxyUrl, adminUrl, adminToken, relayUrl, extensionIds };
}

export async function defaultTargets(): Promise<{ pools: string[]; identities: string[] }> {
  const pools = new Set<string>();
  const identities = new Set<string>();
  for (const cfg of Object.values(TOOL_CONFIGS)) {
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath).catch(() => undefined);
    for (const i of file?.identities ?? []) {
      if (isRetired(i)) continue;
      (isSwapPool(i) ? pools : identities).add(i.name);
    }
  }
  return { pools: [...pools].sort(), identities: [...identities].sort() };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
const sameText = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function readForm(req: Request): Promise<URLSearchParams | undefined> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return undefined;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(r.value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const cleanLabel = (raw: string | null | undefined): string => (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL) || "Chrome profile";
const trim = (u: string): string => u.replace(/\/+$/, "");

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self' https://*.chromiumapp.org; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * Creates a browser binding and token through the gateway: the public pairing start, the admin approve (with the
 * server-held bearer), then the pairing poll. Returns the one-time token. Throws an Error with a user-readable message.
 */
export async function approveViaGateway(cfg: BrowserAuthConfig, label: string, target: Target): Promise<{ token: string; binding: string; target: Target }> {
  const f = cfg.fetch ?? fetch;
  const json = { "content-type": "application/json" };
  let start: Response;
  try {
    start = await f(`${trim(cfg.proxyUrl)}/browser/pair`, { method: "POST", headers: json, body: JSON.stringify({ profileLabel: label }), signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("The AIS gateway is not reachable from the console.");
  }
  if (!start.ok) throw new Error(`The gateway refused to start pairing (HTTP ${start.status}).`);
  const { code, pollSecret } = (await start.json()) as { code?: string; pollSecret?: string };
  if (!code || !pollSecret) throw new Error("The gateway sent an unexpected pairing answer.");
  const approve = await f(`${trim(cfg.adminUrl)}/browser/pairings/${encodeURIComponent(code)}/approve`, {
    method: "POST", headers: { ...json, authorization: `Bearer ${cfg.adminToken}` }, body: JSON.stringify({ target }), signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("The AIS gateway admin is not reachable from the console."); });
  if (!approve.ok) {
    const msg = ((await approve.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(msg ? `The gateway refused: ${msg}.` : `The gateway refused the approval (HTTP ${approve.status}).`);
  }
  const poll = await f(`${trim(cfg.proxyUrl)}/browser/pair/poll`, { method: "POST", headers: json, body: JSON.stringify({ code, pollSecret }), signal: AbortSignal.timeout(10_000) });
  const body = (await poll.json().catch(() => ({}))) as { token?: string; binding?: string; target?: Target };
  if (!poll.ok || !body.token || !body.binding || !body.target) throw new Error("The gateway did not hand out a token.");
  return { token: body.token, binding: body.binding, target: body.target };
}

/**
 * GET/POST /browser/authorize, for the extension's launchWebAuthFlow. No login: the console sits on a private network
 * (owner decision). A double-submit CSRF cookie (SameSite=Strict) stops other sites approving, and the redirect must be
 * a chromiumapp.org address of an allowed extension.
 */
export function mountBrowserAuthorize(app: Hono, config: BrowserAuthConfig | undefined): void {
  const page = (html: string, status: 200 | 400 | 403 | 502 | 503 = 200, extra: Record<string, string> = {}): Response =>
    new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...HEADERS, ...extra } });
  const notConfigured = (): Response => page(renderError("Browser sign-in is not configured on this AIS (gateway URL, admin URL and admin token are missing)."), 503);

  app.get("/browser/authorize", async (c) => {
    if (!config) return notConfigured();
    const q = new URL(c.req.url).searchParams;
    const redirect = checkRedirect(q.get("redirect_uri"), config.extensionIds);
    if ("error" in redirect) return page(renderError(redirect.error), 400);
    const state = q.get("state") ?? "";
    if (!state || state.length > MAX_STATE || !STATE_RE.test(state)) return page(renderError("The request has no valid state."), 400);
    const targets = await (config.targets ?? defaultTargets)().catch(() => ({ pools: [] as string[], identities: [] as string[] }));
    const selected = targets.pools[0] ? `pool:${targets.pools[0]}` : targets.identities[0] ? `identity:${targets.identities[0]}` : "";
    if (!selected) return page(renderError("No pools or identities are set up on this AIS yet."), 400);
    const csrf = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https" ? "; Secure" : "";
    const html = renderAuthorize({ label: cleanLabel(q.get("label")), redirectUri: redirect.ok, state, csrf, pools: targets.pools, identities: targets.identities, selected });
    return page(html, 200, { "set-cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; SameSite=Strict; Path=/${secure}` });
  });

  app.post("/browser/authorize", async (c) => {
    if (!config) return notConfigured();
    const form = await readForm(c.req.raw);
    if (!form) return page(renderError("The form was not understood."), 400);
    const cookie = readCookie(c.req.header("cookie"), CSRF_COOKIE);
    const field = form.get("csrf");
    if (!cookie || !field || !sameText(cookie, field)) return page(renderError("This page expired or came from another site. Start again from the extension."), 403);
    const redirect = checkRedirect(form.get("redirect_uri"), config.extensionIds);
    if ("error" in redirect) return page(renderError(redirect.error), 400);
    const state = form.get("state") ?? "";
    if (!state || state.length > MAX_STATE || !STATE_RE.test(state)) return page(renderError("The request has no valid state."), 400);
    const go = (frag: Record<string, string>): Response =>
      new Response(null, { status: 302, headers: { location: `${redirect.ok}#${new URLSearchParams({ ...frag, state }).toString()}`, ...HEADERS } });
    if (form.get("action") !== "approve") return go({ error: "cancelled" });

    const raw = form.get("target") ?? "";
    const sep = raw.indexOf(":");
    const kind = raw.slice(0, sep);
    const name = raw.slice(sep + 1);
    if (sep < 0 || !name || (kind !== "pool" && kind !== "identity")) return page(renderError("Pick a pool or identity."), 400);
    try {
      const r = await approveViaGateway(config, cleanLabel(form.get("label")), kind === "pool" ? { kind, pool: name } : { kind, identity: name });
      return go({ token: r.token, binding: r.binding, gateway: config.relayUrl, target_kind: r.target.kind, target_name: r.target.kind === "pool" ? r.target.pool : r.target.identity });
    } catch (e) {
      return page(renderError(e instanceof Error ? e.message : "Approval failed."), 502);
    }
  });
}
