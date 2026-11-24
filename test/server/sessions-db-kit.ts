import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Encrypter } from "age-encryption";
import { advanceSessionIndex, type IndexedKind } from "../../src/cli/sessions/indexer.ts";
import { linesOfText } from "../../src/cli/sessions/lines.ts";
import type { SessionPartRow, SessionTreeQuery, SessionTreeRow } from "../../src/gateway/sessions/session-store.ts";
import { SessionsDbSource, type SessionsReadStore } from "../../src/server/sessions-db/db-source.ts";
import { SessionsReaderMetrics } from "../../src/server/sessions-db/metrics.ts";
import { PartCache } from "../../src/server/sessions-db/part-cache.ts";
import { PartLoader } from "../../src/server/sessions-db/part-lines.ts";
import type { SessionsSourceHandle } from "../../src/server/sessions-db/source.ts";
import { FakeObjects, makeKeys, sha, storeParts, type Keys } from "../gateway/sessions-enrich-kit.ts";

/** Helpers for the console database reader tests. All data is synthetic. */

export const T0 = Date.UTC(2026, 2, 1, 9, 0, 0);
export const ts = (i: number): string => new Date(T0 + i * 1000).toISOString();
export const msAt = (i: number): number => T0 + i * 1000;
const enc = new TextEncoder();

/** A Claude session: prompt, answers, and a tool call whose result arrives two lines later. */
export function claudeSession(tag: string, n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) out.push(JSON.stringify({ type: "user", message: { role: "user", content: `First prompt ${tag}` }, cwd: "/srv/repositories/example-org/example-repo", timestamp: ts(i) }));
    else if (i === 3) out.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a-1", content: [{ type: "tool_use", id: `tool-${tag}`, name: "Bash", input: { command: "ls" } }] }, timestamp: ts(i) }));
    else if (i === 4) out.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${tag}`, content: `listing ${tag}` }] }, timestamp: ts(i) }));
    else if (i % 2 === 1) out.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a-1", content: [{ type: "text", text: `Answer ${i} ${tag}` }], usage: { input_tokens: 3, output_tokens: 4 } }, timestamp: ts(i) }));
    else out.push(JSON.stringify({ type: "user", message: { role: "user", content: `Prompt ${i} ${tag}` }, timestamp: ts(i) }));
  }
  return out;
}

/** A Claude subagent transcript: header line with the agent id, then a task prompt and a reply. */
export function claudeAgent(agentId: string, parentId: string): string[] {
  return [
    JSON.stringify({ type: "user", isSidechain: true, sessionId: parentId, agentId, cwd: "/srv/repositories/example-org/example-repo", message: { role: "user", content: `Task for ${agentId}` }, timestamp: ts(20) }),
    JSON.stringify({ type: "assistant", isSidechain: true, sessionId: parentId, agentId, message: { role: "assistant", content: [{ type: "text", text: `Agent ${agentId} done` }] }, timestamp: ts(22) }),
  ];
}

/** A Codex rollout: meta line, a prompt, an answer and a tool call with its output. */
export function codexRollout(id: string): string[] {
  const m = (role: string, type: string, text: string) => ({ type: "message", role, content: [{ type, text }] });
  return [
    JSON.stringify({ type: "session_meta", timestamp: ts(30), payload: { id, cwd: "/srv/repositories/example-org/example-repo", timestamp: ts(30) } }),
    JSON.stringify({ type: "response_item", timestamp: ts(31), payload: m("user", "input_text", `Codex prompt ${id}`) }),
    JSON.stringify({ type: "response_item", timestamp: ts(32), payload: m("assistant", "output_text", `Codex answer ${id}`) }),
    JSON.stringify({ type: "response_item", timestamp: ts(33), payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "{\"cmd\":\"ls\"}" } }),
    JSON.stringify({ type: "response_item", timestamp: ts(34), payload: { type: "function_call_output", call_id: "c1", output: "files" } }),
    JSON.stringify({ type: "response_item", timestamp: ts(35), payload: m("assistant", "output_text", "Codex last") }),
  ];
}

export interface FixtureFile {
  kind: IndexedKind;
  relPath: string;
  identity: string | null;
  lines: string[];
}

/** In-memory read store with the same rules as the SQL: newest generation first, tail window of whole parts. */
export class FakeReadStore implements SessionsReadStore {
  readonly rows: SessionTreeRow[] = [];
  readonly parts = new Map<number, SessionPartRow[]>();
  failWith: Error | undefined;
  calls = 0;

  async ping(): Promise<void> {
    if (this.failWith) throw this.failWith;
  }

  async tree(q: SessionTreeQuery = {}): Promise<SessionTreeRow[]> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return this.rows
      .filter((r) => (q.kind === undefined || r.kind === q.kind) && (q.sinceMs === undefined || (r.updatedAt !== null && r.updatedAt >= q.sinceMs)))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.fileId - a.fileId);
  }

  async filesOfSession(kind: string, sessionRef: string): Promise<SessionTreeRow[]> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return this.rows.filter((r) => r.kind === kind && r.sessionRef === sessionRef).sort((a, b) => b.generation - a.generation || b.committedBytes - a.committedBytes);
  }

  async tailParts(fileId: number, windowBytes: number): Promise<SessionPartRow[]> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    const all = [...(this.parts.get(fileId) ?? [])].sort((a, b) => a.startOffset - b.startOffset);
    const out: SessionPartRow[] = [];
    let newer = 0;
    for (const p of [...all].reverse()) {
      if (newer >= windowBytes) break;
      out.unshift(p);
      newer += p.plainBytes;
    }
    return out;
  }
}

export interface Fixture {
  keys: Keys;
  objects: FakeObjects;
  store: FakeReadStore;
  metrics: SessionsReaderMetrics;
  cache: PartCache;
  db: SessionsDbSource;
  handle: (over?: Partial<SessionsSourceHandle>) => SessionsSourceHandle;
  /** Stores `file` in the fake store and object store, in parts of `perPart` lines. Returns its row. */
  add(file: FixtureFile, perPart: number, generation?: number): Promise<SessionTreeRow>;
  /** Writes `file` to a config dir as the tools do, with the mtime of its last record. */
  writeFile(configDir: string, file: FixtureFile, mtimeMs: number): Promise<string>;
}

export async function makeFixture(opts: { windowBytes?: number; cacheBytes?: number } = {}): Promise<Fixture> {
  const keys = await makeKeys();
  const objects = new FakeObjects();
  const store = new FakeReadStore();
  const metrics = new SessionsReaderMetrics();
  const cache = new PartCache(opts.cacheBytes ?? 8 * 1024 * 1024);
  const loader = new PartLoader({ source: objects, identity: keys.identity, cache, metrics });
  const db = new SessionsDbSource({ store, loader, metrics, windowBytes: opts.windowBytes ?? 4 * 1024 * 1024 });
  return {
    keys,
    objects,
    store,
    metrics,
    cache,
    db,
    handle: (over = {}) => ({ mode: "db", used: "db", db, fallback: false, close: async () => {}, ...over }),
    async add(file, perPart, generation = 0) {
      const fileId = store.rows.length + 1;
      const parts = await storeParts(objects, keys.recipient, `f${fileId}`, file.lines, perPart, 0, 0, `objects/v1/${file.kind}/f${fileId}/g${generation}/`);
      const text = file.lines.map((l) => `${l}\n`).join("");
      const step = advanceSessionIndex(file.kind, null, { startOffset: 0, endOffset: enc.encode(text).length, lines: linesOfText(text) }, file.relPath);
      const f = step.fields;
      const row: SessionTreeRow = {
        fileId,
        node: "node-a",
        root: "/data/pool",
        relPath: file.relPath,
        generation,
        kind: file.kind,
        origin: "pool-folder",
        pool: null,
        identity: file.identity,
        sessionRef: f.sessionRef,
        parentRef: f.parentRef,
        agentName: f.agentName,
        title: f.title,
        cwd: f.cwd,
        project: f.project,
        model: f.model,
        startedAt: f.startedAt,
        updatedAt: f.updatedAt,
        messageCount: f.messageCount,
        committedBytes: enc.encode(text).length,
        committedLines: file.lines.length,
        indexedBytes: f.indexedBytes,
      };
      store.rows.push(row);
      store.parts.set(fileId, parts);
      return row;
    },
    async writeFile(configDir, file, mtimeMs) {
      const base = file.kind === "claude" ? configDir : configDir;
      const path = join(base, file.relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.lines.map((l) => `${l}\n`).join(""));
      await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    },
  };
}

/** Encrypts and gzips `plain` for `recipient`, as the shipper does. */
export async function encryptPart(plain: Uint8Array, recipient: string): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(Bun.gzipSync(new Uint8Array(plain)));
}

export { FakeObjects, sha };

const temps: string[] = [];
export async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ais-sessions-db-"));
  temps.push(d);
  return d;
}
export async function cleanTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
