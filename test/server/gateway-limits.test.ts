import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsFromUsageBody } from "../../src/cli/limits/claude-limits.ts";
import type { ToolLimitResult } from "../../src/cli/limits/types.ts";
import { extraUsageFromBody, parseUsageBody } from "../../src/identities/claude-usage-api.ts";
import type { Identity } from "../../src/identities/types.ts";
import { loadGatewayLimits, mapGatewayLimitRow, mapGatewayLimits, mergeGatewayLimits, useClaudeResetViaGateway, useCodexResetViaGateway, type GatewayLimitRow, type GatewayLimitsView } from "../../src/server/gateway-limits.ts";

const RESET_SESSION = "2026-11-19T18:00:00.000Z";
const RESET_WEEK = "2026-11-20T15:00:00.000Z";
const STAMP = "2026-11-19T08:00:00.000Z";

/** A real upstream usage body: five_hour/seven_day plus limits[] with a weekly_scoped Fable entry. */
const upstreamBody = (extra: Record<string, unknown> | null = { is_enabled: true, spend_limit_reached: false, monthly_limit: 2000, used_credits: 500 }) => ({
  five_hour: { utilization: 42, resets_at: RESET_SESSION },
  seven_day: { utilization: 100, resets_at: RESET_WEEK },
  limits: [
    { kind: "session", percent: 42, resets_at: RESET_SESSION },
    { kind: "weekly_all", percent: 100, resets_at: RESET_WEEK },
    { kind: "weekly_scoped", percent: 10, resets_at: RESET_WEEK, scope: { model: { display_name: "Fable" } } },
  ],
  ...(extra ? { extra_usage: extra } : {}),
});

/** The PoolUsage row the gateway's claude adapter produces from an upstream body (same labels and fields). */
const claudeRow = (body: unknown, over: Partial<GatewayLimitRow> = {}): GatewayLimitRow => {
  const u = parseUsageBody(body, STAMP);
  return {
    provider: "claude",
    identity: "m1",
    status: u.status,
    capturedAt: u.capturedAt,
    ...(u.maxUtilization !== undefined ? { maxUtilization: u.maxUtilization } : {}),
    windows: [
      ...(u.fiveHour ? [{ label: "five-hour", utilization: u.fiveHour.utilization, ...(u.fiveHour.resetsAt ? { resetsAt: u.fiveHour.resetsAt } : {}) }] : []),
      ...(u.sevenDay ? [{ label: "seven-day", utilization: u.sevenDay.utilization, ...(u.sevenDay.resetsAt ? { resetsAt: u.sevenDay.resetsAt } : {}) }] : []),
      ...(u.scoped ?? []).map((w) => ({ label: `seven-day (${w.model})`, model: w.model, utilization: w.utilization, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })),
    ],
    ...(u.extraUsage ? { extraUsage: u.extraUsage } : {}),
    ...(u.error ? { error: u.error } : {}),
    ...over,
  };
};

describe("mapGatewayLimitRow: claude", () => {
  test("windows render identically to the host adapter's windowsFromUsageBody", () => {
    const body = upstreamBody();
    const row = mapGatewayLimitRow(claudeRow(body))!;
    expect(row.toolName).toBe("claude");
    expect(row.provider).toBe("anthropic");
    expect(row.identity.name).toBe("m1");
    expect(row.status).toBe("live");
    expect(row.capturedAt).toBe(STAMP);
    expect(row.windows).toEqual(windowsFromUsageBody(body));
    expect(row.windows.map((w) => [w.label, w.category, w.usedPercent, w.resetsAtMs, w.model])).toEqual([
      ["session (5h)", "session", 42, Date.parse(RESET_SESSION), undefined],
      ["week (all)", "week", 100, Date.parse(RESET_WEEK), undefined],
      ["week (Fable)", "week", 10, Date.parse(RESET_WEEK), "Fable"],
    ]);
    expect(row.windows[0]!.resetsAt).toBe(new Date(RESET_SESSION).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  });

  test("extra usage maps to the claude adapter's overage semantics", () => {
    const enabled = mapGatewayLimitRow(claudeRow(upstreamBody()))!;
    expect(enabled.overage).toEqual({ active: true, label: "using extra usage" });
    expect(enabled.extraUsage).toEqual(extraUsageFromBody(upstreamBody()));
    expect(enabled.extraUsage!.usedPercent).toBe(25);

    const spent = mapGatewayLimitRow(claudeRow(upstreamBody({ is_enabled: true, spend_limit_reached: true })))!;
    expect(spent.overage).toEqual({ active: false, label: "out of extra usage" });

    const full = mapGatewayLimitRow(claudeRow(upstreamBody({ is_enabled: true, monthly_limit: 100, used_credits: 100 })))!;
    expect(full.overage).toEqual({ active: false, label: "out of extra usage" });
    expect(full.extraUsage!.usedPercent).toBe(100);

    const off = mapGatewayLimitRow(claudeRow(upstreamBody({ is_enabled: false })))!;
    expect(off.overage).toEqual({ active: false, label: "subscription only", spentUsd: 0 });

    const absent = mapGatewayLimitRow(claudeRow(upstreamBody(null)))!;
    expect(absent.overage).toBeUndefined();
    expect(absent.extraUsage).toBeUndefined();
  });

  test("a stale reading shows as cached with its figures and capture time", () => {
    const row = mapGatewayLimitRow(claudeRow(upstreamBody(), { stale: true, status: "rate-limited" }))!;
    expect(row.status).toBe("cached");
    expect(row.capturedAt).toBe(STAMP);
    expect(row.windows).toEqual(windowsFromUsageBody(upstreamBody()));
    expect(row.overage).toEqual({ active: true, label: "using extra usage" });
  });

  test("no figure is unavailable with an honest reason", () => {
    const empty = mapGatewayLimitRow(claudeRow({}))!;
    expect(empty.status).toBe("unavailable");
    expect(empty.windows).toEqual([]);
    expect(empty.error).toBe("usage response carried no five_hour/seven_day utilisation");
    const cold = mapGatewayLimitRow({ provider: "claude", identity: "m1", status: "unavailable", windows: [] })!;
    expect(cold.status).toBe("unavailable");
    expect(cold.error).toBe("no usage reading from the gateway yet");
    const failed = mapGatewayLimitRow({ provider: "claude", identity: "m1", status: "unavailable", windows: [], error: "not authenticated" })!;
    expect(failed.error).toBe("not authenticated");
  });
});

describe("mapGatewayLimitRow: codex, kimi, zai", () => {
  const row = (provider: string, windows: GatewayLimitRow["windows"], over: Partial<GatewayLimitRow> = {}): GatewayLimitRow => ({
    provider, identity: "w1", status: "rate-limited", maxUtilization: 100, windows, capturedAt: STAMP, ...over,
  });

  test("labels and categories match the host adapters; a figure at 100% is live", () => {
    const codex = mapGatewayLimitRow(row("codex", [
      { label: "session", utilization: 15, resetsAt: RESET_SESSION },
      { label: "week", utilization: 100, resetsAt: RESET_WEEK },
    ]))!;
    expect(codex.toolName).toBe("codex");
    expect(codex.provider).toBe("openai");
    expect(codex.status).toBe("live");
    expect(codex.windows).toEqual([
      { label: "session", category: "session", usedPercent: 15, resetsAt: new Date(RESET_SESSION).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), resetsAtMs: Date.parse(RESET_SESSION) },
      { label: "week", category: "week", usedPercent: 100, resetsAt: new Date(RESET_WEEK).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), resetsAtMs: Date.parse(RESET_WEEK) },
    ]);
    const kimi = mapGatewayLimitRow(row("kimi", [{ label: "month", utilization: 30 }, { label: "month (code)", utilization: 5 }]))!;
    expect(kimi.provider).toBe("kimi");
    expect(kimi.windows.map((w) => [w.label, w.category])).toEqual([["month", "month"], ["month (code)", "month"]]);
    const zai = mapGatewayLimitRow(row("zai", [{ label: "session", utilization: 0 }, { label: "week", utilization: 100, resetsAt: RESET_WEEK }]))!;
    expect(zai.provider).toBe("zai");
    expect(zai.windows.map((w) => w.category)).toEqual(["session", "week"]);
  });

  test("codex credits stay as extra usage and never become an overage", () => {
    const row = mapGatewayLimitRow({ provider: "codex", identity: "a", status: "live", windows: [{ label: "week", utilization: 0 }], extraUsage: { enabled: true, available: true, label: "credits 12" } })!;
    expect(row.extraUsage).toEqual({ enabled: true, available: true, label: "credits 12" });
    expect(row.overage).toBeUndefined();
    // claude keeps its overage semantics
    const claude = mapGatewayLimitRow({ provider: "claude", identity: "a", status: "live", windows: [{ label: "five-hour", utilization: 1 }], extraUsage: { enabled: true, available: true, label: "x" } })!;
    expect(claude.overage).toEqual({ active: true, label: "using extra usage" });
  });

  test("Codex gateway reset credits carry known zero and exact provider expiry", () => {
    const expiresAt = "2026-12-01T22:27:07.649Z";
    const row = mapGatewayLimitRow({ provider: "codex", identity: "a", status: "live", windows: [{ label: "week", utilization: 0 }], manualReset: {
      availableCount: 1,
      creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001", label: "Full reset", endsAt: expiresAt }],
    } })!;
    expect(row.manualReset).toMatchObject({ availableCount: 1, creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001", endsAt: expiresAt }] });
    expect(mapGatewayLimitRow({ provider: "codex", identity: "a", status: "live", windows: [{ label: "week", utilization: 0 }], manualReset: { availableCount: 0 } })?.manualReset).toEqual({ availableCount: 0 });
  });

  test("scheduled provider windows stay visible without inventing manual reset credits", () => {
    for (const provider of ["kimi", "grok", "zai", "ali", "opencode"]) {
      const row = mapGatewayLimitRow({
        provider,
        identity: "provider-SYNTHETIC_FIXTURE",
        status: "live",
        windows: [{ label: "week", utilization: 25, resetsAt: RESET_WEEK }],
        manualReset: { availableCount: 3 },
      })!;
      expect(row.windows[0]?.resetsAtMs).toBe(Date.parse(RESET_WEEK));
      expect(row.manualReset).toBeUndefined();
    }
  });

  test("approximate-duration labels keep their duration category", () => {
    const r = mapGatewayLimitRow(row("codex", [{ label: "~30d", utilization: 10 }, { label: "~5h", utilization: 20 }, { label: "usage", utilization: 30 }]))!;
    expect(r.windows.map((w) => w.category)).toEqual(["month", "session", "other"]);
  });

  test("a window without a reset time carries none", () => {
    const r = mapGatewayLimitRow(row("kimi", [{ label: "week", utilization: 50 }]))!;
    expect(r.windows[0]!.resetsAt).toBeUndefined();
    expect(r.windows[0]!.resetsAtMs).toBeUndefined();
  });
});

describe("mapGatewayLimits", () => {
  test("drops malformed rows and unknown providers", () => {
    expect(mapGatewayLimits(null)).toEqual([]);
    expect(mapGatewayLimits({})).toEqual([]);
    expect(mapGatewayLimits({ limits: "x" })).toEqual([]);
    const rows = mapGatewayLimits({
      limits: [
        claudeRow(upstreamBody()),
        { provider: "grok", identity: "g1", status: "live", windows: [] },
        { provider: "claude", status: "live", windows: [] },
        { provider: "claude", identity: "", status: "live", windows: [] },
        { provider: "claude", identity: "m2", status: "live", windows: [{ label: "seven-day", utilization: "nope" }] },
        null,
      ],
    });
    expect(rows.map((r) => r.identity.name)).toEqual(["m1", "g1", "m2"]);
    expect(rows[1]!.status).toBe("unavailable"); // the only window was malformed
  });
});

describe("loadGatewayLimits", () => {
  const secrets = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "gwlimits-"));
    const p = join(dir, "secrets");
    writeFileSync(p, body);
    return p;
  };
  const creds = "AIS_GATEWAY_ADMIN_URL=http://gw.invalid/\nAIS_GATEWAY_ADMIN_TOKEN=SYNTHETIC_FIXTURE_token\n";

  test("not configured without url and token", async () => {
    const saved = [process.env.AIS_GATEWAY_ADMIN_URL, process.env.AIS_GATEWAY_ADMIN_TOKEN];
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      expect(await loadGatewayLimits({ secretsPath: secrets("") })).toEqual({ configured: false, rows: [] });
    } finally {
      if (saved[0] !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = saved[0];
      if (saved[1] !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = saved[1];
    }
  });

  test("calls /limits with the bearer token and maps the rows", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fake = (async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("authorization") };
      return Response.json({ limits: [claudeRow(upstreamBody())] });
    }) as unknown as typeof fetch;
    const view = await loadGatewayLimits({ fetch: fake, secretsPath: secrets(creds) });
    expect(seen).toEqual({ url: "http://gw.invalid/limits", auth: "Bearer SYNTHETIC_FIXTURE_token" });
    expect(view.configured).toBe(true);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.windows).toEqual(windowsFromUsageBody(upstreamBody()));
  });

  test("failures become a short error without the token", async () => {
    const path = secrets("AIS_GATEWAY_ADMIN_URL=http://gw.invalid\nAIS_GATEWAY_ADMIN_TOKEN=sekrit\n");
    const down = (async () => { throw new Error("connect sekrit"); }) as unknown as typeof fetch;
    const bad = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const old = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const a = await loadGatewayLimits({ fetch: down, secretsPath: path });
    const b = await loadGatewayLimits({ fetch: bad, secretsPath: path });
    const c = await loadGatewayLimits({ fetch: old, secretsPath: path });
    expect(a.error).toBe("admin unreachable");
    expect(b.error).toBe("admin answered 401");
    expect(c.error).toContain("older version");
    expect(JSON.stringify([a, b, c])).not.toContain("sekrit");
  });
});

describe("mergeGatewayLimits", () => {
  const identity = (name: string): Identity => ({ name, label: `Label ${name}`, configDir: `/profiles/${name}` });
  const hostRow = (toolName: ToolLimitResult["toolName"], name: string, over: Partial<ToolLimitResult> = {}): ToolLimitResult => ({
    toolName,
    provider: toolName === "claude" ? "anthropic" : "openai",
    identity: identity(name),
    windows: [],
    status: "unavailable",
    error: "No capture timestamp",
    ...over,
  });
  const gatewayRow = (toolName: ToolLimitResult["toolName"], name: string, over: Partial<ToolLimitResult> = {}): ToolLimitResult => ({
    toolName,
    provider: toolName === "claude" ? "anthropic" : "openai",
    identity: { name, label: name, configDir: "" },
    windows: [{ label: "week (all)", category: "week", usedPercent: 100, resetsAtMs: Date.parse(RESET_WEEK) }],
    status: "live",
    capturedAt: STAMP,
    ...over,
  });
  const payload = (results: ToolLimitResult[]) => ({ results, cached: true, fetchedAt: STAMP });
  const view = (rows: ToolLimitResult[], over: Partial<GatewayLimitsView> = {}): GatewayLimitsView => ({ configured: true, rows, ...over });
  const noRegistries = async () => [];

  test("gateway rows replace the matching host rows and keep the host identity; reset grants come from the gateway only", async () => {
    const grants = { availableCount: 1, grants: [{ id: "g", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };
    const host = payload([
      hostRow("claude", "m1", { manualReset: grants }),
      hostRow("claude", "pool"),
      hostRow("codex", "c1"),
    ]);
    const merged = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m1"), gatewayRow("codex", "c1")]), {}, noRegistries)) as typeof host;
    expect(merged.cached).toBe(true);
    expect(merged.results).toHaveLength(3);
    expect(merged.results[0]).toMatchObject({ status: "live", capturedAt: STAMP, identity: identity("m1") });
    // No host fallback: the host row's grants never reach a gateway-managed identity.
    expect(merged.results[0]!.manualReset).toBeUndefined();
    expect(merged.results[2]!.manualReset).toBeUndefined();
    const withGateway = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m1", { manualReset: { availableCount: 2 } })]), {}, noRegistries)) as typeof host;
    expect(withGateway.results[0]!.manualReset).toEqual({ availableCount: 2 });
    expect(merged.results[0]!.windows[0]!.usedPercent).toBe(100);
    expect(merged.results[1]).toEqual(host.results[1]); // the pool is not a managed member row
    expect(merged.results[2]!.status).toBe("live");
    expect(merged.results[2]!.identity).toEqual(identity("c1"));
  });

  test("an empty gateway response keeps valid host Grok and Ali windows", async () => {
    const host = payload([
      hostRow("grok", "g1", { provider: "xai", status: "live", windows: [{ label: "week", category: "week", usedPercent: 35, resetsAtMs: Date.parse(RESET_WEEK) }] }),
      hostRow("ali", "a1", { provider: "alibaba", status: "live", windows: [{ label: "week", category: "week", usedPercent: 45, resetsAtMs: Date.parse(RESET_WEEK) }] }),
    ]);
    const merged = (await mergeGatewayLimits(host, view([]), {}, noRegistries)) as typeof host;
    expect(merged.results).toEqual(host.results);
  });

  test("gateway rows with no host row are added with their registry entry when one exists", async () => {
    const host = payload([hostRow("claude", "m1")]);
    const registries = async () => [{ cfg: { toolName: "claude" } as never, file: { identities: [identity("m9")] } as never }];
    const merged = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m9"), gatewayRow("codex", "c9")]), {}, registries)) as typeof host;
    expect(merged.results.map((r) => `${r.toolName}/${r.identity.name}`)).toEqual(["claude/m1", "claude/m9", "codex/c9"]);
    expect(merged.results[1]!.identity).toEqual(identity("m9"));
    expect(merged.results[2]!.identity).toEqual({ name: "c9", label: "c9", configDir: "" });
  });

  test("an unconfigured or failed gateway read leaves the host payload unchanged", async () => {
    const host = payload([hostRow("claude", "m1")]);
    expect(await mergeGatewayLimits(host, { configured: false, rows: [] }, {}, noRegistries)).toBe(host);
    expect(await mergeGatewayLimits(host, view([gatewayRow("claude", "m1")], { error: "admin unreachable" }), {}, noRegistries)).toBe(host);
    expect(await mergeGatewayLimits({ cached: true }, view([gatewayRow("claude", "m1")]), {}, noRegistries)).toEqual({ cached: true });
  });

  test("the tool and identity filters apply to the gateway rows too", async () => {
    const host = payload([hostRow("claude", "m1"), hostRow("codex", "c1")]);
    const rows = [gatewayRow("claude", "m1"), gatewayRow("claude", "m9"), gatewayRow("codex", "c9")];
    const byTool = (await mergeGatewayLimits(host, view(rows), { tool: "claude" }, noRegistries)) as typeof host;
    expect(byTool.results.map((r) => `${r.toolName}/${r.identity.name}`)).toEqual(["claude/m1", "codex/c1", "claude/m9"]);
    const byIdentity = (await mergeGatewayLimits(host, view(rows), { identity: "m1" }, noRegistries)) as typeof host;
    expect(byIdentity.results.map((r) => r.identity.name)).toEqual(["m1", "c1"]);
    expect(byIdentity.results[0]!.status).toBe("live");
  });
});
describe("reset grants from the gateway", () => {
  const grantRow = {
    ...claudeRow(upstreamBody()),
    manualReset: {
      availableCount: 1,
      label: "Full reset",
      grantsCapturedAt: STAMP,
      stale: true,
      grants: [
        { id: "full-reset-2611", label: "Full reset", kind: "full", resetsLeft: 1, usableNow: true, paused: false, endsAt: "2026-12-01T00:00:00.000Z" },
        { id: "launch-2610-fable", kind: "fable", resetsLeft: 0, usableNow: false, paused: false },
        { nope: true },
      ],
    },
  };

  test("a claude row carries the count and every grant to the console row", () => {
    const row = mapGatewayLimitRow(grantRow);
    expect(row?.manualReset).toMatchObject({ availableCount: 1, label: "Full reset", stale: true, grantsCapturedAt: STAMP });
    expect(row?.manualReset?.grants?.map((g) => [g.id, g.kind, g.usableNow])).toEqual([["full-reset-2611", "full", true], ["launch-2610-fable", "fable", false]]);
  });

  test("a malformed block carries none and Codex ignores Claude grant fields", () => {
    expect(mapGatewayLimitRow(claudeRow(upstreamBody()))?.manualReset).toBeUndefined();
    expect(mapGatewayLimitRow({ ...grantRow, manualReset: { grants: [] } })?.manualReset).toBeUndefined();
    expect(mapGatewayLimitRow({ provider: "codex", identity: "c1", status: "live", windows: [{ label: "week", utilization: 5 }], manualReset: grantRow.manualReset })?.manualReset).toEqual({ availableCount: 1, label: "Full reset", stale: true });
  });

  test("the spend goes to the gateway admin route with the admin token only", async () => {
    const calls: Array<{ url: string; method?: string; auth: string | null }> = [];
    const fake = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ identity: "m 1", grantId: "g/1", result: "reset", cleared: [] });
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "ais-gwspend-"));
    const secretsPath = join(dir, "secrets");
    writeFileSync(secretsPath, "AIS_GATEWAY_ADMIN_URL=https://gw.test/admin/\nAIS_GATEWAY_ADMIN_TOKEN=SYNTHETIC_FIXTURE_token\n");
    expect(await useClaudeResetViaGateway("m 1", "g/1", { fetch: fake, secretsPath })).toMatchObject({ result: "reset" });
    expect(calls).toEqual([{ url: "https://gw.test/admin/limits/claude/m%201/resets/g%2F1", method: "POST", auth: "Bearer SYNTHETIC_FIXTURE_token" }]);
  });

  test("Codex consume returns mapped account-scoped usage from reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-gwspend-"));
    const secretsPath = join(dir, "secrets");
    writeFileSync(secretsPath, "AIS_GATEWAY_ADMIN_URL=https://gw.test/admin\nAIS_GATEWAY_ADMIN_TOKEN=SYNTHETIC_FIXTURE_token\n");
    const redeemRequestId = "edcd553c-a594-4e1c-9aa8-0101110d4ca6";
    const fake = (async () => Response.json({
      identity: "codex-member",
      result: "reset",
      windowsReset: 1,
      reconciliation: {
        status: "confirmed",
        usage: { status: "live", maxUtilization: 0, capturedAt: STAMP, windows: [{ label: "~7d", utilization: 0 }] },
      },
    })) as unknown as typeof fetch;
    const result = await useCodexResetViaGateway("codex-member", redeemRequestId, { fetch: fake, secretsPath });
    expect(result).toMatchObject({
      result: "reset",
      reconciliation: {
        status: "confirmed",
        usage: { toolName: "codex", identity: { name: "codex-member" }, status: "live", windows: [{ usedPercent: 0, category: "week" }] },
      },
    });
  });

  test("gateway refusals keep their status and reason; no admin config is 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-gwspend-"));
    const secretsPath = join(dir, "secrets");
    const prevUrl = process.env.AIS_GATEWAY_ADMIN_URL;
    const prevToken = process.env.AIS_GATEWAY_ADMIN_TOKEN;
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      writeFileSync(secretsPath, "");
      await expect(useClaudeResetViaGateway("m1", "g", { secretsPath })).rejects.toMatchObject({ status: 503 });
      writeFileSync(secretsPath, "AIS_GATEWAY_ADMIN_URL=https://gw.test\nAIS_GATEWAY_ADMIN_TOKEN=SYNTHETIC_FIXTURE_token\n");
      const refuse = (async () => Response.json({ error: "Anthropic refused the reset (HTTP 409): cooldown" }, { status: 409 })) as unknown as typeof fetch;
      await expect(useClaudeResetViaGateway("m1", "g", { fetch: refuse, secretsPath })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("cooldown") });
      const down = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
      await expect(useClaudeResetViaGateway("m1", "g", { fetch: down, secretsPath })).rejects.toMatchObject({ status: 502 });
    } finally {
      if (prevUrl !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = prevUrl;
      if (prevToken !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = prevToken;
    }
  });
});

describe("mapGatewayLimitRow: plan labels", () => {
  test("a claude row's profile plan maps to the short display label", () => {
    const row = claudeRow(upstreamBody(), { plan: { type: "claude_max", tier: "default_claude_max_20x", checkedAt: STAMP } });
    expect(mapGatewayLimitRow(row)!.plan).toBe("Max 20x");
    expect(mapGatewayLimitRow(claudeRow(upstreamBody(), { plan: { type: "claude_pro", checkedAt: STAMP } }))!.plan).toBe("Pro");
    expect(mapGatewayLimitRow(claudeRow(upstreamBody()))!.plan).toBeUndefined();
  });

  test("an unavailable claude row keeps a known plan; an unknown type yields none", () => {
    const cold = { provider: "claude", identity: "m1", status: "unavailable" as const, windows: [], plan: { type: "claude_team", checkedAt: STAMP } };
    expect(mapGatewayLimitRow(cold)!.plan).toBe("Team");
    expect(mapGatewayLimitRow({ ...cold, plan: { type: "claude_future", checkedAt: STAMP } })!.plan).toBeUndefined();
  });

  test("codex, kimi and zai rows ride the short planLabel; absent stays absent", () => {
    const row = (provider: string, over: Partial<GatewayLimitRow> = {}): GatewayLimitRow => ({
      provider, identity: "w1", status: "live", windows: [{ label: "session", utilization: 10, resetsAt: RESET_SESSION }], capturedAt: STAMP, ...over,
    });
    expect(mapGatewayLimitRow(row("codex", { planLabel: "Pro" }))!.plan).toBe("Pro");
    expect(mapGatewayLimitRow(row("kimi", { planLabel: "Standard" }))!.plan).toBe("Standard");
    expect(mapGatewayLimitRow(row("zai", { planLabel: "Max" }))!.plan).toBe("Max");
    expect(mapGatewayLimitRow(row("codex"))!.plan).toBeUndefined();
    expect(mapGatewayLimitRow(row("kimi", { planLabel: "" }))!.plan).toBeUndefined();
  });
});
