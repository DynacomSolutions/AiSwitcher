import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { allowedHost, consoleGuard } from "../../src/server/guard.ts";

function appWith(token: string, port: number, peerAddress?: string): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err.message }, status as 500);
  });
  app.use("/api/*", (c, next) => consoleGuard({ token, port, ...(peerAddress ? { peerAddress } : {}) }, c, next));
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
