import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalGateway } from "../../src/gateway/local.ts";
import { ensureLocalTls, localGatewayTlsPort } from "../../src/gateway/local-tls.ts";

const root = mkdtempSync(join(tmpdir(), "ais-local-tls-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAKE_ROOTS = join(root, "roots.pem");
const mode = (p: string): number => statSync(p).mode & 0o777;

describe("localGatewayTlsPort", () => {
  test("defaults to the http port + 1, env overrides, 0 stays ephemeral", () => {
    expect(localGatewayTlsPort(47140, {})).toBe(47141);
    expect(localGatewayTlsPort(47140, { AIS_GATEWAY_LOCAL_TLS_PORT: "50000" })).toBe(50000);
    expect(localGatewayTlsPort(0, {})).toBe(0);
    expect(localGatewayTlsPort(47140, { AIS_GATEWAY_LOCAL_TLS_PORT: "nope" })).toBe(47141);
  });
});

describe("ensureLocalTls", () => {
  const dir = join(root, "tls");
  test("generates a CA and a loopback leaf, and a bundle with system roots + the CA", async () => {
    // Any valid certificate stands in for the system roots: a throwaway CA.
    const seed = await ensureLocalTls({ dir: join(root, "seed"), systemRoots: [] });
    writeFileSync(FAKE_ROOTS, readFileSync(seed.caPath, "utf8"));
    const t = await ensureLocalTls({ dir, systemRoots: [FAKE_ROOTS] });
    const ca = new X509Certificate(readFileSync(t.caPath, "utf8"));
    const leaf = new X509Certificate(t.cert);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toContain("DNS:localhost");
    expect(leaf.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(leaf.checkHost("localhost")).toBe("localhost");
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(new Date(ca.validTo).getTime() - Date.now()).toBeGreaterThan(9 * 365 * 24 * 3600_000);
    expect(mode(dir)).toBe(0o700);
    expect(mode(t.keyPath)).toBe(0o600);
    expect(mode(join(dir, "ca.key"))).toBe(0o600);
    const bundle = readFileSync(t.bundlePath, "utf8");
    expect(bundle.startsWith(readFileSync(FAKE_ROOTS, "utf8"))).toBe(true);
    expect(bundle.endsWith(readFileSync(t.caPath, "utf8"))).toBe(true);
    expect(bundle.match(/BEGIN CERTIFICATE/g)?.length).toBe(2);
  });

  test("a second call keeps the material; an expiring leaf is renewed under the same CA", async () => {
    const before = readFileSync(join(dir, "cert.pem"), "utf8");
    const ca = readFileSync(join(dir, "ca.pem"), "utf8");
    await ensureLocalTls({ dir, systemRoots: [FAKE_ROOTS] });
    expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(before);
    const later = Date.now() + 340 * 24 * 3600_000;
    const t = await ensureLocalTls({ dir, systemRoots: [FAKE_ROOTS], now: () => later });
    expect(t.cert).not.toBe(before);
    expect(readFileSync(join(dir, "ca.pem"), "utf8")).toBe(ca);
    expect(new X509Certificate(t.cert).checkIssued(new X509Certificate(ca))).toBe(true);
  });

  test("a changed CA regenerates the bundle", async () => {
    const dir2 = join(root, "tls2");
    const a = await ensureLocalTls({ dir: dir2, systemRoots: [] });
    const first = readFileSync(a.bundlePath, "utf8");
    rmSync(join(dir2, "ca.pem"));
    const b = await ensureLocalTls({ dir: dir2, systemRoots: [] });
    expect(readFileSync(b.bundlePath, "utf8")).not.toBe(first);
    expect(readFileSync(b.bundlePath, "utf8")).toBe(readFileSync(b.caPath, "utf8"));
  });
});

describe("local gateway HTTPS listener", () => {
  test("answers on the TLS port with the AIS CA, http keeps working, drain stops both", async () => {
    const running = await startLocalGateway({ port: 0, tls: { port: 0, dir: join(root, "serve") }, log: () => {}, clientToken: async () => "k" });
    try {
      expect(running.tlsPort).toBeGreaterThan(0);
      expect(running.tlsPort).not.toBe(running.port);
      const ca = readFileSync(join(root, "serve", "ca.pem"), "utf8");
      for (const host of ["localhost", "127.0.0.1"]) {
        const res = await fetch(`https://${host}:${running.tlsPort}/__ais/status`, { tls: { ca } } as RequestInit);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { tlsPort?: number }).tlsPort).toBe(running.tlsPort as number);
      }
      expect((await fetch(`http://127.0.0.1:${running.port}/__ais/status`)).status).toBe(200);
      // Without the CA the certificate is rejected.
      await expect(fetch(`https://localhost:${running.tlsPort}/__ais/status`)).rejects.toThrow();
    } finally {
      await running.drain();
    }
    await expect(fetch(`http://127.0.0.1:${running.port}/__ais/status`)).rejects.toThrow();
  });

  test("a TLS failure keeps plain HTTP up", async () => {
    const logs: string[] = [];
    const running = await startLocalGateway({ port: 0, tls: { port: 0, dir: "/proc/nope/tls" }, log: (l) => logs.push(l), clientToken: async () => "k" });
    try {
      expect(running.tlsPort).toBeUndefined();
      expect(logs.join("\n")).toContain("HTTPS listener not started");
      expect((await fetch(`http://127.0.0.1:${running.port}/__ais/status`)).status).toBe(200);
    } finally {
      running.stop();
    }
  });
});
