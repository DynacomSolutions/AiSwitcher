import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * GET /api/usage with the gateway merge, end to end through the real app. The host scan worker is
 * mocked in a child process (as the limits tests do) so no real scan runs and the mock never leaks
 * into other test files; HOME is a temp dir so no real registry or credential file is read.
 */
test("GET /api/usage serves the gateway ledger over the host scan and falls back honestly", async () => {
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
      const get = async (extra, path) => {
        const app = createApp({ ...base, ...extra });
        const res = await app.request(path, { headers });
        return { status: res.status, body: await res.json() };
      };
      const out = {};
      out.merged = await get({ gatewayModelUsage: async () => gatewayView }, "/api/usage?tool=claude");
      out.unconfigured = await get({ gatewayModelUsage: async () => ({ configured: false, rows: [] }) }, "/api/usage");
      out.errored = await get({ gatewayModelUsage: async () => ({ configured: true, rows: [], error: "admin unreachable" }) }, "/api/usage");
      out.throwing = await get({ gatewayModelUsage: async () => { throw new Error("boom"); } }, "/api/usage");
      failHost = true;
      out.hostFailed = await get({ gatewayModelUsage: async () => gatewayView }, "/api/usage?tool=claude");
      out.bothFailed = await get({ gatewayModelUsage: async () => ({ configured: true, rows: [], error: "admin unreachable" }) }, "/api/usage");
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
    const out = JSON.parse(stdout) as {
      merged: { status: number; body: { results: Array<{ provider: string; identity: { name: string; label: string }; report: { totalInput: number; entries: Array<{ model: string; client?: string }> }; dailyTotals?: unknown; dateSpan?: { firstMs: number; lastMs: number } }> } };
      unconfigured: { body: { results: Array<{ report: { totalInput: number }; dailyTotals?: unknown }> } };
      errored: { body: { results: Array<{ report: { totalInput: number } }> } };
      throwing: { body: { results: Array<{ report: { totalInput: number } }> } };
      hostFailed: { status: number; body: { results: Array<{ provider: string; identity: { name: string }; report: { totalInput: number }; dailyUsage?: unknown }>; lastError?: string } };
      bothFailed: { status: number };
      scans: Array<{ kind: string; tool?: string; identity?: string }>;
    };

    // The gateway ledger replaces the host report of the same provider and identity, keeping the host registry entry.
    expect(out.merged.status).toBe(200);
    expect(out.merged.body.results.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1", "anthropic/pool"]);
    const m1 = out.merged.body.results[0]!;
    expect(m1.report.totalInput).toBe(10);
    expect(m1.report.entries[0]!.model).toBe("sonnet");
    expect(m1.report.entries[0]!.client).toBeUndefined();
    expect(m1.identity.label).toBe("Host m1");
    expect(m1.dateSpan).toEqual({ firstMs: Date.parse("2026-11-19T07:00:00.000Z"), lastMs: Date.parse("2026-11-19T10:00:00.000Z") });
    // The per-day ledger split replaces the host day splits, in the host shape.
    expect(m1.dailyTotals).toEqual({ "2026-11-19": [6, 3, 0, 0, 1, 0.3], "2026-11-18": [4, 2, 0, 0, 1, 0.2] });
    expect(out.merged.body.results[1]!.report.totalInput).toBe(1); // the pool row the gateway does not cover
    // The tool filter reaches the host scan unchanged.
    expect(out.scans[0]).toEqual({ kind: "usage", tool: "claude" });

    // Unconfigured, failed or throwing gateway reads keep the host scan unchanged.
    for (const fallback of [out.unconfigured, out.errored, out.throwing]) {
      expect(fallback.body.results).toHaveLength(3);
      expect(fallback.body.results.every((r) => r.report.totalInput === 1)).toBe(true);
    }
    expect(out.unconfigured.body.results[0]!.dailyTotals).toBeDefined();

    // A host scan failure never blanks the page when the gateway answered: gateway rows plus a note.
    expect(out.hostFailed.status).toBe(200);
    expect(out.hostFailed.body.results.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/m1"]);
    expect(out.hostFailed.body.results[0]!.report.totalInput).toBe(10);
    expect(out.hostFailed.body.results[0]!.dailyUsage).toEqual({ "2026-11-19": 9, "2026-11-18": 6 });
    expect(out.hostFailed.body.lastError).toBe("host usage scan failed");
    // With no gateway answer either, the failure still surfaces.
    expect(out.bothFailed.status).toBe(500);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);