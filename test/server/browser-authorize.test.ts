import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { checkRedirect, mountBrowserAuthorize, type BrowserAuthConfig } from "../../src/server/browser-authorize.ts";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${EXT}.chromiumapp.org/cb`;

interface Call { url: string; method: string; auth: string | null; body: unknown }

function setup(over: Partial<BrowserAuthConfig> = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), body });
    if (url.endsWith("/browser/pair")) return Response.json({ code: "ABCD2345", pollSecret: "ps", expiresAt: "x" });
    if (url.includes("/approve")) return Response.json({ binding: { name: "work" } });
    if (url.endsWith("/browser/pair/poll")) return Response.json({ binding: "work", token: "tok-value", target: body && { kind: "pool", pool: "pool-one" } });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const config: BrowserAuthConfig = {
    proxyUrl: "http://gw.example.com/gateway", adminUrl: "http://admin.example.com", adminToken: "adm-value", relayUrl: "wss://ais.example.com/gateway",
    extensionIds: [], fetch: fakeFetch, targets: async () => ({ pools: ["pool-one", "other"], identities: ["solo"] }), ...over,
  };
  const app = new Hono();
  mountBrowserAuthorize(app, config);
  return { app, calls };
}

const get = (app: Hono, redirect = REDIRECT, state = "st4te") =>
  app.request(`http://ais.example.com/browser/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=${state}&label=${encodeURIComponent("me@example.com")}`);

async function page(app: Hono) {
  const res = await get(app);
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { res, html, csrf, cookie };
}

const post = (app: Hono, fields: Record<string, string>, cookie: string) =>
  app.request("http://ais.example.com/browser/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(fields).toString(), redirect: "manual" });

describe("redirect_uri validation", () => {
  test("accepts only https extension ids", () => {
    expect(checkRedirect(REDIRECT, [])).toEqual({ ok: REDIRECT });
    for (const bad of [null, "", "http://" + EXT + ".chromiumapp.org/cb", `https://${EXT}.chromiumapp.org.evil.example/cb`, `https://evil.example/${EXT}.chromiumapp.org/`, `https://${EXT.toUpperCase()}.chromiumapp.org/cb`, `https://abc.chromiumapp.org/cb`, `https://${EXT}.chromiumapp.org/cb?x=1`, `https://${EXT}.chromiumapp.org/cb#x`, `https://qrstuvwxyzqrstuvwxyzqrstuvwxyzqr.chromiumapp.org/cb`]) {
      expect("error" in checkRedirect(bad, [])).toBe(true);
    }
  });
  test("allowlist limits extension ids", () => {
    expect("error" in checkRedirect(REDIRECT, ["ponmlkjihgfedcbaponmlkjihgfedcba"])).toBe(true);
    expect(checkRedirect(REDIRECT, [EXT])).toEqual({ ok: REDIRECT });
  });
});

describe("GET /browser/authorize", () => {
  test("shows the label, defaults to the first pool, sets a csrf cookie", async () => {
    const { app } = setup();
    const { res, html, csrf, cookie } = await page(app);
    expect(res.status).toBe(200);
    expect(html).toContain("me@example.com");
    expect(html).toContain('<option value="pool:pool-one" selected>');
    expect(csrf.length).toBeGreaterThan(20);
    expect(cookie).toBe(`ais_authorize_csrf=${csrf}`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Strict");
  });
  test("escapes the label", async () => {
    const { app } = setup();
    const res = await app.request(`http://ais.example.com/browser/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&label=${encodeURIComponent("<script>x</script>")}`);
    expect(await res.text()).not.toContain("<script>x");
  });
  test("rejects a bad redirect or state", async () => {
    const { app } = setup();
    expect((await get(app, "https://evil.example/cb")).status).toBe(400);
    expect((await get(app, REDIRECT, "bad state!")).status).toBe(400);
  });
  test("503 when the gateway is not configured", async () => {
    const app = new Hono();
    mountBrowserAuthorize(app, undefined);
    expect((await get(app)).status).toBe(503);
  });
});

describe("POST /browser/authorize", () => {
  test("happy path: pairs, approves with the admin step server-side, redirects with the credential in the fragment", async () => {
    const { app, calls } = setup();
    const { csrf, cookie } = await page(app);
    const res = await post(app, { csrf, redirect_uri: REDIRECT, state: "st4te", label: "me@example.com", target: "pool:pool-one", action: "approve" }, cookie);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.search).toBe("");
    const frag = new URLSearchParams(loc.hash.slice(1));
    expect(frag.get("token")).toBe("tok-value");
    expect(frag.get("state")).toBe("st4te");
    expect(frag.get("gateway")).toBe("wss://ais.example.com/gateway");
    expect(calls.map((c) => c.url)).toEqual(["http://gw.example.com/gateway/browser/pair", "http://admin.example.com/browser/pairings/ABCD2345/approve", "http://gw.example.com/gateway/browser/pair/poll"]);
    expect(calls[0]!.auth).toBeNull();
    expect(calls[1]!.auth).toBe(["Bearer", "adm-value"].join(" "));
    expect(calls[1]!.body).toEqual({ target: { kind: "pool", pool: "pool-one" } });
    expect(await res.text()).not.toContain("adm-value");
  });
  test("cancel redirects with an error and calls no gateway", async () => {
    const { app, calls } = setup();
    const { csrf, cookie } = await page(app);
    const res = await post(app, { csrf, redirect_uri: REDIRECT, state: "s", target: "pool:pool-one", action: "cancel" }, cookie);
    expect(res.headers.get("location")).toBe(`${REDIRECT}#error=cancelled&state=s`);
    expect(calls).toEqual([]);
  });
  test("a missing or wrong csrf token is refused", async () => {
    const { app, calls } = setup();
    const { csrf, cookie } = await page(app);
    const fields = { redirect_uri: REDIRECT, state: "s", target: "pool:pool-one", action: "approve" };
    expect((await post(app, { ...fields, csrf: "nope" }, cookie)).status).toBe(403);
    expect((await post(app, { ...fields, csrf }, "")).status).toBe(403);
    expect((await post(app, fields, cookie)).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test("a bad redirect_uri on POST is refused even with a valid csrf", async () => {
    const { app, calls } = setup();
    const { csrf, cookie } = await page(app);
    const res = await post(app, { csrf, redirect_uri: "https://evil.example/cb", state: "s", target: "pool:pool-one", action: "approve" }, cookie);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
  test("a gateway refusal shows an error and never redirects", async () => {
    const f = (async (url: string) => (url.endsWith("/browser/pair") ? Response.json({ code: "C", pollSecret: "p" }) : Response.json({ error: "not a known swap pool" }, { status: 400 }))) as unknown as typeof fetch;
    const { app } = setup({ fetch: f });
    const { csrf, cookie } = await page(app);
    const res = await post(app, { csrf, redirect_uri: REDIRECT, state: "s", target: "pool:pool-one", action: "approve" }, cookie);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not a known swap pool");
  });
});
