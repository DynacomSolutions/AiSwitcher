import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { BrowserBinding, BrowserPairing } from "../../browser/types.ts";
import { generateToken, hashSecret } from "../tokens.ts";
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

/** Fixed-window-per-client limiter held in memory (single replica). */
export class PairRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly now: () => number, private readonly limit = PAIR_LIMIT, private readonly windowMs = PAIR_WINDOW_MS) {}

  allow(key: string): boolean {
    const t = this.now();
    for (const [k, v] of this.hits) {
      const kept = v.filter((x) => t - x < this.windowMs);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
    const mine = this.hits.get(key) ?? [];
    if (mine.length >= this.limit) return false;
    mine.push(t);
    this.hits.set(key, mine);
    return true;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = JSON.parse(await req.text());
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function sameHash(storedHex: string, secret: string): boolean {
  const a = Buffer.from(storedHex, "hex");
  const b = Buffer.from(hashSecret(secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** First hop of x-forwarded-for, else the connection's remote address (`env.ip`, set by the server). */
function clientIp(req: Request, env: unknown): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  const ip = isObj(env) && typeof env.ip === "string" ? env.ip : "";
  return ip || "unknown";
}

/** Public pairing routes, mounted at /browser. */
export function createPairRoutes(deps: BrowserDeps): Hono {
  const hono = new Hono();
  const limiter = new PairRateLimiter(() => deps.now().getTime());
  const delivering = new Set<string>();

  hono.post("/pair", async (c) => {
    if (!limiter.allow(clientIp(c.req.raw, c.env))) return c.json({ error: "too many pairing requests" }, 429);
    const body = await readJson(c.req.raw);
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
      tokenDelivered: false,
    };
    await deps.store.putPairing(pairing);
    return c.json({ code, pollSecret, expiresAt: pairing.expiresAt });
  });

  hono.post("/pair/poll", async (c) => {
    const body = await readJson(c.req.raw);
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
    if (delivering.has(code)) return c.json({ pending: true }, 202);
    delivering.add(code);
    try {
      const binding: BrowserBinding | undefined = await deps.store.getBrowserBinding(pairing.approvedBinding);
      if (!binding || binding.state !== "active") {
        await deps.store.deletePairing(code);
        return c.json({ error: "binding revoked" }, 410);
      }
      const t = generateToken();
      await deps.store.addBrowserToken(binding.name, t.prefix, t.hash);
      await deps.store.deletePairing(code);
      deps.metrics?.browserPairing();
      // The only time the token is ever returned.
      return c.json({ binding: binding.name, token: t.token, target: binding.target });
    } finally {
      delivering.delete(code);
    }
  });

  return hono;
}
