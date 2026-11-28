import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { runGatewayCommand } from "../../src/cli/gateway/dispatch.ts";
import { buildSessionCost, cost, formatSessionCost } from "../../src/cli/gateway/session-cost.ts";
import { mapGatewaySessions } from "../../src/gateway/usage-view.ts";

const SCRATCH = process.env.AIS_TEST_SCRATCH_DIR ? join(process.env.AIS_TEST_SCRATCH_DIR, "gw-usage-sessions") : join(import.meta.dir, "..", "gateway", ".tmp", "gw-usage-sessions");

const use = (identity: string, over: Record<string, unknown> = {}) => ({
  identity,
  turns: 2,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 1000,
  cacheWriteTokens: 5,
  estCostUsd: 0.5,
  unpricedRequests: 0,
  failedRequests: 0,
  toolCalls: 3,
  toolErrors: 1,
  models: ["model-a"],
  firstTs: "2026-11-20T01:00:00.000Z",
  lastTs: "2026-11-20T02:00:00.000Z",
  ...over,
});
const sess = (key: string, provider: string, identities: Array<Record<string, unknown>>) => ({ sessionKey: key, provider, app: "app-one", client: "claude-cli", activeIdentity: "x", identities, turns: 2, firstTs: "2026-11-20T01:00:00.000Z", lastTs: "2026-11-20T02:00:00.000Z" });

const body = {
  sessions: [
    sess("task-synthetic-0001", "claude", [use("alice", { lastTs: "2026-11-20T04:00:00.000Z" }), use("bob", { estCostUsd: 0.25, failedRequests: 2, models: ["model-b"] })]),
    sess("task-synthetic-0002", "claude", [use("bob", { estCostUsd: 1.5, unpricedRequests: 1 })]),
    sess("other-synthetic-0003", "codex", [use("carol", { estCostUsd: 2, toolCalls: 0, toolErrors: 0, models: [] })]),
  ],
};

describe("session cost report", () => {
  const report = buildSessionCost(mapGatewaySessions(body));

  test("one row per session and account, totals per provider and overall", () => {
    expect(report.rows.map((r) => `${r.provider}/${r.sessionKey}/${r.identity}`)).toEqual([
      "claude/task-synthetic-0001/alice",
      "claude/task-synthetic-0001/bob",
      "claude/task-synthetic-0002/bob",
      "codex/other-synthetic-0003/carol",
    ]);
    expect(report.rows[0]).toMatchObject({ tokens: 1115, requests: 2, toolCalls: 3, toolErrors: 1, models: ["model-a"] });
    expect(report.byProvider.map((p) => [p.provider, p.sessions, p.requests, p.failedRequests, p.estCostUsd, p.unpricedRequests])).toEqual([
      ["claude", 2, 6, 2, 2.25, 1],
      ["codex", 1, 2, 0, 2, 0],
    ]);
    expect(report.all).toMatchObject({ sessions: 3, estCostUsd: 4.25, unpricedRequests: 1 });
  });

  test("text labels the cost as an estimate, marks a floor, shows failures and a task total", () => {
    const text = formatSessionCost(report, { limit: 50, task: true });
    expect(text).toContain("EST COST USD");
    expect(text).toContain("1.5000+");
    expect(text).toContain("task total: 3 session(s)");
    expect(text).toContain("total claude: 2 session(s)");
    expect(text).toContain("ESTIMATE");
    expect(text.split("\n").find((l) => l.includes("task-synthetic-0001") && l.includes("bob"))).toMatch(/\b2\b.*\b2\b/);
  });

  test("a row limit hides rows but not totals; an empty window says so", () => {
    const text = formatSessionCost(report, { limit: 1, task: false });
    expect(text).toContain("showing 1 of 4 rows");
    expect(text).toContain("total all providers: 3 session(s)");
    expect(formatSessionCost(buildSessionCost([]), { limit: 5, task: false })).toBe("no sessions with a session id in this window");
  });

  test("cost format", () => {
    expect(cost(0.5, 0)).toBe("0.5000");
    expect(cost(0.5, 2)).toBe("0.5000+");
  });
});

describe("ais gateway usage sessions", () => {
  let dir: string;
  let secrets: string;
  let out: string[];
  let urls: string[];
  let respond: () => Response;
  const run = (line: string) => {
    const { positionals, flags } = parseArgs(line.split(" ").filter(Boolean));
    return runGatewayCommand(positionals.slice(1), flags, {
      secretsPath: secrets,
      fetch: (async (url: string) => {
        urls.push(url);
        return respond();
      }) as unknown as typeof fetch,
      out: (s) => out.push(s),
      now: () => 1_700_000_000_000,
    });
  };
  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(join(SCRATCH, "case-"));
    secrets = join(dir, "secrets");
    writeFileSync(secrets, "AIS_GATEWAY_ADMIN_URL=http://admin.test\nAIS_GATEWAY_ADMIN_TOKEN='adm-1'\n", { mode: 0o600 });
    out = [];
    urls = [];
    respond = () => Response.json({ ...body, prefix: new URL(urls[urls.length - 1]!).searchParams.get("prefix") ?? undefined });
    return () => rmSync(dir, { recursive: true, force: true });
  });

  test("asks the admin sessions route with the filters and prints the table", async () => {
    await run("gateway usage sessions --days=3 --provider=claude --app=app-one --prefix=task- --limit=10");
    expect(urls).toEqual(["http://admin.test/usage/sessions?days=3&app=app-one&provider=claude&prefix=task-"]);
    expect(out.join("\n")).toContain("task total");
  });

  test("a session list goes as repeated ids, and splits above 500 ids", async () => {
    await run("gateway usage sessions --session=id-aaaaaaaa,id-bbbbbbbb");
    expect(urls[0]).toBe("http://admin.test/usage/sessions?days=7&session=id-aaaaaaaa&session=id-bbbbbbbb");
    urls = [];
    const many = Array.from({ length: 501 }, (_, i) => `id-${String(i).padStart(8, "0")}`).join(",");
    await run(`gateway usage sessions --session=${many}`);
    expect(urls).toHaveLength(2);
  });

  test("a repeated id counts once, an empty prefix is refused", async () => {
    await run("gateway usage sessions --session=id-aaaaaaaa,id-aaaaaaaa");
    expect(urls[0]).toBe("http://admin.test/usage/sessions?days=7&session=id-aaaaaaaa");
    await expect(run("gateway usage sessions --prefix=")).rejects.toThrow(/--prefix/);
  });

  test("an older gateway that ignores the prefix or sends no cost is refused, never a wrong total", async () => {
    respond = () => Response.json(body);
    await expect(run("gateway usage sessions --prefix=task-")).rejects.toThrow(/older than this CLI.*prefix/);
    const noCost = { sessions: [{ ...body.sessions[0]!, identities: [{ identity: "alice", turns: 1, firstTs: "2026-11-20T01:00:00.000Z", lastTs: "2026-11-20T02:00:00.000Z" }] }] };
    respond = () => Response.json(noCost);
    await expect(run("gateway usage sessions")).rejects.toThrow(/no cost fields/);
  });

  test("json output keeps the estimate label and the raw sessions", async () => {
    await run("gateway usage sessions --json");
    const j = JSON.parse(out.join("\n"));
    expect(j).toMatchObject({ estimate: true, costUnit: "USD" });
    expect(j.sessions).toHaveLength(3);
    expect(j.byProvider).toHaveLength(2);
  });

  test("an admin failure is an error, not an empty table", async () => {
    respond = () => Response.json({ error: "boom" }, { status: 503 });
    await expect(run("gateway usage sessions")).rejects.toThrow(/failed \(503\)/);
  });

  test("a bad limit or an unknown word is a usage error", async () => {
    await expect(run("gateway usage sessions --limit=0")).rejects.toThrow(/--limit/);
    await expect(run("gateway usage nope")).rejects.toThrow(/Usage: ais gateway usage/);
  });
});
