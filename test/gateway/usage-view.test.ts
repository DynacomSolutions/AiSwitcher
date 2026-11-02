import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGatewayUsageSection, loadGatewayUsage, mapGatewayUsage } from "../../src/gateway/usage-view.ts";

describe("mapGatewayUsage", () => {
  test("sorts by tokens, drops malformed rows, clamps bad numbers", () => {
    const rows = mapGatewayUsage({
      usage: [
        { app: "b", provider: "claude", days: 7, tokens: 10 },
        { app: "a", provider: "codex", days: 7, tokens: 900 },
        { provider: "x", tokens: 5 },
        { app: "c", provider: "grok", days: 7, tokens: "nope" },
        null,
      ],
    });
    expect(rows.map((r) => [r.app, r.tokens])).toEqual([["a", 900], ["b", 10], ["c", 0]]);
  });
  test("non-object or missing usage maps to no rows", () => {
    expect(mapGatewayUsage(null)).toEqual([]);
    expect(mapGatewayUsage({})).toEqual([]);
    expect(mapGatewayUsage({ usage: "x" })).toEqual([]);
  });
});

describe("formatGatewayUsageSection", () => {
  test("empty when gateway is not configured", () => {
    expect(formatGatewayUsageSection({ configured: false, rows: [] })).toBe("");
  });
  test("table with a Gateway apps heading", () => {
    const out = formatGatewayUsageSection({ configured: true, rows: [{ app: "e2e-claude", provider: "claude", days: 7, tokens: 1234 }] });
    expect(out).toContain("Gateway apps");
    expect(out).toContain("e2e-claude");
    expect(out).toContain("1,234");
    expect(out).toContain("TOKENS (7d)");
  });
  test("states the error and the empty case", () => {
    expect(formatGatewayUsageSection({ configured: true, rows: [], error: "admin unreachable" })).toContain("unavailable: admin unreachable");
    expect(formatGatewayUsageSection({ configured: true, rows: [] })).toContain("no gateway apps");
  });
});

describe("loadGatewayUsage", () => {
  const secrets = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "gwuv-"));
    const p = join(dir, "secrets");
    writeFileSync(p, body);
    return p;
  };
  test("not configured without url and token", async () => {
    const saved = [process.env.AIS_GATEWAY_ADMIN_URL, process.env.AIS_GATEWAY_ADMIN_TOKEN];
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      expect(await loadGatewayUsage(7, { secretsPath: secrets("") })).toEqual({ configured: false, rows: [] });
    } finally {
      if (saved[0] !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = saved[0];
      if (saved[1] !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = saved[1];
    }
  });
  test("calls /usage with bearer token and maps rows", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fake = (async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify({ usage: [{ app: "a", provider: "claude", days: 3, tokens: 5 }] }));
    }) as unknown as typeof fetch;
    const view = await loadGatewayUsage(3, { fetch: fake, secretsPath: secrets("AIS_GATEWAY_ADMIN_URL=http://x:1/\nAIS_GATEWAY_ADMIN_TOKEN=tok\n") });
    expect(seen).toEqual({ url: "http://x:1/usage?days=3", auth: "Bearer tok" });
    expect(view.rows).toEqual([{ app: "a", provider: "claude", days: 3, tokens: 5 }]);
  });
  test("failures become a short error without the token", async () => {
    const path = secrets("AIS_GATEWAY_ADMIN_URL=http://x:1\nAIS_GATEWAY_ADMIN_TOKEN=sekrit\n");
    const down = (async () => { throw new Error("connect sekrit"); }) as unknown as typeof fetch;
    const bad = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const a = await loadGatewayUsage(1, { fetch: down, secretsPath: path });
    const b = await loadGatewayUsage(1, { fetch: bad, secretsPath: path });
    expect(a.error).toBe("admin unreachable");
    expect(b.error).toBe("admin answered 401");
    expect(JSON.stringify([a, b])).not.toContain("sekrit");
  });
});
