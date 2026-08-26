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
