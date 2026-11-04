import { createHash, timingSafeEqual } from "node:crypto";
import type { GatewayStore } from "./store.ts";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const PREFIX_LEN = 8;
const SECRET_LEN = 43; // base64url of 32 bytes, no padding
const TOKEN_HEAD = "aisg_";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time check of a presented secret against a stored SHA-256 hex hash. */
export function sameHash(storedHex: string, secret: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const given = Buffer.from(hashSecret(secret), "hex");
  return stored.length === given.length && timingSafeEqual(stored, given);
}

export function generateToken(): { token: string; prefix: string; hash: string } {
  const p = crypto.getRandomValues(new Uint8Array(PREFIX_LEN));
  const prefix = Array.from(p, (b) => BASE32[b % 32]).join("");
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return { token: `${TOKEN_HEAD}${prefix}_${secret}`, prefix, hash: hashSecret(secret) };
}

export function parseToken(raw: string): { prefix: string; secret: string } | undefined {
  if (!raw.startsWith(TOKEN_HEAD)) return undefined;
  const rest = raw.slice(TOKEN_HEAD.length);
  const sep = rest.indexOf("_");
  if (sep !== PREFIX_LEN) return undefined;
  const prefix = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!/^[a-z2-7]+$/.test(prefix) || secret.length !== SECRET_LEN || !/^[A-Za-z0-9_-]+$/.test(secret)) return undefined;
  return { prefix, secret };
}

export async function verifyToken(
  store: GatewayStore,
  app: string,
  raw: string,
  now: Date,
): Promise<boolean> {
  const parsed = parseToken(raw);
  if (!parsed) return false;
  const record = await store.getApp(app);
  if (!record || record.state !== "active") return false;
  const given = Buffer.from(hashSecret(parsed.secret), "hex");
  let ok = false;
  for (const t of await store.tokensFor(app)) {
    if (t.prefix !== parsed.prefix) continue;
    const stored = Buffer.from(t.hash, "hex");
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) continue;
    if (t.expiresAt !== undefined) {
      const exp = Date.parse(t.expiresAt);
      if (Number.isNaN(exp) || exp <= now.getTime()) continue; // unparseable counts as expired
    }
    ok = true;
  }
  return ok;
}
