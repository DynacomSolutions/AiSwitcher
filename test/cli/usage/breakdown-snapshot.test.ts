import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeUsageBreakdownRequest,
  readUsageBreakdownEnvelope,
  refreshQueuedUsageBreakdowns,
  requestKnownUsageBreakdownsRefresh,
  requestStaleUsageBreakdowns,
  requestUsageBreakdownRefresh,
  type BreakdownSnapshotDeps,
} from "../../../src/cli/usage/breakdown-snapshot.ts";
import { collectIdentityBreakdown, type BreakdownDeps, type BreakdownResult } from "../../../src/cli/usage/breakdown.ts";
import type { Identity } from "../../../src/identities/types.ts";

const roots: string[] = [];
async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ais-usage-breakdown-snapshot-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const result = (generatedAt = "2026-10-23T00:00:00.000Z"): BreakdownResult => ({
  identity: "work",
  tool: "claude",
  windowDays: 30,
  generatedAt,
  filesRead: 2,
  categories: [{
    kind: "conversation", name: "conversation", callCount: 0, inputTokens: 120,
    outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0,
    estCostUsd: 0.01, lastUsedAt: generatedAt,
  }],
});

function deps(root: string, now = Date.parse("2026-10-23T00:00:00.000Z")): BreakdownSnapshotDeps {
  return { root, now: () => now, ttlMs: 15 * 60_000 };
}

describe("usage breakdown snapshot cache", () => {
  test("normalizes and validates query identity, tool, and default window", () => {
    expect(normalizeUsageBreakdownRequest({ tool: " CLAUDE ", identity: " work ", days: 30.9 })).toEqual({
      tool: "claude", identity: "work", days: 30,
    });
    expect(normalizeUsageBreakdownRequest({ days: Number.NaN })).toEqual({ days: 30 });
    expect(() => normalizeUsageBreakdownRequest({ tool: " " })).toThrow("invalid-breakdown-tool");
    expect(() => normalizeUsageBreakdownRequest({ tool: "unknown", days: 30 })).toThrow("invalid-breakdown-tool");
    expect(() => normalizeUsageBreakdownRequest({ identity: "  " })).toThrow("invalid-breakdown-identity");
    expect(() => normalizeUsageBreakdownRequest({ identity: "bad\nidentity" })).toThrow("invalid-breakdown-identity");
  });

  test("requests coalesce by normalized hash and readers only return pending state", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "CLAUDE", identity: " work " }, options);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work", days: 30 }, options);
    expect(await readdir(join(root, "requests"))).toHaveLength(1);

    const envelope = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, options);
    expect(envelope).toEqual({ results: [], pending: true, stale: true });
  });

  test("collector queues the missing or expired default 30-day snapshot without a reader request", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    expect(requestStaleUsageBreakdowns(options)).toBe(true);
    expect(await readdir(join(root, "requests"))).toHaveLength(1);
    await refreshQueuedUsageBreakdowns(async () => [result()], options);
    expect(requestStaleUsageBreakdowns(options)).toBe(false);

    const expired = deps(root, Date.parse("2026-10-23T00:16:00.000Z"));
    expect(requestStaleUsageBreakdowns(expired)).toBe(true);
    expect(await readdir(join(root, "requests"))).toHaveLength(1);
    const envelope = readUsageBreakdownEnvelope({ days: 30 }, expired);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.pending).toBe(true);
  });

  test("default refresh errors have a bounded retry cooldown", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    expect(requestStaleUsageBreakdowns(options)).toBe(true);
    await refreshQueuedUsageBreakdowns(async () => { throw new Error("source unavailable"); }, options);
    expect(requestStaleUsageBreakdowns(options)).toBe(false);

    const afterCooldown = deps(root, Date.parse("2026-10-23T00:16:00.000Z"));
    expect(requestStaleUsageBreakdowns(afterCooldown)).toBe(true);
  });

  test("collector drain persists an atomic last-good fixture and readers can reuse it", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, options);
    let calls = 0;
    const run = async (query: { tool?: string; identity?: string; days: number }) => {
      calls++;
      expect(query).toEqual({ tool: "claude", identity: "work", days: 30 });
      return [result()];
    };

    expect(await refreshQueuedUsageBreakdowns(run, options)).toBe(1);
    expect(calls).toBe(1);
    const envelope = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, options);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.pending).toBe(false);
    expect(envelope.stale).toBe(false);
    expect(envelope.generatedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(envelope.lastSuccessAt).toBe(envelope.generatedAt);
    const cacheFile = join(root, "cache", (await readdir(join(root, "cache")))[0]!);
    expect(await stat(cacheFile).then((item) => item.mode & 0o777)).toBe(0o600);
    const persisted = await readFile(cacheFile, "utf8");
    expect(persisted).not.toContain("configDir");
    expect(persisted).not.toContain("fixture-path");
  });

  test("concurrent drain calls share one sequential worker", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, options);
    requestUsageBreakdownRefresh({ tool: "codex", identity: "work" }, options);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const run = async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [result()];
    };
    const first = refreshQueuedUsageBreakdowns(run, options);
    const second = refreshQueuedUsageBreakdowns(run, options);
    expect(second).toBe(first);
    expect(await first).toBe(2);
    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });

  test("failed refresh preserves last-good results and records only a safe error category", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, options);
    await refreshQueuedUsageBreakdowns(async () => [result()], options);

    const later = deps(root, Date.parse("2026-10-23T00:20:00.000Z"));
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, later);
    await refreshQueuedUsageBreakdowns(async () => { throw new Error("private /home path and provider payload"); }, later);

    const envelope = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, later);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.pending).toBe(false);
    expect(envelope.stale).toBe(true);
    expect(envelope.error).toEqual({ category: "source-error", at: "2026-10-23T00:20:00.000Z" });
    const statusFile = join(root, "status", (await readdir(join(root, "status")))[0]!);
    expect(await readFile(statusFile, "utf8")).not.toContain("provider payload");
    expect(await readdir(join(root, "requests"))).toHaveLength(0);
  });

  test("incomplete midstream source results preserve last-good cache", async () => {
    const root = await cacheRoot();
    const first = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, first);
    await refreshQueuedUsageBreakdowns(async () => [result()], first);

    const later = deps(root, Date.parse("2026-10-23T00:20:00.000Z"));
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, later);
    const partial = { ...result("2026-10-23T00:20:00.000Z"), sourceError: "source-error" as const };
    expect(await refreshQueuedUsageBreakdowns(async () => [partial], later)).toBe(0);

    const envelope = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, later);
    expect(envelope.results).toEqual([result()]);
    expect(envelope.generatedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(envelope.stale).toBe(true);
    expect(envelope.error).toEqual({ category: "source-error", at: "2026-10-23T00:20:00.000Z" });
  });

  test("source-root EACCES preserves last-good data instead of caching an empty result", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, options);
    await refreshQueuedUsageBreakdowns(async () => [result()], options);

    const later = deps(root, Date.parse("2026-10-23T00:20:00.000Z"));
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, later);
    const sourceDeps: BreakdownDeps = {
      readdir: () => { throw Object.assign(new Error("private source failure"), { code: "EACCES" }); },
    };
    const identity: Identity = { name: "work", label: "Work", configDir: "/synthetic/fixture" };
    const run = async () => [await collectIdentityBreakdown("claude", identity, 30, sourceDeps)];
    expect(await refreshQueuedUsageBreakdowns(run, later)).toBe(0);

    const envelope = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, later);
    expect(envelope.results).toEqual([result()]);
    expect(envelope.error?.category).toBe("source-error");
  });

  test("empty and unsupported source outcomes are legitimate cache successes", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "empty" }, options);
    requestUsageBreakdownRefresh({ tool: "grok", identity: "unsupported" }, options);
    const run = async (query: { tool?: string; identity?: string; days: number }): Promise<BreakdownResult[]> => {
      if (query.identity === "empty") return [];
      return [{ ...result(), identity: "unsupported", tool: "grok", categories: [], filesRead: 0, unavailable: "no per-call usage" }];
    };

    expect(await refreshQueuedUsageBreakdowns(run, options)).toBe(2);
    expect(readUsageBreakdownEnvelope({ tool: "claude", identity: "empty" }, options).stale).toBe(false);
    const unsupported = readUsageBreakdownEnvelope({ tool: "grok", identity: "unsupported" }, options);
    expect(unsupported.stale).toBe(false);
    expect(unsupported.results[0]?.unavailable).toBe("no per-call usage");
  });

  test("dirty-source refresh requeues all valid cached and pending queries without replacing last-good", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ tool: "claude", identity: "work" }, options);
    await refreshQueuedUsageBreakdowns(async () => [result()], options);
    requestUsageBreakdownRefresh({ tool: "codex", identity: "other", days: 7 }, options);
    await refreshQueuedUsageBreakdowns(async () => [{ ...result(), tool: "codex", identity: "other", windowDays: 7 }], options);
    requestUsageBreakdownRefresh({ tool: "grok", identity: "pending" }, options);

    expect(requestKnownUsageBreakdownsRefresh(options)).toBe(3);
    expect(requestKnownUsageBreakdownsRefresh(options)).toBe(3);
    expect(await readdir(join(root, "requests"))).toHaveLength(3);
    const cached = readUsageBreakdownEnvelope({ tool: "claude", identity: "work" }, options);
    expect(cached.results).toEqual([result()]);
    expect(cached.pending).toBe(true);
    expect(cached.stale).toBe(true);
  });

  test("stale TTL is reported without enqueuing or running a scan", async () => {
    const root = await cacheRoot();
    const options = deps(root);
    requestUsageBreakdownRefresh({ days: 30 }, options);
    await refreshQueuedUsageBreakdowns(async () => [result()], options);

    const later = deps(root, Date.parse("2026-10-23T00:16:00.000Z"));
    const envelope = readUsageBreakdownEnvelope({ days: 30 }, later);
    expect(envelope.results).toHaveLength(1);
    expect(envelope.stale).toBe(true);
    expect(envelope.pending).toBe(false);
    expect(await readdir(join(root, "requests"))).toHaveLength(0);
  });
});
