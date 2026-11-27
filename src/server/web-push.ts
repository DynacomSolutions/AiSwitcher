import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type webcrypto } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { consoleWebDir } from "./state.ts";

/**
 * Web Push from the console daemon, with no third-party library: VAPID
 * (RFC 8292) signs a short ES256 JWT for the push service, and the payload is
 * encrypted for the browser with aes128gcm (RFC 8291 / RFC 8188). The browser's
 * push service (Google, Mozilla, Apple) only ever sees ciphertext.
 *
 * State lives in the console state dir: the VAPID key pair (`push-vapid.json`)
 * and the browsers that asked for notifications (`push-subscriptions.json`),
 * both mode 0600. The subscription endpoint is a capability URL, so it is
 * treated like a secret: never logged, never returned by the API.
 */

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Origin of the console page that subscribed; the VAPID `sub` claim. */
  origin?: string;
  createdAt: string;
}

interface VapidFile {
  publicKey: string;
  privateJwk: webcrypto.JsonWebKey;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string;
  /** Console path the notification opens. */
  url?: string;
  poolAlert?: "review" | "dismiss";
}

export interface SendResult {
  sent: number;
  /** Subscriptions the push service reported gone (404/410); already removed. */
  removed: number;
  failed: number;
}

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

export function vapidPath(dir: string = consoleWebDir()): string {
  return join(dir, "push-vapid.json");
}

export function subscriptionsPath(dir: string = consoleWebDir()): string {
  return join(dir, "push-subscriptions.json");
}

async function writePrivate(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.partial`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

let vapidCache: { dir: string; file: VapidFile } | undefined;

/** The daemon's VAPID key pair, created on first use. */
export async function loadVapid(dir: string = consoleWebDir()): Promise<VapidFile> {
  if (vapidCache?.dir === dir) return vapidCache.file;
  let file: VapidFile | undefined;
  try {
    const parsed = JSON.parse(await readFile(vapidPath(dir), "utf8")) as Partial<VapidFile>;
    if (typeof parsed.publicKey === "string" && parsed.privateJwk && typeof parsed.privateJwk === "object") file = parsed as VapidFile;
  } catch {
    // Missing or unreadable: make a new pair below.
  }
  if (!file) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]));
    file = { publicKey, privateJwk: jwk };
    await writePrivate(vapidPath(dir), file);
  }
  vapidCache = { dir, file };
  return file;
}

export async function loadSubscriptions(dir: string = consoleWebDir()): Promise<PushSubscriptionRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(subscriptionsPath(dir), "utf8")) as { subscriptions?: unknown };
    return Array.isArray(parsed.subscriptions) ? (parsed.subscriptions as PushSubscriptionRecord[]).filter((s) => typeof s?.endpoint === "string") : [];
  } catch {
    return [];
  }
}

async function saveSubscriptions(list: PushSubscriptionRecord[], dir: string): Promise<void> {
  await writePrivate(subscriptionsPath(dir), { subscriptions: list });
}

/** Validates a browser PushSubscription JSON; undefined when it is not one. */
export function parseSubscription(raw: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof r.endpoint !== "string" || r.endpoint.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(r.endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return undefined;
  if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length < 16) return undefined;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

export async function addSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  origin: string | undefined,
  dir: string = consoleWebDir(),
  now: Date = new Date(),
): Promise<number> {
  const list = (await loadSubscriptions(dir)).filter((s) => s.endpoint !== sub.endpoint);
  list.push({ ...sub, ...(origin ? { origin } : {}), createdAt: now.toISOString() });
  await saveSubscriptions(list, dir);
  return list.length;
}

export async function removeSubscription(endpoint: string, dir: string = consoleWebDir()): Promise<boolean> {
  const list = await loadSubscriptions(dir);
  const kept = list.filter((s) => s.endpoint !== endpoint);
  if (kept.length === list.length) return false;
  await saveSubscriptions(kept, dir);
  return true;
}

export async function hasSubscription(endpoint: string, dir: string = consoleWebDir()): Promise<boolean> {
  return (await loadSubscriptions(dir)).some((s) => s.endpoint === endpoint);
}

const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 8291 aes128gcm body for one subscription: header (salt, rs, keyid) then a single record. */
export function encryptPayload(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: { salt?: Buffer; asPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64url(uaPublicB64);
  const authSecret = fromB64url(authSecretB64);
  const ecdh = createECDH("prime256v1");
  if (opts.asPrivateKey) ecdh.setPrivateKey(opts.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, vapid: VapidFile, subject: string, nowS: number = Math.floor(Date.now() / 1000)): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: nowS + 12 * 3600, sub: subject })}`;
  const key = createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * The VAPID contact claim. AIS_PUSH_SUBJECT wins; otherwise the https origin of
 * the console page that subscribed (the push service only needs a URL or mailto).
 */
export function vapidSubject(sub: PushSubscriptionRecord, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AIS_PUSH_SUBJECT?.trim();
  if (configured) return configured;
  if (sub.origin?.startsWith("https://")) return sub.origin;
  return "mailto:ais-console@localhost";
}

export interface SendDeps {
  dir?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** Sends one message to every subscribed browser; drops subscriptions the push service says are gone. */
export async function sendToAll(message: PushMessage, deps: SendDeps = {}): Promise<SendResult> {
  const dir = deps.dir ?? consoleWebDir();
  const subs = await loadSubscriptions(dir);
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (subs.length === 0) return result;
  const vapid = await loadVapid(dir);
  const doFetch = deps.fetchImpl ?? fetch;
  const payload = Buffer.from(JSON.stringify(message));
  const gone: string[] = [];
  for (const sub of subs) {
    try {
      const res = await doFetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: vapidAuthorization(sub.endpoint, vapid, vapidSubject(sub)),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(24 * 3600),
          Urgency: "normal",
        },
        body: encryptPayload(payload, sub.keys.p256dh, sub.keys.auth),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404 || res.status === 410) {
        gone.push(sub.endpoint);
      } else if (res.ok) {
        result.sent++;
      } else {
        result.failed++;
        // Host only: the endpoint path is a capability URL.
        deps.log?.(`push: ${new URL(sub.endpoint).host} answered HTTP ${res.status}`);
      }
    } catch (error) {
      result.failed++;
      deps.log?.(`push: ${new URL(sub.endpoint).host} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (gone.length > 0) {
    const latest = await loadSubscriptions(dir);
    await saveSubscriptions(latest.filter((s) => !gone.includes(s.endpoint)), dir);
    result.removed = gone.length;
  }
  return result;
}
