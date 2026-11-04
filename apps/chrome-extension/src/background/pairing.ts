// Gateway URL rules, settings storage and the pairing flow. Token is stored only after the poll succeeds.
import type { BrowserTarget } from "../../../../src/browser/types.ts";
import type { ChromeApi } from "./chrome-api.ts";

export const KEYS = { gatewayUrl: "gatewayUrl", profileLabel: "profileLabel", token: "token", binding: "binding", target: "target" } as const;
export const POLL_INTERVAL_MS = 2000;

export class PairingError extends Error {}

/** Returns a normalised base URL (no trailing slash) or throws. wss:// required except localhost/127.0.0.1. */
export function validateGatewayUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new PairingError("Gateway URL is not a valid URL"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "wss:") { /* ok */ } else if (u.protocol === "ws:" && local) { /* ok */ } else {
    throw new PairingError("Gateway URL must use wss:// (ws:// is only allowed for localhost)");
  }
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

export const connectUrl = (base: string): string => `${base}/browser/connect`;
export const httpBase = (base: string): string => base.replace(/^ws/, "http");

export interface StoredSettings { gatewayUrl?: string; profileLabel?: string; token?: string; binding?: string; target?: BrowserTarget }

export async function loadSettings(storage: ChromeApi["storage"]): Promise<StoredSettings> {
  const r = await storage.get(Object.values(KEYS));
  const out: StoredSettings = {};
  if (typeof r[KEYS.gatewayUrl] === "string") out.gatewayUrl = r[KEYS.gatewayUrl] as string;
  if (typeof r[KEYS.profileLabel] === "string") out.profileLabel = r[KEYS.profileLabel] as string;
  if (typeof r[KEYS.token] === "string") out.token = r[KEYS.token] as string;
  if (typeof r[KEYS.binding] === "string") out.binding = r[KEYS.binding] as string;
  if (r[KEYS.target]) out.target = r[KEYS.target] as BrowserTarget;
  return out;
}

export async function clearToken(storage: ChromeApi["storage"]): Promise<void> {
  await storage.remove([KEYS.token, KEYS.binding, KEYS.target]);
}

/** Save the gateway URL. A changed URL invalidates the token (it belongs to the old gateway). */
export async function saveGatewayUrl(storage: ChromeApi["storage"], raw: string): Promise<string> {
  const url = validateGatewayUrl(raw);
  const prev = (await storage.get([KEYS.gatewayUrl]))[KEYS.gatewayUrl];
  if (prev !== url) await clearToken(storage);
  await storage.set({ [KEYS.gatewayUrl]: url });
  return url;
}

export interface PairingStart { code: string; pollSecret: string; expiresAt: string }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function startPairing(fetchFn: Fetch, gatewayUrl: string, profileLabel: string): Promise<PairingStart> {
  const base = validateGatewayUrl(gatewayUrl);
  const res = await fetchFn(`${httpBase(base)}/browser/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileLabel }) });
  if (res.status === 429) throw new PairingError("Too many pairing attempts, wait a minute and try again");
  if (!res.ok) throw new PairingError(`Gateway refused pairing (HTTP ${res.status})`);
  const body = (await res.json()) as Partial<PairingStart>;
  if (typeof body.code !== "string" || typeof body.pollSecret !== "string" || typeof body.expiresAt !== "string") throw new PairingError("Unexpected pairing response");
  return { code: body.code, pollSecret: body.pollSecret, expiresAt: body.expiresAt };
}

export interface PollDeps {
  fetch: Fetch;
  storage: ChromeApi["storage"];
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Polls every 2 s until approval (stores token) or expiry (throws). */
export async function pollPairing(deps: PollDeps, gatewayUrl: string, start: PairingStart): Promise<{ binding: string; target: BrowserTarget }> {
  const base = validateGatewayUrl(gatewayUrl);
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  for (;;) {
    if (deps.signal?.aborted) throw new PairingError("Pairing cancelled");
    const res = await deps.fetch(`${httpBase(base)}/browser/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: start.code, pollSecret: start.pollSecret }) });
    if (res.status === 200) {
      const body = (await res.json()) as { binding?: string; token?: string; target?: BrowserTarget };
      if (!body.binding || !body.token || !body.target) throw new PairingError("Unexpected poll response");
      await deps.storage.set({ [KEYS.token]: body.token, [KEYS.binding]: body.binding, [KEYS.target]: body.target });
      return { binding: body.binding, target: body.target };
    }
    if (res.status === 429) {
      if (Date.parse(start.expiresAt) < Date.now()) throw new PairingError("Pairing code expired, start again");
      await sleep(POLL_INTERVAL_MS * 2);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new PairingError("Pairing code expired or unknown, start again");
    if (res.status !== 202) throw new PairingError(`Unexpected poll status ${res.status}`);
    if (Date.parse(start.expiresAt) < Date.now()) throw new PairingError("Pairing code expired, start again");
    await sleep(POLL_INTERVAL_MS);
  }
}
