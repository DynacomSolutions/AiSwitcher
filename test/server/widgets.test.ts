import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";
import { startWidgetsListener } from "../../src/server/serve.ts";
import { ServerLifecycle } from "../../src/server/lifecycle.ts";
import {
  PANELS,
  WidgetService,
  parseWidgetsLinkBase,
  parseWidgetsPort,
  widgetsHostAllowed,
  widgetsListenerFetch,
  type PanelModel,
  type WidgetSources,
} from "../../src/server/widgets.ts";

const BASE = "https://console.example.com";
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
        limitsResult("anthropic", "pool1", [{ label: "session (5h)", category: "session", usedPercent: 99 }], { identity: { name: "pool1", swapPool: {} } }),
        limitsResult("anthropic", "old", [{ label: "session (5h)", category: "session", usedPercent: 99 }], { identity: { name: "old", retired: true } }),
        limitsResult("openai", "gina", [{ label: "month", category: "month", usedPercent: 30 }, { label: "extra", category: "other", usedPercent: 50 }]),
        limitsResult("zai", "carol", [], { status: "unavailable", error: "no access at /srv/synthetic/key for carol@example.com" }),
      ],
    }),
    auth: count("auth", {
      entries: [
        { toolName: "claude", identity: "alice", state: "ok", expiresAt: "2026-11-21T10:00:00.000Z" },
        { toolName: "claude", identity: "frank", state: "ok", expiresAt: "2026-11-19T10:00:00.000Z" },
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
          { name: "m3", active: false, allowed: true, usage: { status: "rate-limited", maxUtilization: 100 } },
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
  const res = await new WidgetService(src, () => NOW, BASE).get(id);
  expect(res.status).toBe(200);
  return res.body as PanelModel;
}

describe("widget list", () => {
  test("is the versioned wrapper of PanelInfo with the AIS plugin name, and links are empty without a base", () => {
    const list = new WidgetService(sources()).list();
    expect(list.version).toBe(1);
    expect(list.panels.map((p) => p.id)).toEqual(["limits", "identities", "agents", "gateway-usage", "claude-swap", "spend-guard"]);
    for (const info of list.panels) {
      expect(Object.keys(info).sort()).toEqual(["description", "id", "link", "plugin", "refreshSeconds", "title"]);
      expect(info.plugin).toBe("AIS Console");
      expect(info.link).toBe("");
    }
    const based = new WidgetService(sources(), () => NOW, BASE).list().panels;
    expect(based.find((p) => p.id === "limits")?.link).toBe(`${BASE}/limits`);
    expect(based.find((p) => p.id === "agents")?.link).toBe(`${BASE}/dashboard`);
    expect(based.find((p) => p.id === "spend-guard")?.link).toBe("");
    expect(list.panels.find((p) => p.id === "agents")?.refreshSeconds).toBe(60);
    expect(PANELS.filter((p) => p.id !== "agents").every((p) => p.refreshSeconds === 300)).toBe(true);
  });
});

describe("panel mapping", () => {
  test("limits: fractions, thresholds, unknown rows and masked errors", async () => {
    const model = await panel("limits");
    expect(model).toMatchObject({ version: 1, id: "limits", generatedAt: NOW.toISOString(), link: `${BASE}/limits`, status: "crit" });
    const find = (label: string, detail: string) => model.rows.find((r) => r.label === label && r.detail === detail)!;
    expect(find("Anthropic / alice", "5-hour")).toMatchObject({ fraction: 0.96, status: "crit", value: "96%" });
    expect(find("Anthropic / alice", "Weekly")).toMatchObject({ fraction: 0.4, status: "ok" });
    expect(find("Anthropic / alice", "Weekly (Model)")).toMatchObject({ fraction: 0.85, status: "warn" });
    expect(find("OpenAI / bob", "5-hour")).toMatchObject({ fraction: 0.825, status: "warn" });
    expect(find("Z.ai / carol", "No limit data")).toMatchObject({ status: "unknown", value: "-" });
    expect(find("Z.ai / carol", "No limit data").fraction).toBeUndefined();
    expect(find("OpenAI / gina", "Monthly")).toMatchObject({ fraction: 0.3, status: "ok" });
    expect(find("OpenAI / gina", "Other (extra)")).toMatchObject({ fraction: 0.5, status: "ok" });
    // Pools and retired identities are skipped.
    expect(model.rows.map((r) => r.label)).not.toContain("Anthropic / pool1");
    expect(model.rows.map((r) => r.label)).not.toContain("Anthropic / old");
    expect(model.rows.map((r) => r.status)).toEqual(["crit", "warn", "warn", "unknown", "ok", "ok", "ok", "ok"]);
    // The summary counts only rows with data.
    expect(model.summary).toBe("7 windows: 1 critical, 2 high, 4 ok, 1 without data");
    expect(model.stats[0]).toMatchObject({ label: "Windows", value: "7" });
    const text = JSON.stringify(model);
    expect(text).not.toContain("/srv/");
    expect(text).not.toContain("carol@");
  });

  test("limits: boundaries are warn at 0.8 and crit at 0.95", async () => {
    const src = sources({
      limits: async () => ({
        results: [limitsResult("p", "a", [{ label: "x", category: "session", usedPercent: 80 }]), limitsResult("p", "b", [{ label: "x", category: "session", usedPercent: 95 }]), limitsResult("p", "c", [{ label: "x", category: "session", usedPercent: 79.9 }])],
      }),
    });
    const model = await panel("limits", src);
    expect(Object.fromEntries(model.rows.map((r) => [r.label, r.status]))).toEqual({ "P / a": "warn", "P / b": "crit", "P / c": "ok" });
  });

  test("identities: counts per state, retired and pools excluded", async () => {
    const model = await panel("identities");
    expect(model.link).toBe(`${BASE}/auth`);
    expect(model.stats).toEqual([
      { label: "Logged in", value: "2", status: "ok" },
      { label: "Expiring", value: "1", status: "warn" },
      { label: "Expired", value: "1", status: "crit" },
      { label: "Logged out", value: "1", status: "crit" },
    ]);
    expect(model.rows).toHaveLength(5);
    // A past expiry on a logged-in identity shows the state, not the date.
    expect(model.rows.find((r) => r.label === "claude / alice")?.detail).toBe("Expires 2026-11-21T10:00:00.000Z");
    expect(model.rows.find((r) => r.label === "claude / frank")?.detail).toBe("Logged in");
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
    expect(swap.rows.map((r) => [r.label, r.status, r.fraction])).toEqual([["shared / m1", "crit", 0.97], ["shared / m3", "crit", 1], ["shared / m2", "unknown", undefined]]);
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
  test("404 for an unknown id and a generic 502 for an unknown backend error", async () => {
    const logged = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const service = new WidgetService(sources({ auth: async () => { throw new Error("boom for carol@example.com at /srv/synthetic/x"); } }), () => NOW);
      expect(await service.get("nope")).toEqual({ status: 404, body: { error: "unknown panel" } });
      const failed = await service.get("identities");
      expect(failed).toEqual({ status: 502, body: { error: "identities backend unavailable" } });
      expect(lines.join("\n")).toContain("boom for");
    } finally {
      console.error = logged;
    }
  });

  test("passes the message of a PanelError through (masked)", async () => {
    const off = sources({ gatewayUsage: async () => ({ configured: true, error: "admin unreachable", rows: [] }) });
    const failed = await new WidgetService(off, () => NOW).get("gateway-usage");
    expect(failed).toEqual({ status: 502, body: { error: "gateway usage unavailable" } });
  });

  test("remembers a failure briefly and serves the last good model while a refresh fails", async () => {
    let now = NOW.getTime();
    const realDateNow = Date.now;
    Date.now = () => now;
    const logged = console.error;
    console.error = () => {};
    try {
      let fail = true;
      let calls = 0;
      const src = sources({ processes: async () => { calls += 1; if (fail) throw new Error("down"); return { processes: [] }; } });
      const service = new WidgetService(src, () => new Date(now));
      expect((await service.get("agents")).status).toBe(502);
      expect((await service.get("agents")).status).toBe(502);
      expect(calls).toBe(1);
      now += 61_000;
      fail = false;
      const good = await service.get("agents");
      expect(good.status).toBe(200);
      expect(calls).toBe(2);
      fail = true;
      now += 61_000;
      const stale = await service.get("agents");
      expect(stale).toEqual({ status: 200, body: good.body });
      const callsAfter = calls;
      await service.get("agents");
      expect(calls).toBe(callsAfter);
    } finally {
      Date.now = realDateNow;
      console.error = logged;
    }
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
  const call = (path: string, method = "GET", host = "192.0.2.7:8080") =>
    widgetsListenerFetch(service, new Request(`http://synthetic.invalid${path}`, { method, headers: { Host: host } }), new Set(["console.example.com"]));

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

  test("checks the Host header: IP literals, loopback names and allowed vhosts only", async () => {
    for (const host of ["192.0.2.7:8080", "127.0.0.1", "localhost:9", "[::1]:8080", "[fd00::5]", "console.example.com"]) {
      expect((await call("/api/widgets-health", "GET", host)).status).toBe(200);
    }
    for (const host of ["rebind.example.net", "rebind.example.net:8080", "192.0.2.7.example.net", "[not-an-ip]", "fd00::5", ""]) {
      const res = await call("/api/widgets-health", "GET", host);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "host not allowed" });
    }
    expect(widgetsHostAllowed(null)).toBe(false);
    expect((await widgetsListenerFetch(service, new Request("http://synthetic.invalid/api/widgets"))).status).toBe(403);
  });

  test("shares the panel cache with the main listener", async () => {
    const src = sources();
    const shared = new WidgetService(src, () => NOW);
    await appWith({ widgets: shared }).request("/api/widgets/agents", { headers });
    await widgetsListenerFetch(shared, new Request("http://synthetic.invalid/api/widgets/agents", { headers: { Host: "192.0.2.7" } }));
    expect(src.calls.processes).toBe(1);
  });
});

describe("parseWidgetsLinkBase", () => {
  test("is empty when unset, strips a trailing slash and rejects bad values", () => {
    expect(parseWidgetsLinkBase(undefined)).toEqual({});
    expect(parseWidgetsLinkBase(" ")).toEqual({});
    expect(parseWidgetsLinkBase("https://console.example.com/")).toEqual({ base: "https://console.example.com" });
    expect(parseWidgetsLinkBase("http://console.example.com:8080/ais")).toEqual({ base: "http://console.example.com:8080/ais" });
    for (const bad of ["/relative", "console.example.com", "ftp://console.example.com", "https://u:p@console.example.com", "https://console.example.com/?q=1", "javascript:alert(1)"]) {
      expect(parseWidgetsLinkBase(bad).error).toBeTruthy();
    }
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
