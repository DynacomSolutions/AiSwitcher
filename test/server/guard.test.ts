import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHost, consoleGuard, linuxPeerUid, parseProcNetTcp, type GuardDeps } from "../../src/server/guard.ts";

const ME = process.getuid?.() ?? 0;

function appWith(token: string, port: number, peerAddress?: string, peerUid: GuardDeps["peerUid"] = () => ME): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err.message }, status as 500);
  });
  app.use("/api/*", (c, next) => consoleGuard({ token, port, peerUid, peerPort: 50000, ...(peerAddress ? { peerAddress } : {}) }, c, next));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.post("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

const TOKEN = "test-token-1234";

describe("allowedHost", () => {
  test("accepts loopback hosts on the served port", () => {
    expect(allowedHost("127.0.0.1:47129", 47129)).toBe(true);
    expect(allowedHost("localhost:47129", 47129)).toBe(true);
    expect(allowedHost("localhost", 47129)).toBe(true);
  });

  test("rejects foreign hosts and wrong ports (DNS-rebinding guard)", () => {
    expect(allowedHost("evil.example.com", 47129)).toBe(false);
    expect(allowedHost("127.0.0.1:9999", 47129)).toBe(false);
    expect(allowedHost(undefined, 47129)).toBe(false);
  });
});

describe("consoleGuard", () => {
  test("rejects a non-loopback Host header even with a valid token", async () => {
    const res = await appWith(TOKEN, 47129).request("/api/ping", {
      headers: { Host: "evil.example.com", Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  test("allows a loopback request stamped as a loopback peer without a token", async () => {
    const res = await appWith(TOKEN, 47129, "127.0.0.1").request("/api/ping", {
      headers: { Host: "127.0.0.1:47129" },
    });
    expect(res.status).toBe(200);
  });

  test("rejects an unauthenticated peer with no loopback stamp", async () => {
    const res = await appWith(TOKEN, 47129).request("/api/ping", {
      headers: { Host: "127.0.0.1:47129" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts a valid bearer token from any peer", async () => {
    const res = await appWith(TOKEN, 47129).request("/api/ping", {
      headers: { Host: "127.0.0.1:47129", Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("rejects a loopback peer running as another uid", async () => {
    const res = await appWith(TOKEN, 47129, "127.0.0.1", () => ME + 1).request("/api/ping", {
      headers: { Host: "127.0.0.1:47129" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts another-uid loopback peer with a valid bearer", async () => {
    const res = await appWith(TOKEN, 47129, "127.0.0.1", () => ME + 1).request("/api/ping", {
      headers: { Host: "127.0.0.1:47129", Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("fails closed when the lookup throws or finds nothing", async () => {
    for (const fn of [
      () => {
        throw new Error("EACCES");
      },
      () => undefined,
    ]) {
      const res = await appWith(TOKEN, 47129, "127.0.0.1", fn).request("/api/ping", {
        headers: { Host: "127.0.0.1:47129" },
      });
      expect(res.status).toBe(401);
    }
  });

  test("rejects a mutating request without the X-AIS-Console header", async () => {
    const res = await appWith(TOKEN, 47129, "127.0.0.1").request("/api/ping", {
      method: "POST",
      headers: { Host: "127.0.0.1:47129" },
    });
    expect(res.status).toBe(403);
  });

  test("allows a mutating request carrying X-AIS-Console", async () => {
    const res = await appWith(TOKEN, 47129, "127.0.0.1").request("/api/ping", {
      method: "POST",
      headers: { Host: "127.0.0.1:47129", "X-AIS-Console": "1" },
    });
    expect(res.status).toBe(200);
  });
});

describe("parseProcNetTcp", () => {
  const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  test("parses IPv4 rows", () => {
    const row = "   0: 0100007F:C350 0100007F:B731 01 00000000:00000000 00:00000000 00000000  1234        0 99 1 0 100 0 0 10 0\n";
    expect(parseProcNetTcp(HEAD + row)).toEqual([{ localAddress: "127.0.0.1", localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 46897, state: "01", uid: 1234, inode: 99 }]);
  });

  test("parses IPv6 and IPv4-mapped rows", () => {
    const rows =
      "   0: 00000000000000000000000001000000:C350 00000000000000000000000001000000:B731 01 0:0 00:0 0  1000 0 1 1 0\n" +
      "   1: 0000000000000000FFFF00000100007F:C351 0000000000000000FFFF00000100007F:B731 01 0:0 00:0 0  1001 0 1 1 0\n";
    expect(parseProcNetTcp(HEAD + rows)).toEqual([
      { localAddress: "::1", localPort: 50000, remoteAddress: "::1", remotePort: 46897, state: "01", uid: 1000, inode: 1 },
      { localAddress: "127.0.0.1", localPort: 50001, remoteAddress: "127.0.0.1", remotePort: 46897, state: "01", uid: 1001, inode: 1 },
    ]);
  });
});

describe("linuxPeerUid 4-tuple matching", () => {
  const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const row = (lp: string, ra: string, rp: string, st: string, uid: number, inode: number) =>
    `   0: 0100007F:${lp} ${ra}:${rp} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0\n`;
  function lookup(rows: string, serverAddress?: string): number | undefined {
    const dir = mkdtempSync(join(tmpdir(), "ais-proc-"));
    const f = join(dir, "tcp");
    writeFileSync(f, HEAD + rows);
    return linuxPeerUid("127.0.0.1", 0xc350, 0xb731, serverAddress, [f]);
  }
  test("single established owned row matches", () => {
    expect(lookup(row("C350", "0100007F", "B731", "01", 1000, 5))).toBe(1000);
  });
  test("ownerless TIME_WAIT uid 0 row is rejected", () => {
    expect(lookup(row("C350", "0100007F", "B731", "06", 0, 0))).toBeUndefined();
    expect(lookup(row("C350", "0100007F", "B731", "01", 0, 0))).toBeUndefined();
  });
  test("ambiguous matches are untrusted", () => {
    const r = row("C350", "0100007F", "B731", "01", 1000, 5);
    expect(lookup(r + r)).toBeUndefined();
  });
  test("wrong destination address is untrusted", () => {
    const r = row("C350", "0100007F", "B731", "01", 1000, 5);
    expect(lookup(r, "127.0.0.2")).toBeUndefined();
    expect(lookup(r, "127.0.0.1")).toBe(1000);
    expect(lookup(row("C350", "0100A8C0", "B731", "01", 1000, 5))).toBeUndefined();
  });
});

describe("allowedHost bracketed IPv6", () => {
  test("parses [::1] with and without port", () => {
    expect(allowedHost("[::1]:47129", 47129)).toBe(true);
    expect(allowedHost("[::1]", 47129)).toBe(true);
    expect(allowedHost("[::1]:9999", 47129)).toBe(false);
    expect(allowedHost("[::2]:47129", 47129)).toBe(false);
    expect(allowedHost("127.0.0.1:47129x", 47129)).toBe(false);
  });
});

describe("allowed vhosts (reverse-proxied deployments)", () => {
  const HOSTS = new Set(["ais.localhost"]);

  function appWithHosts(): Hono {
    const app = new Hono();
    app.onError((err, c) => {
      const status = (err as { status?: number }).status ?? 500;
      return c.json({ error: err.message }, status as 500);
    });
    app.use("/api/*", (c, next) => consoleGuard({ token: TOKEN, port: 47129, allowedHosts: HOSTS }, c, next));
    app.get("/api/ping", (c) => c.json({ ok: true }));
    app.post("/api/ping", (c) => c.json({ ok: true }));
    return app;
  }

  test("allowedHost accepts a configured vhost and still rejects foreign ones", () => {
    expect(allowedHost("ais.localhost", 47129, HOSTS)).toBe(true);
    expect(allowedHost("AIS.LOCALHOST:47129", 47129, HOSTS)).toBe(true);
    expect(allowedHost("evil.example.com", 47129, HOSTS)).toBe(false);
    expect(allowedHost("ais.localhost", 47129)).toBe(false);
  });

  test("a proxy-peer request on the allowed vhost is trusted without a token", async () => {
    // Peer address is the proxy, not loopback: the vhost arm is what admits it.
    const res = await appWithHosts().request("/api/ping", { headers: { Host: "ais.localhost" } });
    expect(res.status).toBe(200);
  });

  test("mutations on the allowed vhost still require X-AIS-Console", async () => {
    const without = await appWithHosts().request("/api/ping", { method: "POST", headers: { Host: "ais.localhost" } });
    expect(without.status).toBe(403);
    const withHeader = await appWithHosts().request("/api/ping", {
      method: "POST",
      headers: { Host: "ais.localhost", "X-AIS-Console": "1" },
    });
    expect(withHeader.status).toBe(200);
  });

  test("a foreign vhost from a proxy peer stays rejected", async () => {
    const res = await appWithHosts().request("/api/ping", { headers: { Host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });
});

describe("/api/health liveness route", () => {
  test("answers without a token or loopback peer (probe contract)", async () => {
    const { createApp } = await import("../../src/server/app.ts");
    const res = await createApp({ token: TOKEN, port: 47129, startedAt: Date.now() }).request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });
});
