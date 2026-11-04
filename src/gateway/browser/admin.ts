import type { Hono } from "hono";
import type { BrowserBinding, BrowserTarget } from "../../browser/types.ts";
import { generateToken } from "../tokens.ts";
import { BINDING_NAME, type BrowserDeps } from "./deps.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_IDENTITY = 200;

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  return text.trim() === "" ? {} : JSON.parse(text);
}

function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "browser";
}

/** Validates the target, or returns a message naming the problem. Unknown pools are refused. */
async function parseTarget(deps: BrowserDeps, raw: unknown): Promise<BrowserTarget | string> {
  if (!isObj(raw)) return "target is required";
  if (raw.kind === "identity") {
    if (typeof raw.identity !== "string" || !raw.identity || raw.identity.length > MAX_IDENTITY) return "target.identity is required";
    const canonical = deps.browserIdentityExists ? await deps.browserIdentityExists(raw.identity) : raw.identity;
    if (canonical === undefined) return `identity "${raw.identity}" is not a known identity`;
    return { kind: "identity", identity: canonical };
  }
  if (raw.kind === "pool") {
    if (typeof raw.pool !== "string" || !raw.pool || raw.pool.length > MAX_IDENTITY) return "target.pool is required";
    const members = await deps.browserPoolMembers?.(raw.pool);
    if (members === undefined) return `"${raw.pool}" is not a known swap pool`;
    return { kind: "pool", pool: raw.pool };
  }
  return "target.kind must be identity or pool";
}

/** Admin routes for browser pairing, bindings and agent tokens. Mount behind the admin bearer check. */
export function registerBrowserAdmin(hono: Hono, deps: BrowserDeps): void {
  const { store } = deps;
  const err = (status: 400 | 404 | 409 | 410, message: string): Response => Response.json({ error: message }, { status });

  hono.post("/browser/pairings/:code/approve", async (c) => {
    const code = c.req.param("code");
    let raw: unknown;
    try {
      raw = await readJson(c.req.raw);
    } catch {
      return err(400, "body is not valid JSON");
    }
    if (!isObj(raw)) return err(400, "body must be a JSON object");
    const pairing = await store.getPairing(code);
    if (!pairing) return err(404, "no such pairing");
    if (Date.parse(pairing.expiresAt) <= deps.now().getTime()) return err(410, "pairing expired");
    if (pairing.approvedBinding !== undefined) return err(409, "pairing already approved");
    const target = await parseTarget(deps, raw.target);
    if (typeof target === "string") return err(400, target);
    let name: string;
    if (raw.name !== undefined) {
      if (typeof raw.name !== "string" || !BINDING_NAME.test(raw.name)) return err(400, "name must be 1 to 63 lowercase letters, digits or -, start and end with a letter or digit");
      if (await store.getBrowserBinding(raw.name)) return err(409, "a binding with that name exists");
      name = raw.name;
    } else {
      const base = slug(pairing.profileLabel);
      name = base;
      for (let i = 2; await store.getBrowserBinding(name); i++) name = `${base}-${i}`;
    }
    const binding: BrowserBinding = { name, target, profileLabel: pairing.profileLabel, state: "active", createdAt: deps.now().toISOString() };
    await store.putBrowserBinding(binding);
    await store.putPairing({ ...pairing, approvedBinding: name });
    return c.json({ binding });
  });

  hono.get("/browser/bindings", async (c) => c.json({ bindings: await store.listBrowserBindings() }));

  hono.delete("/browser/bindings/:name", async (c) => {
    const name = c.req.param("name");
    if (!(await store.getBrowserBinding(name))) return err(404, "no such binding");
    await store.revokeBrowserBinding(name);
    deps.hub?.revoke(name);
    return c.json({ binding: name, state: "revoked" });
  });

  hono.post("/browser/agents/:identity/tokens", async (c) => {
    const identity = c.req.param("identity");
    if (!identity || identity.length > MAX_IDENTITY) return err(400, "identity is required");
    const canonical = deps.browserIdentityExists ? await deps.browserIdentityExists(identity) : identity;
    if (canonical === undefined) return err(404, "no such identity");
    await store.revokeAgentTokens(canonical);
    const t = generateToken();
    await store.addAgentToken({ identity: canonical, prefix: t.prefix, hash: t.hash, createdAt: deps.now().toISOString() });
    // The only time the token is ever returned.
    return c.json({ token: t.token });
  });

  hono.delete("/browser/agents/:identity/tokens", async (c) => {
    const given = c.req.param("identity");
    const canonical = (await deps.browserIdentityExists?.(given)) ?? given;
    await store.revokeAgentTokens(canonical);
    if (canonical !== given) await store.revokeAgentTokens(given);
    return c.json({ identity: canonical, revoked: true });
  });
}
