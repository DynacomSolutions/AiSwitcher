import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokDuplicateBaselineIsSafe } from "../../../src/cli/usage/grok-history-regression.ts";
import type { UsageResult } from "../../../src/cli/usage/run.ts";

type Message = {
  [key: string]: unknown;
  client: string;
  model_id: string;
  provider_id: string;
  session_id: string;
  timestamp: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number; reasoning: number };
  cost: number;
  cost_source: string;
  message_count: number;
  dedup_key: string;
  workspace_key: string;
  workspace_label: string;
  duration_ms: number;
};

const partitionId = "a".repeat(64);
const baseMs = Date.UTC(2026, 9, 23, 18, 58, 0);
const identity = { name: "grok-test", label: "Grok test" } as UsageResult["identity"];
const tokens = { input: 100, output: 20, cache_read: 30, cache_write: 4, cache_write_1h: 0, reasoning: 5 };
const message = (id: string, source: "unified" | "legacy" = "unified", offset = 0): Message => ({
  client: "grok",
  model_id: "grok-4.6",
  provider_id: "xai",
  session_id: `session-${id}`,
  timestamp: baseMs + offset,
  tokens: { ...tokens },
  cost: source === "legacy" ? 0.02 : 0.06,
  cost_source: source === "legacy" ? "providerReported" : "estimated",
  message_count: 1,
  dedup_key: `${source === "legacy" ? "grok" : "grok-unified"}:${id}`,
  workspace_key: "workspace-fixture",
  workspace_label: "Fixture workspace",
  duration_ms: 12,
});

function aggregate(messages: Message[], additional = 0): UsageResult[] {
  const sum = (key: keyof Message["tokens"]) => messages.reduce((total, row) => total + row.tokens[key], 0);
  return [{
    provider: "xai",
    identity,
    report: {
      entries: [],
      totalInput: sum("input") + additional,
      totalOutput: sum("output"),
      totalCacheRead: sum("cache_read"),
      totalCacheWrite: sum("cache_write"),
      totalMessages: messages.length + additional,
      totalCost: 0,
    },
  }];
}

async function fixture(priorMessages: Message[], candidateMessages: Message[]) {
  const dir = await mkdtemp(join(tmpdir(), "ais-grok-history-"));
  const nativeBatchRoot = join(dir, "native");
  const priorPath = join(nativeBatchRoot, partitionId, "11111111-1111-4111-8111-111111111111.json");
  const candidatePath = join(dir, "candidate.json");
  await mkdir(join(nativeBatchRoot, partitionId), { recursive: true });
  const envelope = (messages: Message[]) => JSON.stringify({
    schemaVersion: 1, partitionId, generatedAt: new Date(baseMs).toISOString(), complete: true, messages,
  });
  const priorBytes = Buffer.from(envelope(priorMessages));
  await writeFile(priorPath, priorBytes);
  await writeFile(candidatePath, envelope(candidateMessages));
  const input = {
    priorRef: {
      path: `usage/native/${partitionId}/11111111-1111-4111-8111-111111111111.json`,
      partitionId,
      generatedAt: new Date(baseMs).toISOString(),
      sha256: createHash("sha256").update(priorBytes).digest("hex"),
    },
    candidatePath,
    expectedPartitionId: partitionId,
    nativeBatchRoot,
    previous: aggregate(priorMessages),
    incoming: aggregate(candidateMessages),
  };
  return { dir, candidatePath, input };
}

describe("Grok unified duplicate baseline correction", () => {
  test("accepts one-to-one duplicate correction only when all retained history survives and totals do not fall", async () => {
    const duplicates = Array.from({ length: 13 }, (_, i) => message(`duplicate-${i}`, "unified", i * 1000));
    const retained = message("retained", "unified", 30_000);
    const unrelatedUnknownModel = { ...message("other-client", "legacy", 31_000), client: "other", model_id: "unknown", dedup_key: "other:unknown" };
    const pairs = duplicates.map((row) => message(row.dedup_key.slice("grok-unified:".length), "legacy", row.timestamp - baseMs + 100));
    const growth = message("new-growth", "legacy", 40_000);
    const f = await fixture([...duplicates, ...pairs, retained, unrelatedUnknownModel], [...pairs, retained, unrelatedUnknownModel, growth]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects a true unmatched loss even when new rows keep totals above the baseline", async () => {
    const oldDuplicate = message("duplicate");
    const oldLegacy = message("duplicate", "legacy", 100);
    const oldRows = [oldDuplicate, oldLegacy, message("lost", "unified", 5000), message("retained", "unified", 10_000)];
    const newRows = [oldLegacy, message("retained", "unified", 10_100), ...Array.from({ length: 5 }, (_, i) => message(`growth-${i}`, "legacy", 20_000 + i * 1000))];
    const f = await fixture(oldRows, newRows);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects a candidate-only legacy row that was not already a prior duplicate", async () => {
    const prior = [message("old")];
    const candidate = [message("old", "legacy", 100), ...Array.from({ length: 3 }, (_, i) => message(`growth-${i}`, "legacy", 10_000 + i * 1000))];
    const f = await fixture(prior, candidate);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects a forged prior batch hash", async () => {
    const row = message("old");
    const f = await fixture([row], [row]);
    try {
      expect(grokDuplicateBaselineIsSafe({ ...f.input, priorRef: { ...f.input.priorRef, sha256: "f".repeat(64) } })).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects an ambiguous unified-to-legacy match", async () => {
    const unifiedOne = message("same-one");
    const unifiedTwo = { ...message("same-two"), dedup_key: "grok-unified:same-two", session_id: unifiedOne.session_id };
    const legacy = { ...message("same-legacy", "legacy", 100), session_id: unifiedOne.session_id };
    const prior = [unifiedOne, unifiedTwo, legacy];
    const candidate = [legacy];
    const f = await fixture(prior, candidate);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects a changed legacy payload even when its dedup key is retained", async () => {
    const unified = message("same");
    const legacy = message("same", "legacy", 100);
    const changedLegacy = { ...legacy, workspace_key: "different-workspace" };
    const f = await fixture([unified, legacy], [changedLegacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("rejects ISO timestamps instead of native epoch-millisecond numbers", async () => {
    const unified = message("same");
    const legacy = message("same", "legacy", 100);
    const f = await fixture([unified, legacy], [legacy]);
    try {
      const envelope = JSON.parse(await Bun.file(f.candidatePath).text()) as { messages: Message[] };
      envelope.messages[0] = { ...legacy, timestamp: new Date(legacy.timestamp).toISOString() } as unknown as Message;
      await writeFile(f.candidatePath, JSON.stringify({
        schemaVersion: 1, partitionId, generatedAt: new Date(baseMs).toISOString(), complete: true, messages: envelope.messages,
      }));
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("does not remove a unified row whose cost source is not estimated", async () => {
    const unified = { ...message("same"), cost_source: "providerReported" };
    const legacy = message("same", "legacy", 100);
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("does not treat the Grok unknown-model sentinel as a duplicate", async () => {
    const unified = { ...message("unknown-model"), model_id: "grok-unknown" };
    const legacy = { ...message("unknown-model", "legacy", 100), model_id: "grok-unknown" };
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("does not treat a Grok signals legacy row as a duplicate", async () => {
    const unified = message("signals");
    const legacy = { ...message("signals", "legacy", 100), dedup_key: "grok:signals:signals" };
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("requires exact Grok client identity for a duplicate pair", async () => {
    const unified = message("client-mismatch");
    const legacy = { ...message("client-mismatch", "legacy", 100), client: "Grok" };
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("does not treat a unified signals row as a duplicate", async () => {
    const unified = { ...message("unified-signals"), dedup_key: "grok-unified:unified-signals:signals" };
    const legacy = message("unified-signals", "legacy", 100);
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("requires xai provider identity on the unified row", async () => {
    const unified = { ...message("unified-provider"), provider_id: "other-provider" };
    const legacy = message("unified-provider", "legacy", 100);
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test("requires xai provider identity on the legacy row", async () => {
    const unified = message("legacy-provider");
    const legacy = { ...message("legacy-provider", "legacy", 100), provider_id: "other-provider" };
    const f = await fixture([unified, legacy], [legacy]);
    try {
      expect(grokDuplicateBaselineIsSafe(f.input)).toBe(false);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
