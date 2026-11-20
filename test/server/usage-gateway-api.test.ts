import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * GET /api/usage with the gateway merge, end to end through the real app. The host scan worker is
 * mocked in a child process (as the limits tests do) so no real scan runs and the mock never leaks
 * into other test files; HOME is a temp dir so no real registry or credential file is read.
 */
test("GET /api/usage serves the gateway ledger and history without a host scan, and fails honestly", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-usage-gw-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      const workersPath = ${JSON.stringify(new URL("../../src/server/workers.ts", import.meta.url).pathname)};
      const workers = await import(workersPath);
      const scans = [];
      let failHost = false;
      const hostRow = (provider, name) => ({
        provider,
        identity: { name, label: "Host " + name, configDir: "/profiles/" + name },
        report: { entries: [{ model: "host-model", provider, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 1, cost: 0.01 }], totalInput: 1, totalOutput: 1, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 1, totalCost: 0.01 },
        dailyTotals: { "2026-11-19": [1, 1, 0, 0, 1, 0.01] },
      });
      const providerForTool = { claude: "anthropic", codex: "openai" };
      mock.module(workersPath, () => ({
        ...workers,
        runScanIsolated: async (kind, params) => {
          scans.push({ kind, ...params });
          if (failHost) return { ok: false, status: 500, error: "scan exploded" };
          let results = [hostRow("anthropic", "m1"), hostRow("anthropic", "pool"), hostRow("openai", "c1")];
          if (params.tool) results = results.filter((r) => r.provider === providerForTool[params.tool]);
          if (params.identity) results = results.filter((r) => r.identity.name === params.identity);
          return { ok: true, payload: { results, generatedAt: "2026-11-19T08:00:00.000Z", stale: false, pending: false } };
        },
      }));
      const { createApp } = await import(${JSON.stringify(new URL("../../src/server/app.ts", import.meta.url).pathname)});
      const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
      const headers = { Host: "127.0.0.1:47129" };
      const gatewayView = { configured: true, rows: [
        { provider: "claude", identity: "m1", app: "web", model: "sonnet", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.5, unpricedRequests: 0, requests: 2, firstTs: "2026-11-19T07:00:00.000Z", lastTs: "2026-11-19T10:00:00.000Z" },
      ], daily: [
        { day: "2026-11-19", provider: "claude", identity: "m1", model: "sonnet", inputTokens: 6, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.3, unpricedRequests: 0, requests: 1 },
        { day: "2026-11-18", provider: "claude", identity: "m1", model: "sonnet", inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.2, unpricedRequests: 0, requests: 1 },
      ] };
      const history = { configured: true, rows: [
        { source: "host-snapshot-models", generation: "g", provider: "claude", identity: "m1", day: null, model: "old-model", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 4, estCostUsd: 10, firstDay: "2026-11-10", lastDay: "2026-11-17", zone: "UTC" },
        { source: "host-snapshot-daily", generation: "g", provider: "claude", identity: "m1", day: "2026-11-10", model: null, inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 2, estCostUsd: 5, firstDay: "2026-11-10", lastDay: "2026-11-17", zone: "UTC" },
        { source: "host-snapshot-daily", generation: "g", provider: "claude", identity: "m1", day: "2026-11-17", model: null, inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 2, estCostUsd: 5, firstDay: "2026-11-10", lastDay: "2026-11-17", zone: "UTC" },
      ] };
      const get = async (extra, path) => {
        const app = createApp({ ...base, ...extra });
        const res = await app.request(path, { headers });
        return { status: res.status, body: await res.json() };
      };
      const out = {};
      const ok = { gatewayModelUsage: async () => gatewayView, gatewayUsageHistory: async () => history };
      out.merged = await get(ok, "/api/usage?tool=claude");
      out.configuredScans = scans.length;
      out.unconfigured = await get({ gatewayModelUsage: async () => ({ configured: false, rows: [] }) }, "/api/usage");
      out.errored = await get({ gatewayModelUsage: async () => ({ configured: true, rows: [], error: "admin unreachable" }), gatewayUsageHistory: async () => history }, "/api/usage");
      out.throwing = await get({ gatewayModelUsage: async () => { throw new Error("boom"); }, gatewayUsageHistory: async () => history }, "/api/usage");
      out.historyFailed = await get({ gatewayModelUsage: async () => gatewayView, gatewayUsageHistory: async () => ({ configured: true, rows: [], error: "admin answered 500" }) }, "/api/usage");
      out.historyThrowing = await get({ gatewayModelUsage: async () => gatewayView, gatewayUsageHistory: async () => { throw new Error("boom"); } }, "/api/usage");
      out.scansAfterErrors = scans.length;
      failHost = true;
      out.hostFailedLocal = await get({ gatewayModelUsage: async () => ({ configured: false, rows: [] }) }, "/api/usage");
      failHost = false;
      out.scans = scans;
      console.log(JSON.stringify(out));
    `], {
      env: { ...process.env, HOME: home },
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr: exitCode ? stderr : "" }).toEqual({ exitCode: 0, stderr: "" });
    type Body = { results: Array<{ provider: string; identity: { name: string }; report: { totalInput: number; totalCost: number; entries: Array<{ model: string; client?: string }> }; dailyTotals?: Record<string, number[]> }> };
    const out = JSON.parse(stdout) as {
      merged: { status: number; body: Body };
      configuredScans: number;
      unconfigured: { status: number; body: Body };
      errored: { status: number; body: { error?: string } };
      throwing: { status: number };
      historyFailed: { status: number; body: { error?: string } };
      historyThrowing: { status: number };
      scansAfterErrors: number;
      hostFailedLocal: { status: number };
      scans: Array<{ kind: string }>;
    };

    // Configured: ledger from its first day (18 Nov), imported history before it, no host rows and no host scan.
    expect(out.merged.status).toBe(200);
    expect(out.merged.body.results.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1"]);
    const m1 = out.merged.body.results[0]!;
    expect(m1.dailyTotals).toEqual({ "2026-11-10": [50, 25, 0, 0, 2, 5], "2026-11-17": [50, 25, 0, 0, 2, 5], "2026-11-19": [6, 3, 0, 0, 1, 0.3], "2026-11-18": [4, 2, 0, 0, 1, 0.2] });
    // Both history days are before coverage, so the whole history row stays; the ledger adds its own models.
    expect(m1.report.totalCost).toBeCloseTo(10 + 0.5, 6);
    expect(m1.report.entries.map((e) => e.model).sort()).toEqual(["old-model", "sonnet"]);
    expect(m1.report.entries.every((e) => e.client === undefined)).toBe(true);
    expect(out.configuredScans).toBe(0);

    // A gateway read failure is an honest 502, never host numbers; so is a history read failure.
    for (const failed of [out.errored, out.throwing, out.historyFailed, out.historyThrowing]) expect(failed.status).toBe(502);
    expect(out.errored.body.error).toContain("gateway usage unavailable");
    expect(out.historyFailed.body.error).toContain("history unavailable");
    expect(out.scansAfterErrors).toBe(1); // only the unconfigured local call scanned

    // Without a gateway admin (local development) the host scan answers, and its failure surfaces.
    expect(out.unconfigured.status).toBe(200);
    expect(out.unconfigured.body.results).toHaveLength(3);
    expect(out.hostFailedLocal.status).toBe(500);
    expect(out.scans.map((x) => x.kind)).toEqual(["usage", "usage"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);