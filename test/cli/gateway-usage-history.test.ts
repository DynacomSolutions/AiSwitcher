import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runGatewayCommand, type GatewayCliDeps } from "../../src/cli/gateway/dispatch.ts";
import { gatewayProviderForHost, historyFromSnapshot, SOURCE_DAILY, SOURCE_DAILY_TOKENS, SOURCE_MODELS, verifyHistory } from "../../src/cli/gateway/usage-history.ts";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "gw-usage-history") : join(import.meta.dir, "..", "gateway", ".tmp", "gw-usage-history");
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const entry = (model: string, cost: number, over: Record<string, unknown> = {}) => ({ model, provider: "anthropic", input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 0, messageCount: 5, cost, ...over });
const result = (provider: string, name: string, entries: ReturnType<typeof entry>[], dailyTotals?: Record<string, number[]>, extra: Record<string, unknown> = {}) => ({
  provider,
  identity: { name, label: name },
  report: { entries, totalCost: entries.reduce((n, e) => n + e.cost, 0), totalMessages: entries.reduce((n, e) => n + e.messageCount, 0) },
  ...(dailyTotals ? { dailyTotals } : {}),
  ...extra,
});

const GENERATION = "2026-11-19T20:19:38.328Z";
const ZONE = "Asia/Bangkok";
// 2026-04-30T18:00Z is 2026-05-01 in Bangkok; 2026-11-01T12:00Z is 2026-11-01.
const SPAN = { firstMs: Date.UTC(2026, 3, 30, 18), lastMs: Date.UTC(2026, 10, 1, 12) };
const OPTS = { generation: GENERATION, zone: ZONE };

const SNAPSHOT = [
  result("anthropic", "personal", [entry("opus", 100.25), entry("sonnet", 50)], { "2026-10-01": [1, 2, 3, 4, 5, 60.5], "2026-10-02": [1, 2, 3, 4, 5, 89.75] }, { dateSpan: SPAN }),
  // No dailyTotals: only the per-day token counts exist, and they form their own source.
  result("openai", "personal", [entry("gpt", 300)], undefined, { dailyUsage: { "2026-10-03": 700, "2026-10-04": 300, "2026-10-05": 0 } }),
  // Traffic that went through the gateway: the ledger holds it, so it is never imported.
  result("ais-gateway, openai", "viagw", [entry("gpt", 999)], { "2026-11-05": [1, 1, 1, 1, 1, 999] }),
  result("aws-bedrock", "bedrock", [entry("claude", 7.5)]),
  result("opencode-go", "teamco", [entry("kimi", 2)]),
  { provider: "xai", identity: { name: "broken" }, error: "boom" },
  "not a result",
];

describe("provider mapping", () => {
  test("host providers map to gateway providers the way the console does", () => {
    expect(["anthropic", "claude-cli", "openai", "openai-codex", "xai", "grok", "kimi", "moonshot", "zai", "alibaba", "opencode-go", "opencode_go"].map(gatewayProviderForHost)).toEqual(["claude", "claude", "codex", "codex", "grok", "grok", "kimi", "kimi", "zai", "ali", "opencode", "opencode"]);
    // No gateway tool: the canonical host name stays, so nothing is merged or dropped.
    expect(gatewayProviderForHost("aws-bedrock")).toBe("aws-bedrock");
  });
});

describe("historyFromSnapshot", () => {
  test("builds per-model all-time rows and per-day rows with host totals", () => {
    const h = historyFromSnapshot(SNAPSHOT, OPTS);
    const models = h.rows.filter((r) => r.source === SOURCE_MODELS);
    expect(models.map((r) => `${r.provider}/${r.identity}/${r.model}/${r.day}`)).toEqual([
      "aws-bedrock/bedrock/claude/null",
      "claude/personal/opus/null",
      "claude/personal/sonnet/null",
      "codex/personal/gpt/null",
      "opencode/teamco/kimi/null",
    ]);
    expect(models.find((r) => r.model === "opus")).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, messages: 5, estCostUsd: 100.25, generation: GENERATION, zone: ZONE, firstDay: "2026-05-01", lastDay: "2026-11-01" });
    // A result with no date span has no span days.
    expect(models.find((r) => r.model === "kimi")).toMatchObject({ firstDay: null, lastDay: null, zone: ZONE });
    const daily = h.rows.filter((r) => r.source === SOURCE_DAILY);
    expect(daily.map((r) => `${r.day}/${r.model}/${r.estCostUsd}/${r.messages}`)).toEqual(["2026-10-01/null/60.5/5", "2026-10-02/null/89.75/5"]);
    const total = (source: string) => h.totals.filter((t) => t.source === source).reduce((n, t) => n + t.costUsd, 0);
    expect(total(SOURCE_MODELS)).toBe(459.75);
    expect(total(SOURCE_DAILY)).toBe(150.25);
  });

  test("host results labelled ais-gateway are skipped and reported", () => {
    const h = historyFromSnapshot(SNAPSHOT, OPTS);
    expect(h.rows.some((r) => r.identity === "viagw")).toBe(false);
    expect(h.totals.some((t) => t.identity === "viagw")).toBe(false);
    expect(h.skipped).toEqual([{ provider: "ais-gateway, openai", identity: "viagw" }]);
  });

  test("results without dailyTotals give a tokens-only daily source with no cost", () => {
    const h = historyFromSnapshot(SNAPSHOT, OPTS);
    const rows = h.rows.filter((r) => r.source === SOURCE_DAILY_TOKENS);
    expect(rows.map((r) => `${r.provider}/${r.identity}/${r.day}/${r.inputTokens}/${r.estCostUsd}/${r.messages}`)).toEqual(["codex/personal/2026-10-03/700/0/0", "codex/personal/2026-10-04/300/0/0"]);
    expect(h.totals.find((t) => t.source === SOURCE_DAILY_TOKENS)).toMatchObject({ provider: "codex", costUsd: 0, tokens: 1000 });
    // A result that has dailyTotals does not also feed the tokens source.
    expect(rows.some((r) => r.provider === "claude")).toBe(false);
  });

  test("a report total that differs from its entries is a warning, and the entries are what is imported", () => {
    const r = result("anthropic", "a", [entry("m", 100)]);
    r.report.totalCost = 100.4;
    const h = historyFromSnapshot([r, result("openai", "b", [entry("m", 5)])], OPTS);
    expect(h.totals.find((t) => t.provider === "claude")?.costUsd).toBe(100);
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain("claude/a");
    expect(h.warnings[0]).toContain("$0.40");
    expect(historyFromSnapshot([result("anthropic", "a", [entry("m", 1)])], OPTS).warnings).toEqual([]);
  });

  test("results that map to one provider and identity are summed, and junk input gives nothing", () => {
    const h = historyFromSnapshot([result("anthropic", "a", [entry("m", 1)], undefined, { dateSpan: { firstMs: Date.UTC(2026, 5, 1, 5), lastMs: Date.UTC(2026, 5, 2, 5) } }), result("claude-cli", "a", [entry("m", 2)], undefined, { dateSpan: { firstMs: Date.UTC(2026, 4, 1, 5), lastMs: Date.UTC(2026, 5, 1, 5) } })], OPTS);
    expect(h.rows).toHaveLength(1);
    // The merged row spans both results.
    expect(h.rows[0]).toMatchObject({ estCostUsd: 3, inputTokens: 20, messages: 10, firstDay: "2026-05-01", lastDay: "2026-06-02" });
    expect(h.totals).toEqual([{ source: SOURCE_MODELS, provider: "claude", identity: "a", costUsd: 3, messages: 10, tokens: 200 }]);
    expect(historyFromSnapshot(undefined, OPTS)).toEqual({ rows: [], totals: [], warnings: [], skipped: [] });
  });
});

describe("verifyHistory", () => {
  const totals = [{ source: SOURCE_MODELS, provider: "claude", identity: "a", costUsd: 100, messages: 1, tokens: 50 }];
  const held = (over: Record<string, unknown> = {}) => ({ source: SOURCE_MODELS, provider: "claude", identity: "a", estCostUsd: 100, inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over });
  test("agrees within one dollar for cost, exactly for tokens", () => {
    const v = verifyHistory(totals, [held({ estCostUsd: 100.9 })]);
    expect(v.ok).toBe(true);
    expect(v.grand[0]).toMatchObject({ provider: "ALL", hostUsd: 100, ok: true });
    expect(verifyHistory(totals, [held({ inputTokens: 49 })]).ok).toBe(false);
  });
  test("flags a missing identity, a short figure and an extra gateway row", () => {
    expect(verifyHistory(totals, []).ok).toBe(false);
    expect(verifyHistory(totals, [held({ estCostUsd: 98 })]).lines[0]).toMatchObject({ ok: false, diffUsd: -2 });
    const extra = verifyHistory(totals, [held(), held({ provider: "codex", identity: "z", estCostUsd: 5 })]);
    expect(extra.ok).toBe(false);
    expect(extra.lines.find((l) => l.identity === "z")).toMatchObject({ hostUsd: 0, gatewayUsd: 5, ok: false });
  });
  test("a host report total rounding away from the entries does not use up the limit", () => {
    // The host total is the sum of the rows sent, so a cent of rounding in the report never shows here.
    const h = historyFromSnapshot([Object.assign(result("anthropic", "a", [entry("m", 100)]), { report: { entries: [entry("m", 100)], totalCost: 100.9, totalMessages: 5 } })], OPTS);
    expect(h.totals[0]?.costUsd).toBe(100);
    expect(verifyHistory(h.totals, [held({ estCostUsd: 100, inputTokens: 100 })]).lines[0]?.diffUsd).toBe(0);
  });
});

describe("ais gateway usage-history import", () => {
  let dir: string;
  let snapshot: string;
  let secrets: string;
  let out: string[];
  let store: MemoryGatewayStore;
  let posts: number;
  let tamper: ((body: any) => any) | undefined;

  const run = (line: string) => {
    const { positionals, flags } = parseArgs(`${line} --zone=${ZONE}`.split(" ").filter(Boolean));
    const admin = createAdminApp({ store, adminToken: "adm-1", now: () => new Date("2026-11-20T10:00:00.000Z") });
    const deps: Partial<GatewayCliDeps> = {
      secretsPath: secrets,
      out: (s) => out.push(s),
      fetch: (async (url: string, init: RequestInit) => {
        if (init.method === "POST") posts += 1;
        const body = init.body && tamper && init.method === "POST" ? JSON.stringify(tamper(JSON.parse(String(init.body)))) : init.body;
        return admin.request(url, { ...init, body });
      }) as unknown as typeof fetch,
    };
    return runGatewayCommand(positionals.slice(1), flags, deps);
  };

  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, "case-"));
    snapshot = join(dir, "snapshot.json");
    secrets = join(dir, "secrets");
    writeFileSync(snapshot, JSON.stringify({ schemaVersion: 1, generatedAt: "2026-11-19T20:19:03.322Z", aggregateGeneratedAt: GENERATION, aggregateResults: SNAPSHOT }));
    writeFileSync(secrets, "AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN=adm-1\n", { mode: 0o600 });
    store = new MemoryGatewayStore();
    out = [];
    posts = 0;
    tamper = undefined;
  });

  const sum = (rows: { estCostUsd: number }[]) => rows.reduce((n, r) => n + r.estCostUsd, 0);
  const bySource = async (source: string, generation?: string) => store.usageHistory({ source, ...(generation ? { generation } : {}) });

  test("imports in batches, verifies, and a second run of the same generation changes nothing", async () => {
    const before = readFileSync(snapshot, "utf8");
    await run(`gateway usage-history import --snapshot=${snapshot} --batch-size=3`);
    expect(posts).toBe(3);
    // 5 model rows, 2 daily rows, 2 daily-token rows; the ais-gateway result adds none.
    expect(await bySource(SOURCE_MODELS)).toHaveLength(5);
    expect(await bySource(SOURCE_DAILY)).toHaveLength(2);
    expect(await bySource(SOURCE_DAILY_TOKENS)).toHaveLength(2);
    expect((await store.usageHistory()).some((r) => r.identity === "viagw")).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("verified");
    expect(text).not.toContain("MISMATCH");
    expect(text).toContain("ALL");
    expect(text).toContain("skipped ais-gateway, openai/viagw");
    expect(text).toContain(`generation ${GENERATION}`);
    expect(text).toContain(`${SOURCE_DAILY_TOKENS}: 2 rows`);
    await run(`gateway usage-history import --snapshot=${snapshot}`);
    expect(await store.usageHistory()).toHaveLength(9);
    expect(sum(await bySource(SOURCE_MODELS))).toBe(459.75);
    expect(sum(await bySource(SOURCE_DAILY))).toBe(150.25);
    expect(sum(await bySource(SOURCE_DAILY_TOKENS))).toBe(0);
    // The host file is never changed.
    expect(readFileSync(snapshot, "utf8")).toBe(before);
  });

  test("a newer snapshot adds a generation, becomes the latest and is verified on its own; the old rows stay", async () => {
    await run(`gateway usage-history import --snapshot=${snapshot}`);
    const NEXT = "2026-11-21T01:00:00.000Z";
    const changed = JSON.parse(readFileSync(snapshot, "utf8"));
    changed.aggregateGeneratedAt = NEXT;
    changed.aggregateResults[0].report.entries[0].cost = 500;
    changed.aggregateResults[0].report.totalCost = 550;
    writeFileSync(snapshot, JSON.stringify(changed));
    out = [];
    await run(`gateway usage-history import --snapshot=${snapshot}`);
    expect(out.join("\n")).toContain("verified");
    expect((await bySource(SOURCE_MODELS)).every((r) => r.generation === NEXT)).toBe(true);
    expect((await bySource(SOURCE_MODELS)).find((r) => r.model === "opus")?.estCostUsd).toBe(500);
    expect((await bySource(SOURCE_MODELS, GENERATION)).find((r) => r.model === "opus")?.estCostUsd).toBe(100.25);
    expect(await bySource(SOURCE_MODELS, GENERATION)).toHaveLength(5);
  });

  test("verification reads only the sources and generation of this run", async () => {
    // Older and unrelated history in the store never reaches the comparison.
    await store.upsertUsageHistory([{ source: "other-source", generation: "2026-01-01T00:00:00.000Z", provider: "claude", identity: "stranger", day: null, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, messages: 1, estCostUsd: 1000, firstDay: null, lastDay: null, zone: "UTC" }]);
    await store.upsertUsageHistory([{ source: SOURCE_MODELS, generation: "2026-01-01T00:00:00.000Z", provider: "claude", identity: "old", day: null, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, messages: 1, estCostUsd: 1000, firstDay: null, lastDay: null, zone: "UTC" }]);
    await run(`gateway usage-history import --snapshot=${snapshot}`);
    expect(out.join("\n")).not.toContain("stranger");
    expect(out.join("\n")).not.toContain("old ");
    expect(out.join("\n")).toContain("verified");
  });

  test("a mismatch over one dollar fails after printing the table", async () => {
    tamper = (body) => ({ rows: body.rows.map((r: any) => (r.provider === "codex" && r.source === "host-snapshot-models" ? { ...r, estCostUsd: r.estCostUsd - 5 } : r)) });
    await expect(run(`gateway usage-history import --snapshot=${snapshot}`)).rejects.toThrow("verification failed");
    expect(out.join("\n")).toContain("MISMATCH");
  });

  test("dry run reads the host only and verify-only sends nothing", async () => {
    await run(`gateway usage-history import --snapshot=${snapshot} --dry-run`);
    expect(posts).toBe(0);
    expect(await store.usageHistory()).toEqual([]);
    expect(out.join("\n")).toContain("$459.75");
    expect(out.join("\n")).toContain(`${SOURCE_MODELS}: 5 rows`);
    await expect(run(`gateway usage-history import --snapshot=${snapshot} --verify-only`)).rejects.toThrow("verification failed");
    expect(posts).toBe(0);
  });

  test("bad input is a usage error", async () => {
    await expect(run("gateway usage-history")).rejects.toThrow("Usage");
    await expect(run(`gateway usage-history import --snapshot=${join(dir, "missing.json")}`)).rejects.toThrow("cannot read");
    writeFileSync(snapshot, "{}");
    await expect(run(`gateway usage-history import --snapshot=${snapshot}`)).rejects.toThrow("aggregateResults");
    writeFileSync(snapshot, "nope");
    await expect(run(`gateway usage-history import --snapshot=${snapshot}`)).rejects.toThrow("not valid JSON");
    await expect(run(`gateway usage-history import --snapshot=${snapshot} --batch-size=0`)).rejects.toThrow("batch-size");
    writeFileSync(snapshot, JSON.stringify({ aggregateResults: SNAPSHOT }));
    await expect(run(`gateway usage-history import --snapshot=${snapshot}`)).rejects.toThrow("aggregateGeneratedAt");
    writeFileSync(snapshot, JSON.stringify({ aggregateGeneratedAt: GENERATION, aggregateResults: SNAPSHOT }));
    await expect(runGatewayCommand(["usage-history", "import"], { snapshot, zone: "Mars/Base" }, { secretsPath: secrets, out: () => {} })).rejects.toThrow("zone");
  });
});
