import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPiUsage } from "../../../src/cli/usage/pi-usage.ts";
import { localDateKey } from "../../../src/cli/usage/local-day.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeIdentity(): Promise<Identity> {
  const configDir = await mkdtemp(join(tmpdir(), "ais-pi-usage-"));
  tempDirs.push(configDir);
  await mkdir(join(configDir, "sessions", "project"), { recursive: true });
  return { name: "all", label: "All", configDir };
}

function assistant(
  id: string,
  timestamp: string,
  provider: string,
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number },
): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider,
      model,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        cost: { total: usage.cost ?? 0 },
      },
    },
  });
}

describe("fetchPiUsage", () => {
  test("groups every Pi message by canonical provider and keeps token/day/model totals", async () => {
    const identity = await makeIdentity();
    const firstTimestamp = "2026-08-18T10:00:00.000Z";
    const duplicate = assistant("same-id", firstTimestamp, "openai-codex", "gpt-5.5", {
      input: 100,
      output: 20,
      cacheRead: 500,
      cost: 1.25,
    });
    await writeFile(join(identity.configDir, "sessions", "project", "one.jsonl"), [
      JSON.stringify({ type: "session", id: "session-one", timestamp: firstTimestamp }),
      duplicate,
      assistant("ali-id", "2026-08-19T11:00:00.000Z", "alibaba-plan", "qwen3.8-max", {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
      }),
      "not-json",
    ].join("\n"));
    await mkdir(join(identity.configDir, "sessions", "project", "fork"));
    await writeFile(join(identity.configDir, "sessions", "project", "fork", "session.jsonl"), [
      duplicate,
      assistant("kimi-id", "2026-08-19T12:00:00.000Z", "kimi-coding", "kimi-for-coding", {
        input: 30,
        output: 5,
      }),
    ].join("\n"));

    const results = await fetchPiUsage(identity);
    expect(results.map((result) => result.provider).sort()).toEqual(["alibaba", "kimi", "openai"]);

    const openai = results.find((result) => result.provider === "openai")!;
    expect(openai.report.totalMessages).toBe(1); // copied fork entry counted once
    expect(openai.report.totalInput).toBe(100);
    expect(openai.report.totalCacheRead).toBe(500);
    expect(openai.report.totalCost).toBe(1.25);
    expect(openai.dailyUsage[localDateKey(Date.parse(firstTimestamp))]).toBe(120);
    expect(openai.report.entries[0]?.client).toBe("pi");

    const alibaba = results.find((result) => result.provider === "alibaba")!;
    expect(alibaba.report.totalCacheWrite).toBe(40);
    expect(alibaba.report.totalCost).toBeGreaterThan(0); // plan usage receives a public-price estimate
  });

  test("returns no fabricated provider row when the identity has no sessions", async () => {
    expect(await fetchPiUsage(await makeIdentity())).toEqual([]);
  });

  test("attributes CLI and party adapters to providers and marks native-covered shares", async () => {
    const identity = await makeIdentity();
    await writeFile(join(identity.configDir, "sessions", "project", "adapters.jsonl"), [
      assistant("claude", "2026-08-20T10:00:00.000Z", "claude-cli", "opus", { input: 100, output: 20 }),
      assistant("codex", "2026-08-20T10:01:00.000Z", "codex-cli", "default", { input: 80, output: 10 }),
      assistant("party", "2026-08-20T10:02:00.000Z", "party-cli", "party:claude-opus+codex", {
        input: 400,
        output: 100,
      }),
    ].join("\n"));

    const results = await fetchPiUsage(identity);
    expect(results.some((result) => result.provider === "party")).toBe(false);
    const anthropic = results.find((result) => result.provider === "anthropic")!;
    const openai = results.find((result) => result.provider === "openai")!;
    expect(anthropic.nativeCoverageTool).toBe("claude");
    expect(openai.nativeCoverageTool).toBe("codex");
    expect(anthropic.report.totalInput).toBe(300);
    expect(openai.report.totalInput).toBe(280);
    expect(anthropic.report.totalMessages).toBe(2);
    expect(openai.report.totalMessages).toBe(2);
  });
});
