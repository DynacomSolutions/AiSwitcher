import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runGatewayCommand, type GatewayCliDeps } from "../../src/cli/gateway/dispatch.ts";
import { gatewayProviderForHost, historyFromSnapshot, SOURCE_DAILY, SOURCE_MODELS, verifyHistory } from "../../src/cli/gateway/usage-history.ts";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "gw-usage-history") : join(import.meta.dir, "..", "gateway", ".tmp", "gw-usage-history");
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const entry = (model: string, cost: number, over: Record<string, unknown> = {}) => ({ model, provider: "anthropic", input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 0, messageCount: 5, cost, ...over });
const result = (provider: string, name: string, entries: ReturnType<typeof entry>[], dailyTotals?: Record<string, number[]>) => ({
  provider,
  identity: { name, label: name },
  report: { entries, totalCost: entries.reduce((n, e) => n + e.cost, 0), totalMessages: entries.reduce((n, e) => n + e.messageCount, 0) },
  ...(dailyTotals ? { dailyTotals } : {}),
});

const SNAPSHOT = [
  result("anthropic", "personal", [entry("opus", 100.25), entry("sonnet", 50)], { "2026-10-01": [1, 2, 3, 4, 5, 60.5], "2026-10-02": [1, 2, 3, 4, 5, 89.75] }),
  result("openai", "personal", [entry("gpt", 300)]),
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
    expect(gatewayProviderForHost("ais-gateway, openai")).toBe("ais-gateway, openai");
  });
});

describe("historyFromSnapshot", () => {
  test("builds per-model all-time rows and per-day rows with host totals", () => {
    const h = historyFromSnapshot(SNAPSHOT);
    const models = h.rows.filter((r) => r.source === SOURCE_MODELS);
    expect(models.map((r) => `${r.provider}/${r.identity}/${r.model}/${r.day}`)).toEqual([
      "aws-bedrock/bedrock/claude/null",
      "claude/personal/opus/null",
      "claude/personal/sonnet/null",
      "codex/personal/gpt/null",
      "opencode/teamco/kimi/null",
    ]);
    expect(models.find((r) => r.model === "opus")).toMatchObject({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, messages: 5, estCostUsd: 100.25 });
    const daily = h.rows.filter((r) => r.source === SOURCE_DAILY);
    expect(daily.map((r) => `${r.day}/${r.model}/${r.estCostUsd}/${r.messages}`)).toEqual(["2026-10-01/null/60.5/5", "2026-10-02/null/89.75/5"]);
    const total = (source: string) => h.totals.filter((t) => t.source === source).reduce((n, t) => n + t.costUsd, 0);
    expect(total(SOURCE_MODELS)).toBe(459.75);
    expect(total(SOURCE_DAILY)).toBe(150.25);
  });

  test("results that map to one provider and identity are summed, and junk input gives nothing", () => {
    const h = historyFromSnapshot([result("anthropic", "a", [entry("m", 1)]), result("claude-cli", "a", [entry("m", 2)])]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ estCostUsd: 3, inputTokens: 20, messages: 10 });
    expect(h.totals).toEqual([{ source: SOURCE_MODELS, provider: "claude", identity: "a", costUsd: 3, messages: 10 }]);
    expect(historyFromSnapshot(undefined)).toEqual({ rows: [], totals: [] });
  });
});

describe("verifyHistory", () => {
  const totals = [{ source: SOURCE_MODELS, provider: "claude", identity: "a", costUsd: 100, messages: 1 }];
  test("agrees within one dollar", () => {
    const v = verifyHistory(totals, [{ source: SOURCE_MODELS, provider: "claude", identity: "a", estCostUsd: 100.9 }]);
    expect(v.ok).toBe(true);
    expect(v.grand[0]).toMatchObject({ provider: "ALL", hostUsd: 100, ok: true });
  });
  test("flags a missing identity, a short figure and an extra gateway row", () => {
    expect(verifyHistory(totals, []).ok).toBe(false);
    expect(verifyHistory(totals, [{ source: SOURCE_MODELS, provider: "claude", identity: "a", estCostUsd: 98 }]).lines[0]).toMatchObject({ ok: false, diffUsd: -2 });
    const extra = verifyHistory(totals, [
      { source: SOURCE_MODELS, provider: "claude", identity: "a", estCostUsd: 100 },
      { source: SOURCE_MODELS, provider: "codex", identity: "z", estCostUsd: 5 },
    ]);
    expect(extra.ok).toBe(false);
    expect(extra.lines.find((l) => l.identity === "z")).toMatchObject({ hostUsd: 0, gatewayUsd: 5, ok: false });
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
    const { positionals, flags } = parseArgs(line.split(" ").filter(Boolean));
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
    writeFileSync(snapshot, JSON.stringify({ schemaVersion: 1, aggregateResults: SNAPSHOT }));
    writeFileSync(secrets, "AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN=adm-1\n", { mode: 0o600 });
    store = new MemoryGatewayStore();
    out = [];
    posts = 0;
    tamper = undefined;
  });

  test("imports in batches, verifies, and a second run changes nothing", async () => {
    const before = readFileSync(snapshot, "utf8");
    await run(`gateway usage-history import --snapshot=${snapshot} --batch-size=3`);
    expect(posts).toBe(3);
    const stored = await store.usageHistory();
    expect(stored).toHaveLength(7);
    expect(out.join("\n")).toContain("verified");
    expect(out.join("\n")).not.toContain("MISMATCH");
    expect(out.join("\n")).toContain("ALL");
    await run(`gateway usage-history import --snapshot=${snapshot}`);
    expect(await store.usageHistory()).toHaveLength(7);
    expect((await store.usageHistory()).reduce((n, r) => n + r.estCostUsd, 0)).toBe(459.75 + 150.25);
    // The host file is never changed.
    expect(readFileSync(snapshot, "utf8")).toBe(before);
  });

  test("a mismatch over one dollar fails after printing the table", async () => {
    tamper = (body) => ({ rows: body.rows.map((r: any) => (r.provider === "codex" ? { ...r, estCostUsd: r.estCostUsd - 5 } : r)) });
    await expect(run(`gateway usage-history import --snapshot=${snapshot}`)).rejects.toThrow("verification failed");
    expect(out.join("\n")).toContain("MISMATCH");
  });

  test("dry run reads the host only and verify-only sends nothing", async () => {
    await run(`gateway usage-history import --snapshot=${snapshot} --dry-run`);
    expect(posts).toBe(0);
    expect(await store.usageHistory()).toEqual([]);
    expect(out.join("\n")).toContain("$459.75");
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
  });
});
