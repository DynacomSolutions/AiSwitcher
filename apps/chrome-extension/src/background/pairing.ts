// Settings storage and the browser sign-in flow (chrome.identity.launchWebAuthFlow against the AIS console).
import type { BrowserTarget } from "../../../../src/browser/types.ts";
import type { ChromeApi } from "./chrome-api.ts";

export const KEYS = { gatewayUrl: "gatewayUrl", consoleUrl: "consoleUrl", profileLabel: "profileLabel", token: "token", binding: "binding", target: "target", installId: "installId" } as const;

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

/** The AIS URL the user typed, normalised (no trailing slash, query or fragment), or undefined if it is not usable. https only, except localhost. */
export function parseConsoleUrl(raw: string): string | undefined {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return undefined; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return undefined;
  if (!u.hostname || u.username || u.password) return undefined;
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

export const connectUrl = (base: string): string => `${base}/browser/connect`;

export interface StoredSettings { gatewayUrl?: string; consoleUrl?: string; profileLabel?: string; token?: string; binding?: string; target?: BrowserTarget }

export async function loadSettings(storage: ChromeApi["storage"]): Promise<StoredSettings> {
  const r = await storage.get(Object.values(KEYS));
  const out: StoredSettings = {};
  if (typeof r[KEYS.gatewayUrl] === "string") out.gatewayUrl = r[KEYS.gatewayUrl] as string;
  if (typeof r[KEYS.consoleUrl] === "string") out.consoleUrl = r[KEYS.consoleUrl] as string;
  if (typeof r[KEYS.profileLabel] === "string") out.profileLabel = r[KEYS.profileLabel] as string;
  if (typeof r[KEYS.token] === "string") out.token = r[KEYS.token] as string;
  if (typeof r[KEYS.binding] === "string") out.binding = r[KEYS.binding] as string;
  if (r[KEYS.target]) out.target = r[KEYS.target] as BrowserTarget;
  return out;
}

export async function clearToken(storage: ChromeApi["storage"]): Promise<void> {
  await storage.remove([KEYS.token, KEYS.binding, KEYS.target]);
}

/** "macOS", "Windows", "Linux", "ChromeOS" or "Android" from a platform string; "computer" if unknown. */
export function platformName(raw: string): string {
  const p = raw.toLowerCase();
  if (p.includes("cros")) return "ChromeOS";
  if (p.includes("android")) return "Android";
  if (p.includes("mac")) return "macOS";
  if (p.includes("win")) return "Windows";
  if (p.includes("linux")) return "Linux";
  return "computer";
}

/** A stable per-install id, created once and kept in storage. */
export async function ensureInstallId(storage: ChromeApi["storage"]): Promise<string> {
  const have = (await storage.get([KEYS.installId]))[KEYS.installId];
  if (typeof have === "string" && have) return have;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, "0")).join("");
  await storage.set({ [KEYS.installId]: id });
  return id;
}

/** The profile label taken from Chrome: the signed-in account email, else "Chrome on <platform> <short id>". Max 80 characters. */
export async function autoProfileLabel(storage: ChromeApi["storage"], getEmail: () => Promise<string | undefined>, platform: string): Promise<string> {
  const email = (await getEmail().catch(() => undefined))?.trim();
  if (email) return email.slice(0, 80);
  return `Chrome on ${platformName(platform)} ${await ensureInstallId(storage)}`;
}

export function authorizeUrl(consoleUrl: string, redirectUri: string, state: string, label: string): string {
  const q = new URLSearchParams({ redirect_uri: redirectUri, state, label });
  return `${consoleUrl}/browser/authorize?${q.toString()}`;
}

export const UNREACHABLE_MESSAGE = "Cannot reach that AIS address. Check the URL, and that you are on the right network (for example Tailscale or your VPN).";

export interface SignInDeps {
  storage: ChromeApi["storage"];
  /** chrome.identity.launchWebAuthFlow: resolves to the final redirect URL, rejects when the user closes the window or the page cannot load. */
  launch(url: string): Promise<string | undefined>;
  redirectUri: string;
  getEmail(): Promise<string | undefined>;
  platform: string;
  /** Random state generator; tests inject a fixed one. */
  newState?: () => string;
}

/** Runs the whole sign-in: opens the console page, checks the state, stores the token, the gateway URL and the console URL. */
export async function signIn(deps: SignInDeps, rawUrl: string): Promise<{ binding: string; target: BrowserTarget; label: string }> {
  const consoleUrl = parseConsoleUrl(rawUrl);
  if (!consoleUrl) throw new PairingError("Enter the https address of your AIS, for example https://ais.example.com");
  const state = (deps.newState ?? (() => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("")))();
  const label = await autoProfileLabel(deps.storage, deps.getEmail, deps.platform);
  let result: string | undefined;
  try {
    result = await deps.launch(authorizeUrl(consoleUrl, deps.redirectUri, state, label));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/did not approve|cancel|closed/i.test(msg)) throw new PairingError("Sign-in was cancelled.");
    throw new PairingError(UNREACHABLE_MESSAGE);
  }
  if (!result) throw new PairingError("Sign-in was cancelled.");
  const hash = result.includes("#") ? result.slice(result.indexOf("#") + 1) : "";
  const p = new URLSearchParams(hash);
  if (p.get("state") !== state) throw new PairingError("Sign-in answer did not match this request. Try again.");
  if (p.get("error")) throw new PairingError(p.get("error") === "cancelled" ? "Sign-in was cancelled." : "Sign-in was refused.");
  const token = p.get("token");
  const binding = p.get("binding");
  const gateway = p.get("gateway");
  if (!token || !binding || !gateway) throw new PairingError("The AIS answered without a token. Is browser sign-in set up on it?");
  const gatewayUrl = validateGatewayUrl(gateway);
  const name = p.get("target_name") ?? "";
  const target: BrowserTarget = p.get("target_kind") === "identity" ? { kind: "identity", identity: name } : { kind: "pool", pool: name };
  await deps.storage.set({ [KEYS.gatewayUrl]: gatewayUrl, [KEYS.consoleUrl]: consoleUrl, [KEYS.profileLabel]: label, [KEYS.binding]: binding, [KEYS.target]: target, [KEYS.token]: token });
  return { binding, target, label };
}
