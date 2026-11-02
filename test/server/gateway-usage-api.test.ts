import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";

const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
const headers = { Host: "127.0.0.1:47129" };
const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

describe("GET /api/gateway/usage", () => {
  test("returns the view and passes days through", async () => {
    let days = 0;
    const view = { configured: true, rows: [{ app: "e2e-claude", provider: "claude", days: 3, tokens: 42 }] };
    const res = await appWith({ gatewayUsage: async (d) => ((days = d), view) }).request("/api/gateway/usage?days=3", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(days).toBe(3);
  });
  test("defaults to 7 days and keeps the console guard", async () => {
    let days = 0;
    const app = appWith({ gatewayUsage: async (d) => ((days = d), { configured: false, rows: [] }) });
    expect((await app.request("/api/gateway/usage", { headers })).status).toBe(200);
    expect(days).toBe(7);
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/gateway/usage", { headers })).status).toBe(401);
  });
});
