import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";
import { startWidgetsListener } from "../../src/server/serve.ts";
import { ServerLifecycle } from "../../src/server/lifecycle.ts";
import {
  PANELS,
  WidgetService,
  parseWidgetsPort,
  widgetsListenerFetch,
  type PanelModel,
  type WidgetSources,
} from "../../src/server/widgets.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");

const limitsResult = (provider: string, name: string, windows: unknown[], extra: object = {}) => ({
  toolName: provider,
  provider,
  identity: { name },
  status: "live",
  windows,
  ...extra,
});

function sources(overrides: Partial<WidgetSources> = {}): WidgetSources & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = <T>(name: string, value: T) => async (): Promise<T> => {
    calls[name] = (calls[name] ?? 0) + 1;
    return value;
  };
  return {
    calls,
    limits: count("limits", {
      results: [
        limitsResult("anthropic", "alice", [
          { label: "session (5h)", category: "session", usedPercent: 96 },
          { label: "week (all)", category: "week", usedPercent: 40 },
          { label: "week (Model)", category: "week", usedPercent: 85, model: "Model" },
        ]),
        limitsResult("openai", "bob", [
          { label: "session (5h)", category: "session", usedPercent: 82.5 },
          { label: "week (all)", category: "week", usedPercent: 10 },
        ]),
        limitsResult("zai", "carol", [], { status: "unavailable", error: "no access at /srv/synthetic/key for carol@example.com" }),
      ],
    }),
    auth: count("auth", {
      entries: [
        { toolName: "claude", identity: "alice", state: "ok", expiresAt: "2026-11-21T10:00:00.000Z" },
        { toolName: "claude", identity: "bob", state: "expiring" },
        { toolName: "codex", identity: "carol", state: "expired" },
        { toolName: "kimi", identity: "dave", state: "missing" },
        { toolName: "kimi", identity: "erin", state: "retired" },
        { toolName: "claude", identity: "pool", state: "gateway" },
      ],
    }),
    processes: count("processes", {
      processes: [
        { tool: "claude", identity: "alice", startedAt: "2026-11-20T08:55:00.000Z", pid: 1, cwd: "/srv/synthetic/work", command: "claude --secret-flag" },
        { tool: "claude", identity: null, startedAt: null },
        { tool: "codex", identity: "bob", startedAt: "2026-11-18T05:00:00.000Z" },
      ] as never,
    }),
    gatewayUsage: async (days) => {
      calls.gatewayUsage = (calls.gatewayUsage ?? 0) + 1;
      expect(days).toBe(7);
      return {
        configured: true,
        rows: [
          { app: "app-a", provider: "claude", days: 7, tokens: 3_000_000 },
          { app: "app-b", provider: "codex", days: 7, tokens: 1_000_000 },
        ],
      };
    },
    claudeSwap: count("claudeSwap", [
      {
        pool: "shared",
        rows: [
          { name: "m1", active: true, allowed: true, usage: { status: "live", maxUtilization: 97 } },
          { name: "m2", active: false, allowed: true, usage: { status: "unavailable" } },
        ],
      },
    ]),
    spendGuard: () => ({
      running: true,
      accounts: [
        { accountId: "000000000000", budgetLimitUsd: 100, effectiveUsd: 85, breached: false, degraded: false, identities: ["alice"] },
        { accountId: "000000000001", effectiveUsd: 5, breached: false, degraded: true, identities: [] },
      ],
    }),
    ...overrides,
  } as WidgetSources & { calls: Record<string, number> };
}

async function panel(id: string, src: WidgetSources = sources()): Promise<PanelModel> {
  const res = await new WidgetService(src, () => NOW).get(id);
  expect(res.status).toBe(200);
  return res.body as PanelModel;
}

describe("widget list", () => {
  test("is the versioned wrapper of PanelInfo with the AIS plugin name and relative links", () => {
    const list = new WidgetService(sources()).list();
    expect(list.version).toBe(1);
    expect(list.panels.map((p) => p.id)).toEqual(["limits", "identities", "agents", "gateway-usage", "claude-swap", "spend-guard"]);
    for (const info of list.panels) {
      expect(Object.keys(info).sort()).toEqual(["description", "id", "link", "plugin", "refreshSeconds", "title"]);
      expect(info.plugin).toBe("AIS Console");
      expect(info.link === "" || info.link.startsWith("/")).toBe(true);
      expect(info.link).not.toContain("://");
    }
    expect(list.panels.find((p) => p.id === "agents")?.refreshSeconds).toBe(60);
    expect(PANELS.filter((p) => p.id !== "agents").every((p) => p.refreshSeconds === 300)).toBe(true);
  });
});

describe("panel mapping", () => {
  test("limits: fractions, thresholds, unknown rows and masked errors", async () => {
    const model = await panel("limits");
    expect(model).toMatchObject({ version: 1, id: "limits", generatedAt: NOW.toISOString(), link: "/limits", status: "crit" });
    const find = (label: string, detail: string) => model.rows.find((r) => r.label === label && r.detail === detail)!;
    expect(find("anthropic / alice", "5-hour")).toMatchObject({ fraction: 0.96, status: "crit", value: "96%" });
    expect(find("anthropic / alice", "Weekly")).toMatchObject({ fraction: 0.4, status: "ok" });
    expect(find("anthropic / alice", "Weekly (Model)")).toMatchObject({ fraction: 0.85, status: "warn" });
    expect(find("openai / bob", "5-hour")).toMatchObject({ fraction: 0.825, status: "warn" });
    expect(find("zai / carol", "No limit data")).toMatchObject({ status: "unknown", value: "-" });
    expect(find("zai / carol", "No limit data").fraction).toBeUndefined();
    expect(model.rows.map((r) => r.status)).toEqual(["crit", "warn", "warn", "unknown", "ok", "ok"]);
    const text = JSON.stringify(model);
    expect(text).not.toContain("/srv/");
    expect(text).not.toContain("example.com");
  });

  test("limits: boundaries are warn at 0.8 and crit at 0.95", async () => {
    const src = sources({
      limits: async () => ({
        results: [limitsResult("p", "a", [{ label: "x", category: "session", usedPercent: 80 }]), limitsResult("p", "b", [{ label: "x", category: "session", usedPercent: 95 }]), limitsResult("p", "c", [{ label: "x", category: "session", usedPercent: 79.9 }])],
      }),
    });
    const model = await panel("limits", src);
    expect(Object.fromEntries(model.rows.map((r) => [r.label, r.status]))).toEqual({ "p / a": "warn", "p / b": "crit", "p / c": "ok" });
  });

  test("identities: counts per state, retired and pools excluded", async () => {
    const model = await panel("identities");
    expect(model.link).toBe("/auth");
    expect(model.stats).toEqual([
      { label: "Logged in", value: "1", status: "ok" },
      { label: "Expiring", value: "1", status: "warn" },
      { label: "Expired", value: "1", status: "crit" },
      { label: "Logged out", value: "1", status: "crit" },
    ]);
    expect(model.rows).toHaveLength(4);
    expect(model.rows.map((r) => r.label)).not.toContain("kimi / erin");
    expect(model.rows.map((r) => r.label)).not.toContain("claude / pool");
    expect(model.status).toBe("crit");
  });

  test("agents: stat per tool, row per session, no paths or command lines", async () => {
    const model = await panel("agents");
    expect(model.stats).toEqual([
      { label: "claude", value: "2", status: "ok" },
      { label: "codex", value: "1", status: "ok" },
    ]);
    expect(model.rows).toHaveLength(3);
    expect(model.rows[0]).toMatchObject({ label: "claude", detail: "alice", value: "1h 5m" });
    expect(model.rows[1]).toMatchObject({ detail: "unknown identity", value: "-" });
    expect(model.rows[2]).toMatchObject({ value: "2d 5h" });
    const text = JSON.stringify(model);
    expect(text).not.toContain("/srv/");
    expect(text).not.toContain("secret-flag");
  });

  test("gateway-usage: rows per app with token share, and honest unknown when not configured", async () => {
    const model = await panel("gateway-usage");
    expect(model.rows.map((r) => [r.label, r.value, r.fraction])).toEqual([["app-a", "3M", 0.75], ["app-b", "1M", 0.25]]);
    expect(model.stats).toEqual([{ label: "Apps", value: "2", status: "ok" }, { label: "Tokens", value: "4M", status: "ok" }]);
    expect(model.series).toBeUndefined();
    const off = await panel("gateway-usage", sources({ gatewayUsage: async () => ({ configured: false, rows: [] }) }));
    expect(off).toMatchObject({ status: "unknown", summary: "Gateway not configured", rows: [] });
  });

  test("claude-swap and spend-guard: unknown rows stay unknown, no ids leave", async () => {
    const swap = await panel("claude-swap");
    expect(swap.rows.map((r) => [r.label, r.status, r.fraction])).toEqual([["shared / m1", "crit", 0.97], ["shared / m2", "unknown", undefined]]);
    const spend = await panel("spend-guard");
    expect(spend.rows.map((r) => [r.label, r.status, r.fraction])).toEqual([["alice", "warn", 0.85], ["Account 2", "unknown", undefined]]);
    expect(JSON.stringify(spend)).not.toContain("0000000000");
    const none = await panel("spend-guard", sources({ spendGuard: () => undefined }));
    expect(none).toMatchObject({ status: "unknown", summary: "Spend guard not running" });
  });

  test("masks email-shaped values in every string", async () => {
    const src = sources({ auth: async () => ({ entries: [{ toolName: "claude", identity: "who@example.com", state: "ok" }] }) });
    const model = await panel("identities", src);
    expect(JSON.stringify(model)).not.toContain("@");
  });
});

describe("service behaviour", () => {
  test("404 for an unknown id and 502 with a short masked reason for a failing backend", async () => {
    const service = new WidgetService(sources({ auth: async () => { throw new Error("boom for carol@example.com"); } }), () => NOW);
    expect(await service.get("nope")).toEqual({ status: 404, body: { error: "unknown panel" } });
    const failed = await service.get("identities");
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("example.com");
  });

  test("caches a panel for its refreshSeconds and shares one in-flight build", async () => {
    let now = NOW.getTime();
    const src = sources();
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      const service = new WidgetService(src, () => new Date(now));
      await Promise.all([service.get("agents"), service.get("agents"), service.get("agents")]);
      expect(src.calls.processes).toBe(1);
      now += 59_000;
      await service.get("agents");
      expect(src.calls.processes).toBe(1);
      now += 2_000;
      await service.get("agents");
      expect(src.calls.processes).toBe(2);
      await service.get("limits");
      now += 200_000;
      await service.get("limits");
      expect(src.calls.limits).toBe(1);
    } finally {
      Date.now = realDateNow;
    }
  });
});

const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
const headers = { Host: "127.0.0.1:47129" };
const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, widgets: new WidgetService(sources(), () => NOW), ...extra });

describe("main listener routes", () => {
  test("serve the list and one panel, and keep the console guard", async () => {
    const app = appWith({});
    const list = await app.request("/api/widgets", { headers });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { panels: unknown[] }).panels).toHaveLength(6);
    const one = await app.request("/api/widgets/agents", { headers });
    expect(one.status).toBe(200);
    expect(((await one.json()) as PanelModel).id).toBe("agents");
    expect((await app.request("/api/widgets/nope", { headers })).status).toBe(404);
    const guarded = appWith({ peerAddress: "203.0.113.9" });
    expect((await guarded.request("/api/widgets", { headers })).status).toBe(401);
    expect((await guarded.request("/api/widgets/agents", { headers })).status).toBe(401);
    expect((await app.request("/api/widgets", { headers: { Host: "evil.example" } })).status).not.toBe(200);
  });

  test("answer 502 when a backend fails", async () => {
    const app = appWith({ widgets: new WidgetService(sources({ processes: async () => { throw new Error("down"); } }), () => NOW) });
    expect((await app.request("/api/widgets/agents", { headers })).status).toBe(502);
  });
});

describe("widgets-only listener", () => {
  const service = new WidgetService(sources(), () => NOW);
  const call = (path: string, method = "GET") => widgetsListenerFetch(service, new Request(`http://synthetic.invalid${path}`, { method }));

  test("serves the widget routes and health without auth or CORS headers", async () => {
    expect((await call("/api/widgets")).status).toBe(200);
    expect((await call("/api/widgets/limits")).status).toBe(200);
    expect((await call("/api/widgets/nope")).status).toBe(404);
    const health = await call("/api/widgets-health");
    expect(await health.json()).toEqual({ ok: true });
    const res = await call("/api/widgets/limits");
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual([]);
    const head = await call("/api/widgets", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("answers 404 for every other path and 405 for other methods", async () => {
    for (const path of ["/api/status", "/api/limits", "/api/auth", "/api/widgets/a/b", "/", "/api/widgets-health/x", "/metrics"]) {
      expect((await call(path)).status).toBe(404);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect((await call("/api/widgets", method)).status).toBe(405);
      expect((await call("/api/widgets/limits", method)).status).toBe(405);
      expect((await call("/api/widgets-health", method)).status).toBe(405);
    }
    expect((await call("/api/status", "POST")).status).toBe(404);
  });

  test("shares the panel cache with the main listener", async () => {
    const src = sources();
    const shared = new WidgetService(src, () => NOW);
    await appWith({ widgets: shared }).request("/api/widgets/agents", { headers });
    await widgetsListenerFetch(shared, new Request("http://synthetic.invalid/api/widgets/agents"));
    expect(src.calls.processes).toBe(1);
  });
});

describe("parseWidgetsPort", () => {
  test("is off when unset and strict otherwise", () => {
    expect(parseWidgetsPort(undefined, 47129)).toEqual({});
    expect(parseWidgetsPort("  ", 47129)).toEqual({});
    expect(parseWidgetsPort("8080", 47129)).toEqual({ port: 8080 });
    for (const bad of ["0", "65536", "-1", "80a", "1.5", "0x50", "47129"]) expect(parseWidgetsPort(bad, 47129).error).toBeTruthy();
  });
});

describe("startWidgetsListener", () => {
  const freePort = (): number => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    void probe.stop(true);
    return port;
  };

  test("an invalid port logs an error and starts nothing", () => {
    const lines: string[] = [];
    const server = startWidgetsListener("99999", 47129, "127.0.0.1", new WidgetService(sources()), new ServerLifecycle(), (l) => lines.push(l));
    expect(server).toBeUndefined();
    expect(lines.join("\n")).toContain("AIS_WIDGETS_PORT");
  });

  test("is off when the variable is unset", () => {
    expect(startWidgetsListener(undefined, 47129, "127.0.0.1", new WidgetService(sources()), new ServerLifecycle())).toBeUndefined();
  });

  test("serves over HTTP, answers 503 while draining and stops accepting on stop", async () => {
    const port = freePort();
    const lifecycle = new ServerLifecycle();
    const server = startWidgetsListener(String(port), 47129, "127.0.0.1", new WidgetService(sources(), () => NOW), lifecycle)!;
    expect(server).toBeDefined();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/widgets-health`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/api/widgets/agents`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/api/limits`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/api/widgets`, { method: "POST" })).status).toBe(405);
      lifecycle.beginDrain();
      expect((await fetch(`http://127.0.0.1:${port}/api/widgets`)).status).toBe(503);
    } finally {
      await server.stop(true);
    }
    await expect(fetch(`http://127.0.0.1:${port}/api/widgets-health`)).rejects.toBeDefined();
  });
});
