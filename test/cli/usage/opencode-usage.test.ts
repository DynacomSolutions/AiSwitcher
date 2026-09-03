import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  OPENCODE_DEFAULT_PROFILE_IDENTITY,
  defaultOpencodeProfileDbPath,
  readOpencodeProfileUsage,
} from "../../../src/cli/usage/opencode-usage.ts";
import { estimateDetailedModelTokenCost } from "../../../src/identities/model-pricing.ts";

describe("OpenCode Go pricing", () => {
  test("paid Go models price from the plan's published table", () => {
    // GLM-5.3-Flash: $0.15 in / $0.50 out / $0.03 cached-read per 1M
    const glm = estimateDetailedModelTokenCost("opencode-go", "glm-5.3-flash", 1_000_000, 1_000_000, 1_000_000, 0)!;
    expect(glm).toBeCloseTo(0.15 + 0.5 + 0.03, 6);
    // cache writes are new input at the ordinary input rate
    const withWrite = estimateDetailedModelTokenCost("opencode-go", "glm-5.3-flash", 1_000_000, 0, 0, 500_000)!;
    expect(withWrite).toBeCloseTo(0.15 * 1.5, 6);
    // provider prefix on a model id is stripped before lookup
    expect(estimateDetailedModelTokenCost("opencode-go", "opencode-go/glm-5.3", 1_000_000, 0, 0, 0)).toBeDefined();
  });

  test("ox-alpha-free is priced at zero — honestly free, not unknown", () => {
    // The user's recorded Go traffic ran on "Ox Alpha Free (Unlimited)";
    // models.dev prices it at 0 across the board.
    expect(estimateDetailedModelTokenCost("opencode-go", "ox-alpha-free", 57_000_000, 1_000_000, 900_000_000, 0)).toBe(0);
  });
});

describe("readOpencodeProfileUsage", () => {
  const tempDirs: string[] = [];

  async function makeDb(rows: Array<Record<string, unknown>>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ais-opencode-usage-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.query("CREATE TABLE message (data TEXT)").run();
    for (const row of rows) db.query("INSERT INTO message (data) VALUES (?)").run(JSON.stringify(row));
    db.close();
    return dbPath;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("aggregates per recorded provider, estimating Go-plan costs", async () => {
    const dbPath = await makeDb([
      assistant("opencode-go", "ox-alpha-free", { input: 1000, output: 100, reasoning: 10, cache: { read: 5000, write: 0 } }, 1_780_000_000_000),
      assistant("opencode-go", "glm-5.3-flash", { input: 200, output: 50, reasoning: 0, cache: { read: 3000, write: 0 } }, 1_780_100_000_000),
      // a non-assistant row and an unnamable provider are skipped
      { role: "user", providerID: "opencode-go", tokens: { input: 999999 } },
      assistant("opencode", "x-preview-f-free", { input: 42, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1_780_200_000_000),
    ]);

    const outcome = readOpencodeProfileUsage(dbPath);
    expect(outcome.kind).toBe("usage");
    if (outcome.kind !== "usage") return;
    const go = outcome.providers.find((p) => p.provider === "opencode-go")!;
    expect(go).toBeDefined();
    expect(go.report.totalMessages).toBe(2);
    expect(go.report.totalInput).toBe(1200);
    // ox-alpha-free is free; the glm row is priced: 200 * 0.15/1M + 50 * 0.5/1M + 3000 * 0.03/1M
    expect(go.report.totalCost).toBeCloseTo((200 * 0.15 + 50 * 0.5 + 3000 * 0.03) / 1_000_000, 9);
    expect(go.report.entries.map((e) => e.model).sort()).toEqual(["glm-5.3-flash", "ox-alpha-free"]);
    expect(go.dateSpan.firstMs).toBe(1_780_000_000_000);
    expect(go.dateSpan.lastMs).toBe(1_780_100_000_000);
    expect(Object.keys(go.dailyUsage)).toHaveLength(2);
    // the "opencode" provider is skipped entirely (no honest label for it)
    expect(outcome.providers.find((p) => p.provider === "opencode")).toBeUndefined();
  });

  test("recorded nonzero cost wins over the estimate", async () => {
    const dbPath = await makeDb([
      { ...assistant("opencode-go", "glm-5.2", { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1_780_000_000_000), cost: 0.5 },
    ]);
    const outcome = readOpencodeProfileUsage(dbPath);
    if (outcome.kind !== "usage") throw new Error("expected usage");
    expect(outcome.providers[0]!.report.totalCost).toBe(0.5);
  });

  test("a missing db is 'absent', a corrupt one is an error", async () => {
    expect(readOpencodeProfileUsage(join(tmpdir(), "ais-opencode-usage-does-not-exist", "opencode.db")).kind).toBe("absent");
    const dir = await mkdtemp(join(tmpdir(), "ais-opencode-usage-bad-"));
    tempDirs.push(dir);
    await Bun.write(join(dir, "opencode.db"), "this is not sqlite");
    expect(readOpencodeProfileUsage(join(dir, "opencode.db")).kind).toBe("error");
  });

  test("default db path is ALWAYS the unredirected profile, ignoring ambient XDG_DATA_HOME", () => {
    // Inside an AIS-launched opencode session XDG_DATA_HOME points at that
    // identity's data dir — honouring it would double-count the identity's
    // rows as "default" (observed live 2026-09-03).
    const expected = join(process.env.HOME ?? "", ".local", "share", "opencode", "opencode.db");
    expect(defaultOpencodeProfileDbPath()).toBe(expected);
    expect(OPENCODE_DEFAULT_PROFILE_IDENTITY.name).toBe("default");
  });
});

function assistant(provider: string, model: string, tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }, created: number) {
  return { role: "assistant", providerID: provider, modelID: model, tokens, cost: 0, time: { created } };
}
