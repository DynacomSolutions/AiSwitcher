import { Hono } from "hono";
import type { BrowserBinding, BrowserPairing } from "../../browser/types.ts";
import { generateToken, hashSecret, sameHash } from "../tokens.ts";
import type { BrowserDeps } from "./deps.ts";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIR_LIMIT = 10;
export const PAIR_WINDOW_MS = 60_000;
const MAX_LABEL = 80;

export function generatePairingCode(): string {
  let out = "";
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < CODE_LEN) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/**
 * Sliding-window limiter held in memory (single replica). A call only touches its own key; idle keys are swept
 * at most once per window, so cost per call stays amortised constant.
 */
export class PairRateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(private readonly now: () => number, private readonly limit = PAIR_LIMIT, private readonly windowMs = PAIR_WINDOW_MS) {}

  allow(key: string): boolean {
    const t = this.now();
    if (t - this.lastSweep >= this.windowMs) {
      this.lastSweep = t;
      for (const [k, v] of this.hits) if (t - (v[v.length - 1] ?? 0) >= this.windowMs) this.hits.delete(k);
    }
    const mine = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (mine.length >= this.limit) {
      this.hits.set(key, mine);
      return false;
    }
    mine.push(t);
    this.hits.set(key, mine);
    return true;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_BODY_BYTES = 4096;

class BodyTooLarge extends Error {}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(r.value);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The rightmost x-forwarded-for entry (the proxy in front appends the real peer; earlier entries are client
 * controlled), else the connection's remote address (`env.ip`, set by the server).
 */
function clientIp(req: Request, env: unknown): string {
  const hops = req.headers.get("x-forwarded-for")?.split(",");
  const last = hops?.[hops.length - 1]?.trim();
  if (last) return last;
  const ip = isObj(env) && typeof env.ip === "string" ? env.ip : "";
  return ip || "unknown";
}

/** Public pairing routes, mounted at /browser. */
export function createPairRoutes(deps: BrowserDeps): Hono {
  const hono = new Hono();
  const limiter = new PairRateLimiter(() => deps.now().getTime());
  // Polls are frequent (the extension waits for approval), so they get a roomier bucket: 60 per minute per client.
  const pollLimiter = new PairRateLimiter(() => deps.now().getTime(), 60);
  const tooLarge = (c: { json: (b: unknown, s: 413) => Response }): Response => c.json({ error: "request body too large" }, 413);

  hono.post("/pair", async (c) => {
    if (!limiter.allow(clientIp(c.req.raw, c.env))) return c.json({ error: "too many pairing requests" }, 429);
    let body: Record<string, unknown> | undefined;
    try {
      body = await readJson(c.req.raw);
    } catch {
      return tooLarge(c);
    }
    const label = body?.profileLabel;
    if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL) return c.json({ error: `profileLabel is required (1 to ${MAX_LABEL} characters)` }, 400);
    let code = generatePairingCode();
    for (let i = 0; i < 5 && (await deps.store.getPairing(code)); i++) code = generatePairingCode();
    const pollSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const now = deps.now();
    const pairing: BrowserPairing = {
      code,
      profileLabel: label.trim(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
      pollSecretHash: hashSecret(pollSecret),
    };
    await deps.store.putPairing(pairing);
    return c.json({ code, pollSecret, expiresAt: pairing.expiresAt });
  });

  hono.post("/pair/poll", async (c) => {
    if (!pollLimiter.allow(clientIp(c.req.raw, c.env))) return c.json({ error: "too many poll requests" }, 429);
    let body: Record<string, unknown> | undefined;
    try {
      body = await readJson(c.req.raw);
    } catch {
      return tooLarge(c);
    }
    const code = body?.code;
    const secret = body?.pollSecret;
    if (typeof code !== "string" || typeof secret !== "string") return c.json({ error: "code and pollSecret are required" }, 400);
    const pairing = await deps.store.getPairing(code);
    // A wrong secret looks the same as an unknown code.
    if (!pairing || !sameHash(pairing.pollSecretHash, secret)) return c.json({ error: "no such pairing" }, 404);
    if (Date.parse(pairing.expiresAt) <= deps.now().getTime()) {
      await deps.store.deletePairing(code);
      return c.json({ error: "pairing expired" }, 410);
    }
    if (pairing.approvedBinding === undefined) return c.json({ pending: true }, 202);
    const binding: BrowserBinding | undefined = await deps.store.getBrowserBinding(pairing.approvedBinding);
    if (!binding || binding.state !== "active") {
      await deps.store.deletePairing(code);
      return c.json({ error: "binding revoked" }, 410);
    }
    // Atomic claim: of concurrent polls, exactly one gets the pairing and so the token.
    if (!(await deps.store.claimPairing(code))) return c.json({ error: "no such pairing" }, 404);
    const t = generateToken();
    await deps.store.addBrowserToken(binding.name, t.prefix, t.hash);
    deps.metrics?.browserPairing();
    // The only time the token is ever returned.
    return c.json({ binding: binding.name, token: t.token, target: binding.target });
  });

  return hono;
}
