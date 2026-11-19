import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * GET /api/limits with the gateway merge, end to end through the real app. The host scan worker is
 * mocked in a child process (as the sync tests do) so no real scan runs and the mock never leaks
 * into other test files; HOME is a temp dir so no real registry or credential file is read.
 */
test("GET /api/limits serves the gateway rows over the host scan and falls back honestly", async () => {
  const home = await mkdtemp(join(tmpdir(), "ais-limits-gw-"));
  try {
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      const workersPath = ${JSON.stringify(new URL("../../src/server/workers.ts", import.meta.url).pathname)};
      const workers = await import(workersPath);
      const scans = [];
      const hostRow = (toolName, name) => ({ toolName, provider: toolName === "claude" ? "anthropic" : "openai", identity: { name, label: "Host " + name, configDir: "/profiles/" + name }, windows: [], status: "unavailable", error: "No capture timestamp" });
      mock.module(workersPath, () => ({
        ...workers,
        runScanIsolated: async (kind, params) => {
          scans.push({ kind, ...params });
          let results = [hostRow("claude", "m1"), hostRow("claude", "pool"), hostRow("codex", "c1")];
          if (params.tool) results = results.filter((r) => r.toolName === params.tool);
          if (params.identity) results = results.filter((r) => r.identity.name === params.identity);
          return { ok: true, payload: { results, cached: false, fetchedAt: "2026-11-19T08:00:00.000Z" } };
        },
      }));
      const { createApp } = await import(${JSON.stringify(new URL("../../src/server/app.ts", import.meta.url).pathname)});
      const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
      const headers = { Host: "127.0.0.1:47129" };
      const gatewayRow = { toolName: "claude", provider: "anthropic", identity: { name: "m1", label: "m1", configDir: "" }, windows: [{ label: "week (all)", category: "week", usedPercent: 100, resetsAtMs: Date.parse("2026-11-20T15:00:00.000Z") }], status: "live", capturedAt: "2026-11-19T08:00:00.000Z" };
      const get = async (extra, path) => {
        const app = createApp({ ...base, ...extra });
        const res = await app.request(path, { headers });
        return { status: res.status, body: await res.json() };
      };
      const out = {};
      out.merged = await get({ gatewayLimits: async () => ({ configured: true, rows: [gatewayRow] }) }, "/api/limits?tool=claude&maxAge=30");
      out.unconfigured = await get({ gatewayLimits: async () => ({ configured: false, rows: [] }) }, "/api/limits");
      out.errored = await get({ gatewayLimits: async () => ({ configured: true, rows: [], error: "admin unreachable" }) }, "/api/limits");
      out.throwing = await get({ gatewayLimits: async () => { throw new Error("boom"); } }, "/api/limits");
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
      merged: { status: number; body: { results: Array<{ toolName: string; identity: { name: string; label: string }; status: string; windows: Array<{ usedPercent: number }> }> } };
      unconfigured: { body: { results: Array<{ status: string; error?: string }> } };
      errored: { body: { results: Array<{ status: string }> } };
      throwing: { body: { results: Array<{ status: string }> } };
      scans: Array<{ kind: string; tool?: string; maxAgeS?: number }>;
    };

    // The gateway row replaces the host row of the same tool and identity, keeping the host registry entry.
    expect(out.merged.status).toBe(200);
    expect(out.merged.body.results.map((r) => `${r.toolName}/${r.identity.name}`)).toEqual(["claude/m1", "claude/pool"]);
    expect(out.merged.body.results[0]).toMatchObject({ status: "live", identity: { name: "m1", label: "Host m1" } });
    expect(out.merged.body.results[0]!.windows[0]!.usedPercent).toBe(100);
    expect(out.merged.body.results[1]!.status).toBe("unavailable"); // the pool row the gateway does not cover
    // The filters and maxAge reach the host scan unchanged.
    expect(out.scans[0]).toEqual({ kind: "limits", tool: "claude", maxAgeS: 30 });

    // Unconfigured, failed or throwing gateway reads keep the host scan unchanged.
    for (const fallback of [out.unconfigured, out.errored, out.throwing]) {
      expect(fallback.body.results).toHaveLength(3);
      expect(fallback.body.results.every((r) => r.status === "unavailable")).toBe(true);
    }
    expect(out.unconfigured.body.results[0]!.error).toBe("No capture timestamp");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);