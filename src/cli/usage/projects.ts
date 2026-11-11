import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { aisClaudeSwapLedgerPath, aisCacheDir } from "../../shared/ais-home.ts";
import { activeMemberAt, eventsForPool, readSwapEvents } from "../../identities/pool/ledger.ts";
import { poolsOf } from "../../identities/swap-pool.ts";
import { CLAUDE_CONFIG } from "../../identities/tool-configs.ts";
import { loadAll } from "../identities/resolve-tool.ts";
import { localDateKey } from "./local-day.ts";
import { parseSegmentedNativeManifest, nativeSegmentDir } from "./native-segments.ts";
import { canonicalUsageProvider, providerForTool } from "./providers.ts";
import { resolveWorkspaces, type WorkspaceEntry } from "./projects-workspace.ts";
import type { UsageSnapshot, UsageSnapshotPartition } from "./snapshot.ts";
import type { SwapEvent } from "../../identities/pool/adapter.ts";
import type { ToolConfig } from "../../identities/types.ts";

/** Per-project usage built by the host collector from the native usage store
 * (the same batches the Usage page totals come from), so Projects, Repos and
 * Orgs add up to the Usage total. Readers (the console) only read the file. */
export const USAGE_PROJECTS_FILE = join(aisCacheDir(), "usage", "projects.json");
const CACHE_SCHEMA = 1 as const;
const FILE_SCHEMA = 1 as const;

/** One aggregate row: sums of the messages of one workspace on one local day
 * for one provider, identity and tool. */
export interface ProjectUsageRow {
  /** The batch's workspace_key (the resolved paths live in `workspaces`). */
  workspace: string;
  /** Local calendar day, YYYY-MM-DD, as the Usage page's period filter uses. */
  date: string;
  provider: string;
  identity: string;
  tool: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  lastMs: number;
}

export interface UsageProjectsFile {
  schemaVersion: typeof FILE_SCHEMA;
  generatedAt: string;
  workspaces: Record<string, WorkspaceEntry>;
  rows: ProjectUsageRow[];
}

/** Row as the API serves it: the workspace resolved in place. */
export interface UsageProjectApiRow extends ProjectUsageRow {
  path: string;
  repo?: string;
  org?: string;
  host?: string;
  source: WorkspaceEntry["source"];
  inferred?: true;
  /** Display name: the inferred repository's name, else the workspace label. */
  name?: string;
}

interface PartitionAggregate {
  schemaVersion: typeof CACHE_SCHEMA;
  /** Batch sha256 plus everything else the rows depend on (the pool ledger). */
  key: string;
  rows: ProjectUsageRow[];
  labels: Record<string, string>;
}

export interface PoolAttribution {
  events: SwapEvent[];
  fallback: string | undefined;
  known: Set<string>;
  pool: string;
}

export interface UsageProjectsDeps {
  /** Cache root holding `native/` and the output (default: aisCacheDir()/usage). */
  usageDir?: string;
  now?: () => number;
  /** Test seam: how many native files were read (batches and segments). */
  onFileRead?: (path: string) => void;
  /** Member attribution for a swap pool partition (default: registry + ledger). */
  poolAttribution?: (pool: string) => Promise<PoolAttribution | undefined>;
  /** Fingerprint of what pool attribution depends on, folded into the cache key. */
  poolFingerprint?: () => string;
  workspace?: Partial<Omit<import("./projects-workspace.ts").WorkspaceResolverDeps, "cachePath">>;
}

const SWAP_POOL_KEY_PREFIX = "target:claude-swap-pool:";

/** A pool is a Claude registry identity (partition key `target:claude:<pool>`),
 * so the registry decides; the registry is loaded once per update. */
function defaultPoolAttributionFor(): (pool: string) => Promise<PoolAttribution | undefined> {
  let loaded: Promise<Awaited<ReturnType<typeof loadAll>>> | undefined;
  return (pool) => poolAttributionFrom(pool, () => (loaded ??= loadAll([CLAUDE_CONFIG])));
}

async function poolAttributionFrom(pool: string, load: () => Promise<Awaited<ReturnType<typeof loadAll>>>): Promise<PoolAttribution | undefined> {
  const [{ file }] = await load();
  const identity = poolsOf(file).find((candidate) => candidate.name === pool);
  if (!identity) return undefined;
  const events = eventsForPool(await readSwapEvents(aisClaudeSwapLedgerPath()), identity);
  const fallback = events[0] ? events[0].from ?? events[0].to : identity.swapPool.active ?? identity.swapPool.accounts[0];
  const members = new Set(identity.swapPool.accounts.filter((name) => file.identities.some((i) => i.name === name)));
  return { events, fallback, known: members, pool };
}

function defaultPoolFingerprint(): string {
  try {
    const info = statSync(aisClaudeSwapLedgerPath(), { bigint: true });
    return `${info.size}:${info.mtimeNs}`;
  } catch {
    return "none";
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageTimeMs(message: Record<string, unknown>): number | undefined {
  const raw = message.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Accumulates the rows of one partition; one instance per partition keeps
 * memory bounded by the distinct (workspace, day, provider, identity) count. */
class RowAccumulator {
  readonly rows = new Map<string, ProjectUsageRow>();
  readonly labels: Record<string, string> = {};

  constructor(private readonly tool: string, private readonly identity: string, private readonly pool?: PoolAttribution) {}

  add(message: Record<string, unknown>): void {
    const workspace = typeof message.workspace_key === "string" ? message.workspace_key : "";
    const at = messageTimeMs(message);
    const date = typeof message.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(message.date) ? message.date : at !== undefined ? localDateKey(at) : "";
    const rawProvider = typeof message.provider_id === "string" ? message.provider_id : "";
    const provider = this.pool ? "anthropic" : canonicalUsageProvider(rawProvider || providerForTool(this.tool as ToolConfig["toolName"]));
    let identity = this.identity;
    if (this.pool) {
      const active = at === undefined ? undefined : activeMemberAt(this.pool.events, this.pool.pool, at) ?? this.pool.fallback;
      identity = active !== undefined && this.pool.known.has(active) ? active : `${this.pool.pool} (unattributed)`;
    }
    const key = `${workspace}\u0000${date}\u0000${provider}\u0000${identity}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { workspace, date, provider, identity, tool: this.tool, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, lastMs: 0 };
      this.rows.set(key, row);
    }
    const tokens = (message.tokens && typeof message.tokens === "object" ? message.tokens : {}) as Record<string, unknown>;
    row.cost += num(message.cost);
    row.input += num(tokens.input);
    row.output += num(tokens.output);
    row.cacheRead += num(tokens.cache_read);
    row.cacheWrite += num(tokens.cache_write) + num(tokens.cache_write_1h);
    row.messages += 1;
    if (at !== undefined && at > row.lastMs) row.lastMs = at;
    if (!(workspace in this.labels) && typeof message.workspace_label === "string") this.labels[workspace] = message.workspace_label;
  }
}

function readJsonFile(path: string, onRead?: (path: string) => void): unknown {
  onRead?.(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Stream a partition's current batch (single-file or segmented) message by
 * message into the accumulator; one segment is in memory at a time. */
function accumulateBatch(
  ref: NonNullable<UsageSnapshotPartition["nativeBatch"]>,
  nativeRoot: string,
  acc: RowAccumulator,
  onRead?: (path: string) => void,
): void {
  const batchPath = join(nativeRoot, ref.path.slice("usage/native/".length));
  const envelope = readJsonFile(batchPath, onRead) as Record<string, unknown>;
  if (Array.isArray(envelope.messages)) {
    for (const message of envelope.messages) if (message && typeof message === "object") acc.add(message as Record<string, unknown>);
    return;
  }
  const manifest = parseSegmentedNativeManifest(envelope, ref.partitionId);
  const dir = nativeSegmentDir(nativeRoot, ref.partitionId);
  for (const segment of manifest.segments) {
    const messages = readJsonFile(join(dir, `${segment.sha256}.json`), onRead);
    if (!Array.isArray(messages)) throw new Error("native-segment-mismatch");
    for (const message of messages) if (message && typeof message === "object") acc.add(message as Record<string, unknown>);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing left */ }
    throw error;
  }
}

function readPartitionCache(path: string): PartitionAggregate | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PartitionAggregate;
    if (value.schemaVersion === CACHE_SCHEMA && typeof value.key === "string" && Array.isArray(value.rows) && value.labels && typeof value.labels === "object") return value;
  } catch { /* missing or torn: recompute */ }
  return undefined;
}

/** Build and write projects.json from the snapshot's current native batches.
 * Each partition's aggregate is cached by its batch sha256 (plus the pool
 * ledger for swap pools), so an unchanged batch is not read again. A partition
 * whose batch cannot be read keeps its previous cached aggregate when there is
 * one. Never reads transcripts. */
export async function updateUsageProjects(snapshot: Pick<UsageSnapshot, "partitions">, deps: UsageProjectsDeps = {}): Promise<UsageProjectsFile> {
  const usageDir = deps.usageDir ?? join(aisCacheDir(), "usage");
  const nativeRoot = join(usageDir, "native");
  const cacheDir = join(usageDir, "projects-cache");
  const poolAttribution = deps.poolAttribution ?? defaultPoolAttributionFor();
  const poolFingerprint = (deps.poolFingerprint ?? defaultPoolFingerprint)();
  const rows: ProjectUsageRow[] = [];
  const labels = new Map<string, string>();
  const keepFiles = new Set<string>();

  for (const [partitionKey, partition] of Object.entries(snapshot.partitions)) {
    const ref = partition.nativeBatch;
    if (!ref) continue;
    const cachePath = join(cacheDir, `${createHash("sha256").update(partitionKey).digest("hex")}.json`);
    keepFiles.add(cachePath);
    let aggregate = readPartitionCache(cachePath);
    // Pool partitions split their messages over the members; anything else is
    // attributed to the partition's own identity.
    let pool: PoolAttribution | undefined;
    let poolFailed = false;
    if (partition.tool === "claude" || partitionKey.startsWith(SWAP_POOL_KEY_PREFIX)) {
      try { pool = await poolAttribution(partition.identity ?? ""); } catch { poolFailed = true; }
    }
    // Registry unreadable: keep the last good aggregate rather than misattribute.
    if (poolFailed && !aggregate) continue;
    const cacheKey = `${ref.sha256}|${ref.path}${pool ? `|${poolFingerprint}` : ""}`;
    if (!poolFailed && aggregate?.key !== cacheKey) {
      try {
        const tool = partition.tool ?? "unknown";
        const identity = partition.identity ?? partition.results[0]?.identity.name ?? partitionKey;
        const acc = new RowAccumulator(tool, identity, pool);
        accumulateBatch(ref, nativeRoot, acc, deps.onFileRead);
        aggregate = { schemaVersion: CACHE_SCHEMA, key: cacheKey, rows: [...acc.rows.values()], labels: acc.labels };
        atomicWriteJson(cachePath, aggregate);
      } catch {
        // Keep the last good aggregate of this partition, if any.
      }
    }
    if (!aggregate) continue;
    for (const row of aggregate.rows) rows.push(row);
    for (const [key, label] of Object.entries(aggregate.labels)) if (!labels.has(key)) labels.set(key, label);
  }

  const keys = new Map<string, string>();
  for (const row of rows) if (!keys.has(row.workspace)) keys.set(row.workspace, labels.get(row.workspace) ?? "");
  const workspaces = resolveWorkspaces(keys, { cachePath: join(usageDir, "projects-workspaces.json"), ...deps.workspace });
  const file: UsageProjectsFile = {
    schemaVersion: FILE_SCHEMA,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    workspaces,
    rows,
  };
  atomicWriteJson(join(usageDir, "projects.json"), file);
  return file;
}

/** Read projects.json (no scan) and resolve each row's workspace. Undefined
 * when the collector has not written it yet. */
export function readUsageProjects(path = USAGE_PROJECTS_FILE): { generatedAt: string; rows: UsageProjectApiRow[] } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as UsageProjectsFile;
    if (value.schemaVersion !== FILE_SCHEMA || typeof value.generatedAt !== "string" || !Array.isArray(value.rows) || !value.workspaces) return undefined;
    const rows = value.rows.map((row): UsageProjectApiRow => {
      const workspace = value.workspaces[row.workspace] ?? { path: row.workspace, source: "missing" as const };
      return {
        ...row,
        path: workspace.path,
        ...(workspace.repo ? { repo: workspace.repo } : {}),
        ...(workspace.org ? { org: workspace.org } : {}),
        ...(workspace.host ? { host: workspace.host } : {}),
        source: workspace.source,
        ...(workspace.inferred ? { inferred: true as const } : {}),
        ...(workspace.name ? { name: workspace.name } : {}),
      };
    });
    return { generatedAt: value.generatedAt, rows };
  } catch {
    return undefined;
  }
}
