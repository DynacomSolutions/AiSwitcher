import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsFromUsageBody } from "../../src/cli/limits/claude-limits.ts";
import type { ToolLimitResult } from "../../src/cli/limits/types.ts";
import { extraUsageFromBody, parseUsageBody } from "../../src/identities/claude-usage-api.ts";
import type { Identity } from "../../src/identities/types.ts";
import { loadGatewayLimits, mapGatewayLimitRow, mapGatewayLimits, mergeGatewayLimits, type GatewayLimitRow, type GatewayLimitsView } from "../../src/server/gateway-limits.ts";

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

  test("reset grants map through unchanged, a stale carried list included", () => {
    const grants = {
      availableCount: 1,
      label: "Full reset SYNTHETIC_FIXTURE",
      grants: [{ id: "full-reset-SYNTHETIC_FIXTURE-1", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false, endsAt: "2099-01-01T00:00:00.000Z" }],
      grantsCapturedAt: STAMP,
    };
    expect(mapGatewayLimitRow(claudeRow(upstreamBody(), { manualReset: grants }))!.manualReset).toEqual(grants);
    const carried = { availableCount: 0, grants: grants.grants, stale: true, grantsCapturedAt: STAMP };
    const row = mapGatewayLimitRow(claudeRow(upstreamBody(), { manualReset: carried, stale: true, status: "rate-limited" }))!;
    expect(row.status).toBe("cached");
    expect(row.manualReset).toEqual(carried);
  });

  test("a malformed reset block maps to none; bad grant entries are skipped, never guessed", () => {
    const base = claudeRow(upstreamBody());
    for (const junk of [null, "x", 42, {}, { availableCount: "1" }]) {
      expect(mapGatewayLimitRow({ ...base, manualReset: junk } as unknown as GatewayLimitRow)!.manualReset).toBeUndefined();
    }
    const mixed = {
      availableCount: 1,
      grants: [
        null,
        { id: "" },
        { id: "bad-kind-SYNTHETIC_FIXTURE", kind: "weird", resetsLeft: 1, usableNow: true, paused: false },
        { id: "ok-SYNTHETIC_FIXTURE", kind: "full", resetsLeft: 1, usableNow: true, paused: false },
      ],
    };
    const row = mapGatewayLimitRow({ ...base, manualReset: mixed } as unknown as GatewayLimitRow)!;
    expect(row.manualReset).toEqual({ availableCount: 1, grants: [{ id: "ok-SYNTHETIC_FIXTURE", kind: "full", resetsLeft: 1, usableNow: true, paused: false }] });
    // A malformed grants list keeps the count but carries no list.
    const noList = mapGatewayLimitRow({ ...base, manualReset: { availableCount: 1, grants: "x" } } as unknown as GatewayLimitRow)!;
    expect(noList.manualReset).toEqual({ availableCount: 1 });
  });

  test("an unavailable reading carries no grants", () => {
    const row = mapGatewayLimitRow({ provider: "claude", identity: "m1", status: "unavailable", windows: [], manualReset: { availableCount: 1 } } as unknown as GatewayLimitRow)!;
    expect(row.status).toBe("unavailable");
    expect(row.manualReset).toBeUndefined();
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

  test("approximate-duration labels keep their duration category", () => {
    const r = mapGatewayLimitRow(row("codex", [{ label: "~30d", utilization: 10 }, { label: "~5h", utilization: 20 }, { label: "usage", utilization: 30 }]))!;
    expect(r.windows.map((w) => w.category)).toEqual(["month", "session", "other"]);
  });

  test("a window without a reset time carries none", () => {
    const r = mapGatewayLimitRow(row("kimi", [{ label: "week", utilization: 50 }]))!;
    expect(r.windows[0]!.resetsAt).toBeUndefined();
    expect(r.windows[0]!.resetsAtMs).toBeUndefined();
  });

  test("codex reset credits map through with their expiries; kimi and zai report none", () => {
    const manualReset = {
      availableCount: 1,
      label: "Full reset (Weekly + 5 hr)",
      creditExpiries: [{ id: "credit-SYNTHETIC_FIXTURE-1", label: "Full reset (Weekly + 5 hr)", endsAt: "2099-01-01T00:00:00.000Z" }],
    };
    const codex = mapGatewayLimitRow(row("codex", [{ label: "week", utilization: 15 }], { manualReset }))!;
    expect(codex.manualReset).toEqual(manualReset);
    // Malformed credit entries are skipped; a credit without an expiry never renders.
    const mixed = { availableCount: 1, creditExpiries: [{ id: "ok-SYNTHETIC_FIXTURE", endsAt: "2099-01-01T00:00:00.000Z" }, { id: "no-end-SYNTHETIC_FIXTURE" }, null] };
    const partial = mapGatewayLimitRow({ ...row("codex", [{ label: "week", utilization: 15 }]), manualReset: mixed } as unknown as GatewayLimitRow)!;
    expect(partial.manualReset).toEqual({ availableCount: 1, creditExpiries: [{ id: "ok-SYNTHETIC_FIXTURE", endsAt: "2099-01-01T00:00:00.000Z" }] });
    expect(mapGatewayLimitRow(row("kimi", [{ label: "month", utilization: 30 }]))!.manualReset).toBeUndefined();
    expect(mapGatewayLimitRow(row("zai", [{ label: "week", utilization: 30 }]))!.manualReset).toBeUndefined();
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
    expect(rows.map((r) => r.identity.name)).toEqual(["m1", "m2"]);
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

  test("gateway rows replace the matching host rows and keep the host identity and reset grants", async () => {
    const grants = { availableCount: 1, grants: [{ id: "g", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };
    const host = payload([
      hostRow("claude", "m1", { manualReset: grants }),
      hostRow("claude", "pool"),
      hostRow("codex", "c1"),
    ]);
    const merged = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m1"), gatewayRow("codex", "c1")]), {}, noRegistries)) as typeof host;
    expect(merged.cached).toBe(true);
    expect(merged.results).toHaveLength(3);
    expect(merged.results[0]).toMatchObject({ status: "live", capturedAt: STAMP, identity: identity("m1"), manualReset: grants });
    expect(merged.results[0]!.windows[0]!.usedPercent).toBe(100);
    expect(merged.results[1]).toEqual(host.results[1]); // the pool is not a managed member row
    expect(merged.results[2]!.status).toBe("live");
    expect(merged.results[2]!.identity).toEqual(identity("c1"));
  });

  test("the gateway's grants are authoritative, a stale carried list included", async () => {
    const hostGrants = { availableCount: 1, grants: [{ id: "host-SYNTHETIC_FIXTURE", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };
    const gwGrants = {
      availableCount: 0,
      grants: [{ id: "gateway-SYNTHETIC_FIXTURE", kind: "full" as const, resetsLeft: 1, usableNow: false, paused: false }],
      stale: true,
      grantsCapturedAt: STAMP,
    };
    const host = payload([hostRow("claude", "m1", { manualReset: hostGrants })]);
    const merged = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m1", { manualReset: gwGrants })]), {}, noRegistries)) as typeof host;
    expect(merged.results[0]!.manualReset).toEqual(gwGrants);
  });

  test("the host's grants survive only when the gateway row carries none", async () => {
    const hostGrants = { availableCount: 1, grants: [{ id: "host-SYNTHETIC_FIXTURE", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };
    const host = payload([hostRow("claude", "m1", { manualReset: hostGrants }), hostRow("codex", "c1", { manualReset: hostGrants })]);
    const credits = { availableCount: 1, creditExpiries: [{ id: "credit-SYNTHETIC_FIXTURE-c1", endsAt: "2099-01-01T00:00:00.000Z" }] };
    const merged = (await mergeGatewayLimits(host, view([gatewayRow("claude", "m1"), gatewayRow("codex", "c1", { manualReset: credits })]), {}, noRegistries)) as typeof host;
    expect(merged.results[0]!.manualReset).toEqual(hostGrants); // no gateway grants: the host's stay
    expect(merged.results[1]!.manualReset).toEqual(credits); // the gateway's credits replace the host's
  });

  test("added gateway rows keep their grants", async () => {
    const gwGrants = { availableCount: 1, grants: [{ id: "gateway-SYNTHETIC_FIXTURE", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };
    const merged = (await mergeGatewayLimits(payload([]), view([gatewayRow("claude", "m9", { manualReset: gwGrants })]), {}, noRegistries)) as { results: ToolLimitResult[] };
    expect(merged.results).toHaveLength(1);
    expect(merged.results[0]!.manualReset).toEqual(gwGrants);
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