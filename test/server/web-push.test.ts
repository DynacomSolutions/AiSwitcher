import { afterAll, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import {
  addSubscription,
  encryptPayload,
  loadSubscriptions,
  loadVapid,
  parseSubscription,
  sendToAll,
  subscriptionsPath,
  vapidAuthorization,
  vapidPath,
} from "../../src/server/web-push.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ais-web-push-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** A browser-side key pair and the RFC 8291 decryption a user agent performs. */
function fakeBrowser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const record = body.subarray(21 + idlen);
    expect(rs).toBe(4096);
    const shared = ecdh.computeSecret(asPublic);
    const prkKey = hmac(auth, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    expect(plain[plain.length - 1]).toBe(2);
    return plain.subarray(0, plain.length - 1).toString();
  };
  return { keys, decrypt };
}

describe("RFC 8291 payload encryption", () => {
  test("a browser holding the subscription keys decrypts the payload", () => {
    const browser = fakeBrowser();
    const body = encryptPayload(Buffer.from('{"title":"hi"}'), browser.keys.p256dh, browser.keys.auth);
    expect(browser.decrypt(body)).toBe('{"title":"hi"}');
  });

  test("matches the RFC 8291 Appendix A test vector byte for byte", () => {
    const body = encryptPayload(
      Buffer.from("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24", "base64url"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), asPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url") },
    );
    const header = Buffer.from("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", "base64url");
    const ciphertext = Buffer.from("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ", "base64url");
    expect(body.equals(Buffer.concat([header, ciphertext]))).toBe(true);
  });

  test("each message uses a fresh salt and sender key", () => {
    const browser = fakeBrowser();
    const a = encryptPayload(Buffer.from("x"), browser.keys.p256dh, browser.keys.auth);
    const b = encryptPayload(Buffer.from("x"), browser.keys.p256dh, browser.keys.auth);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });
});

describe("VAPID", () => {
  test("keys are created once, stored 0600, and reused", async () => {
    const dir = tempDir();
    const first = await loadVapid(dir);
    expect(Buffer.from(first.publicKey, "base64url").length).toBe(65);
    expect(statSync(vapidPath(dir)).mode & 0o777).toBe(0o600);
    expect((await loadVapid(dir)).publicKey).toBe(first.publicKey);
  });

  test("the JWT is ES256-signed for the push service origin and verifies with the public key", async () => {
    const dir = tempDir();
    const vapid = await loadVapid(dir);
    const header = vapidAuthorization("https://push.example.com/send/abc", vapid, "https://console.example.com", 1_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, p, sig, k] = match!;
    expect(k).toBe(vapid.publicKey);
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ aud: "https://push.example.com", exp: 1_000_000 + 12 * 3600, sub: "https://console.example.com" });
    const pub = Buffer.from(k!, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("subscriptions", () => {
  const browser = fakeBrowser();
  const sub = { endpoint: "https://push.example.com/send/SYNTHETIC_FIXTURE_1", keys: browser.keys };

  test("only https endpoints with real key sizes are accepted", () => {
    expect(parseSubscription(sub)).toEqual(sub);
    expect(parseSubscription({ ...sub, endpoint: "http://push.example.com/x" })).toBeUndefined();
    expect(parseSubscription({ ...sub, keys: { p256dh: "AAAA", auth: browser.keys.auth } })).toBeUndefined();
    expect(parseSubscription(null)).toBeUndefined();
  });

  test("adding the same endpoint twice keeps one record, file mode 0600", async () => {
    const dir = tempDir();
    await addSubscription(sub, "https://console.example.com", dir);
    expect(await addSubscription(sub, "https://console.example.com", dir)).toBe(1);
    expect(statSync(subscriptionsPath(dir)).mode & 0o777).toBe(0o600);
  });

  test("sendToAll encrypts per browser and drops endpoints the service reports gone", async () => {
    const dir = tempDir();
    const other = fakeBrowser();
    await addSubscription(sub, "https://console.example.com", dir);
    await addSubscription({ endpoint: "https://push.example.com/send/SYNTHETIC_FIXTURE_GONE", keys: other.keys }, undefined, dir);
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Encoding"]).toBe("aes128gcm");
      expect(headers.Authorization).toStartWith("vapid t=");
      if (url.endsWith("GONE")) return new Response(null, { status: 410 });
      bodies.push(browser.decrypt(Buffer.from(init.body as Uint8Array)));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendToAll({ title: "T", body: "B" }, { dir, fetchImpl });
    expect(result).toEqual({ sent: 1, removed: 1, failed: 0 });
    expect(JSON.parse(bodies[0]!)).toEqual({ title: "T", body: "B" });
    expect((await loadSubscriptions(dir)).map((s) => s.endpoint)).toEqual([sub.endpoint]);
  });
});

describe("/api/push routes", () => {
  const dir = tempDir();
  const app = createApp({ token: "t", port: 47130, startedAt: Date.now(), pushDir: dir, pushFetch: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch });
  const auth = { Authorization: "Bearer t", Host: "127.0.0.1:47130" };
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: "POST", headers: { ...auth, "X-AIS-Console": "1", "content-type": "application/json", Origin: "https://console.example.com" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const browser = fakeBrowser();
  const sub = { endpoint: "https://push.example.com/send/SYNTHETIC_FIXTURE_2", keys: browser.keys };

  test("GET answers the public key and never the endpoints", async () => {
    await post("/api/push/subscribe", { subscription: sub });
    const res = await app.request("/api/push", { headers: auth });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.subscriptions).toBe(1);
    expect(typeof body.publicKey).toBe("string");
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_FIXTURE_2");
  });

  test("subscribe records the page origin; bad bodies answer 400", async () => {
    expect((await loadSubscriptions(dir))[0]?.origin).toBe("https://console.example.com");
    expect((await post("/api/push/subscribe", { subscription: { endpoint: "nope" } })).status).toBe(400);
  });

  test("test push reaches the subscription; unsubscribe removes it", async () => {
    expect(await (await post("/api/push/test")).json()).toEqual({ ok: true, sent: 1, removed: 0, failed: 0 });
    expect(await (await post("/api/push/unsubscribe", { endpoint: sub.endpoint })).json()).toEqual({ ok: true, removed: true });
    expect(await loadSubscriptions(dir)).toEqual([]);
  });

  test("the reset-expiry check answers 503 without the daemon notifier", async () => {
    expect((await post("/api/push/reset-expiry/check")).status).toBe(503);
  });
});
