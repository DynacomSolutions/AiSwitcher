import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { UsageResult } from "./run.ts";

interface NativeBatchRef {
  path: string;
  sha256: string;
  generatedAt: string;
  partitionId: string;
}

interface NativeMessage {
  [key: string]: unknown;
  client: string;
  model_id: string;
  provider_id?: string;
  session_id: string;
  timestamp: number;
  tokens: Record<string, number>;
  message_count: number;
  dedup_key: string;
  cost_source?: string;
}

interface NativeEnvelope {
  schemaVersion: 1;
  partitionId: string;
  generatedAt: string;
  complete: true;
  messages: NativeMessage[];
}

const TOKEN_FIELDS = ["input", "output", "cache_read", "cache_write", "cache_write_1h", "reasoning"] as const;
const MAX_DUPLICATE_TIME_DELTA_MS = 250;

function parseEnvelope(bytes: Buffer, expectedPartitionId: string): NativeEnvelope | undefined {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.partitionId !== expectedPartitionId || value.complete !== true ||
        typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.messages)) return undefined;
    if (!value.messages.every(isNativeMessage)) return undefined;
    return value as unknown as NativeEnvelope;
  } catch {
    return undefined;
  }
}

function isNativeMessage(value: unknown): value is NativeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const tokens = row.tokens as Record<string, unknown> | undefined;
  return typeof row.client === "string" && typeof row.model_id === "string" && row.model_id.length > 0 &&
    typeof row.provider_id === "string" && row.provider_id.length > 0 &&
    typeof row.session_id === "string" && row.session_id.length > 0 && typeof row.timestamp === "number" &&
    Number.isFinite(row.timestamp) && row.timestamp >= 0 && typeof row.message_count === "number" && Number.isFinite(row.message_count) &&
    typeof row.dedup_key === "string" && !!row.dedup_key && !!tokens && typeof tokens === "object" &&
    TOKEN_FIELDS.every((field) => typeof tokens[field] === "number" && Number.isFinite(tokens[field]) && tokens[field] >= 0);
}

function authenticatedPriorMessages(ref: NativeBatchRef, expectedPartitionId: string, nativeBatchRoot: string): NativeMessage[] | undefined {
  if (ref.partitionId !== expectedPartitionId || !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !/^usage\/native\/[a-f0-9]{64}\/[0-9a-f-]{36}\.json$/.test(ref.path) ||
      !ref.path.startsWith(`usage/native/${expectedPartitionId}/`)) return undefined;
  const filePath = join(nativeBatchRoot, expectedPartitionId, basename(ref.path));
  try {
    const bytes = readFileSync(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) return undefined;
    const envelope = parseEnvelope(bytes, expectedPartitionId);
    if (!envelope || envelope.generatedAt !== ref.generatedAt) return undefined;
    return envelope.messages;
  } catch {
    return undefined;
  }
}

function candidateMessages(path: string, expectedPartitionId: string): NativeMessage[] | undefined {
  try {
    return parseEnvelope(readFileSync(path), expectedPartitionId)?.messages;
  } catch {
    return undefined;
  }
}

function isGrokUnified(row: NativeMessage): boolean {
  return row.client === "grok" && row.provider_id === "xai" && row.model_id !== "grok-unknown" &&
    row.dedup_key.startsWith("grok-unified:") && !row.dedup_key.endsWith(":signals") && row.cost_source === "estimated";
}

function isProviderReportedGrokLegacy(row: NativeMessage): boolean {
  return row.client === "grok" && row.provider_id === "xai" && row.model_id !== "grok-unknown" && row.cost_source === "providerReported" &&
    row.dedup_key.startsWith("grok:") && !row.dedup_key.endsWith(":signals");
}

function sameDuplicatePayload(unified: NativeMessage, legacy: NativeMessage): boolean {
  return unified.client === legacy.client && unified.session_id === legacy.session_id && unified.model_id === legacy.model_id && unified.provider_id === legacy.provider_id &&
    unified.message_count === 1 && legacy.message_count === 1 &&
    TOKEN_FIELDS.every((field) => unified.tokens[field] === legacy.tokens[field]) &&
    Math.abs(unified.timestamp - legacy.timestamp) <= MAX_DUPLICATE_TIME_DELTA_MS;
}

function stableRowKey(row: NativeMessage): string {
  return JSON.stringify([row.client, row.provider_id, row.model_id, row.session_id, row.dedup_key]);
}

function payloadKey(row: NativeMessage): string {
  return canonicalJson(row);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function aggregateIdentity(row: NativeMessage): string {
  return JSON.stringify([row.client, row.provider_id, row.model_id, row.session_id]);
}

function isGrokSessionAggregate(row: NativeMessage): boolean {
  return isProviderReportedGrokLegacy(row) &&
    new RegExp(`^grok:${row.session_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:prompt:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`, "i").test(row.dedup_key);
}

function aggregateRepresentsPriorUnifiedRows(aggregate: NativeMessage, rows: NativeMessage[]): boolean {
  if (rows.length === 0 || !isGrokSessionAggregate(aggregate) || !Number.isSafeInteger(aggregate.message_count) || aggregate.message_count <= 1) return false;
  const expected = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])) as Record<(typeof TOKEN_FIELDS)[number], number>;
  let messageCount = 0;
  for (const row of rows) {
    if (!isGrokUnified(row) || aggregateIdentity(row) !== aggregateIdentity(aggregate) || row.message_count !== 1) return false;
    messageCount += row.message_count;
    for (const field of TOKEN_FIELDS) {
      if (!Number.isSafeInteger(row.tokens[field])) return false;
      expected[field] += row.tokens[field];
      if (!Number.isSafeInteger(expected[field])) return false;
    }
  }
  return Number.isSafeInteger(messageCount) && aggregate.message_count === messageCount &&
    TOKEN_FIELDS.every((field) => Number.isSafeInteger(aggregate.tokens[field]) && aggregate.tokens[field] === expected[field]);
}

function normalizedPriorMessages(prior: NativeMessage[], candidate: NativeMessage[]): { retained: NativeMessage[]; removed: NativeMessage[]; representedAggregate: boolean } | undefined {
  const oldUnified = prior.filter(isGrokUnified);
  const oldLegacy = prior.filter(isProviderReportedGrokLegacy);
  const candidateLegacyCounts = new Map<string, number>();
  for (const legacy of candidate.filter(isProviderReportedGrokLegacy)) {
    const key = `${stableRowKey(legacy)}\0${payloadKey(legacy)}`;
    candidateLegacyCounts.set(key, (candidateLegacyCounts.get(key) ?? 0) + 1);
  }
  const oldMatches = new Map<NativeMessage, NativeMessage>();
  const reverseCounts = new Map<NativeMessage, number>();
  for (const unified of oldUnified) {
    const matches = oldLegacy.filter((legacy) => sameDuplicatePayload(unified, legacy));
    if (matches.length > 1) return undefined;
    if (matches[0]) {
      oldMatches.set(unified, matches[0]);
      reverseCounts.set(matches[0], (reverseCounts.get(matches[0]) ?? 0) + 1);
    }
  }
  const removed: NativeMessage[] = [];
  for (const [unified, legacy] of oldMatches) {
    if (reverseCounts.get(legacy) !== 1) return undefined;
    const legacyKey = `${stableRowKey(legacy)}\0${payloadKey(legacy)}`;
    if (candidateLegacyCounts.get(legacyKey) !== 1) return undefined;
    removed.push(unified);
  }

  // Every old row not proven to be a one-to-one unified/legacy duplicate must
  // remain in the new batch with the same stable key and all token counters.
  const candidateCounts = new Map<string, number>();
  for (const row of candidate) {
    const key = `${stableRowKey(row)}\0${payloadKey(row)}`;
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
  }
  const removedSet = new Set(removed);
  const representedByAggregate = new Set<NativeMessage>();
  const priorUnifiedByIdentity = new Map<string, NativeMessage[]>();
  for (const row of prior.filter(isGrokUnified)) {
    const key = aggregateIdentity(row);
    priorUnifiedByIdentity.set(key, [...(priorUnifiedByIdentity.get(key) ?? []), row]);
  }
  for (const [identity, rows] of priorUnifiedByIdentity) {
    const unmatched = rows.filter((row) => !removedSet.has(row));
    if (unmatched.length === 0) continue;
    const presentCount = unmatched.reduce((count, row) => {
      const key = `${stableRowKey(row)}\0${payloadKey(row)}`;
      return count + Math.min(1, candidateCounts.get(key) ?? 0);
    }, 0);
    if (presentCount === unmatched.length) continue;
    if (presentCount > 0) return undefined;
    // Aggregate replacement is allowed only when every old unified row for
    // this identity is missing. Mixing paired and aggregated rows would make
    // candidate reuse or partial overlap difficult to prove safely.
    if (unmatched.length !== rows.length) return undefined;
    const candidateForIdentity = candidate.filter((row) => aggregateIdentity(row) === identity);
    if (candidateForIdentity.some(isGrokUnified)) return undefined;
    const candidateAggregates = candidateForIdentity.filter(isGrokSessionAggregate);
    if (candidateAggregates.length !== 1 || !aggregateRepresentsPriorUnifiedRows(candidateAggregates[0]!, rows)) return undefined;
    // A prior provider-reported row for the same identity makes it impossible
    // to prove this is a new representation of only the missing unified rows.
    if (prior.some((row) => isProviderReportedGrokLegacy(row) && aggregateIdentity(row) === identity)) return undefined;
    for (const row of rows) representedByAggregate.add(row);
  }
  const retained = prior.filter((row) => !removedSet.has(row) && !representedByAggregate.has(row));
  const requiredCounts = new Map<string, number>();
  for (const row of retained) {
    const key = `${stableRowKey(row)}\0${payloadKey(row)}`;
    requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of requiredCounts) if ((candidateCounts.get(key) ?? 0) < count) return undefined;
  return { retained, removed, representedAggregate: representedByAggregate.size > 0 };
}

function correctedAggregateIsNonRegressing(previous: UsageResult[], incoming: UsageResult[], removed: NativeMessage[]): boolean {
  const before = totals(previous);
  const after = totals(incoming);
  if (!before || !after) return false;
  const correctedTokens = before.tokens - removed.reduce((sum, row) =>
    sum + row.tokens.input + row.tokens.output + row.tokens.cache_read + row.tokens.cache_write, 0);
  const correctedMessages = before.messages - removed.reduce((sum, row) => sum + row.message_count, 0);
  if (correctedTokens < 0 || correctedMessages < 0) return false;
  return after.tokens >= correctedTokens && after.messages >= correctedMessages;
}

function totals(results: UsageResult[]): { tokens: number; messages: number } | undefined {
  if (results.some((row) => !row.report)) return undefined;
  const reports = results.map((row) => row.report!);
  const values = reports.flatMap((report) => [report.totalInput, report.totalOutput, report.totalCacheRead, report.totalCacheWrite, report.totalMessages]);
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
  return {
    tokens: reports.reduce((sum, report) => sum + report.totalInput + report.totalOutput + report.totalCacheRead + report.totalCacheWrite, 0),
    messages: reports.reduce((sum, report) => sum + report.totalMessages, 0),
  };
}

/**
 * A Grok-only exception for the known unified/legacy duplicate transition.
 * Every path, batch hash, envelope, duplicate correction or exact session
 * aggregate replacement, retained old row, and adjusted aggregate must
 * validate; any uncertainty keeps the guard.
 */
export function grokDuplicateBaselineIsSafe(input: {
  priorRef: NativeBatchRef;
  candidatePath: string;
  expectedPartitionId: string;
  nativeBatchRoot: string;
  previous: UsageResult[];
  incoming: UsageResult[];
}): boolean {
  const prior = authenticatedPriorMessages(input.priorRef, input.expectedPartitionId, input.nativeBatchRoot);
  const candidate = candidateMessages(input.candidatePath, input.expectedPartitionId);
  if (!prior || !candidate) return false;
  const normalized = normalizedPriorMessages(prior, candidate);
  if (!normalized) return false;
  return (normalized.removed.length > 0 || normalized.representedAggregate) &&
    correctedAggregateIsNonRegressing(input.previous, input.incoming, normalized.removed);
}
