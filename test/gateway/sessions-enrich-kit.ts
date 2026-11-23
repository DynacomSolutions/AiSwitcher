import { createHash } from "node:crypto";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { advanceSessionIndex, type IndexedKind } from "../../src/cli/sessions/indexer.ts";
import { linesOfText } from "../../src/cli/sessions/lines.ts";
import { PartReadError, type PartSource } from "../../src/gateway/sessions/part-reader.ts";
import type { EnrichBacklog, EnrichCandidate, EnrichWrite, SessionPartRow } from "../../src/gateway/sessions/session-store.ts";
import type { EnrichMetrics, EnrichStore, EnrichErrorKind } from "../../src/gateway/sessions/enrich.ts";

/** Helpers for the session enrichment tests. All data is synthetic. */

export const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

export interface Keys {
  identity: string;
  recipient: string;
}
export async function makeKeys(): Promise<Keys> {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** Claude transcript lines, `n` of them, with a prompt on line 1 and a record time on each. */
export function claudeLines(n: number, tag = "a"): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 2, 1, 9, 0, i)).toISOString();
    if (i === 0) out.push(JSON.stringify({ type: "user", message: { role: "user", content: `First prompt ${tag}` }, cwd: "/srv/repositories/example-org/example-repo", timestamp: ts }));
    else if (i % 2 === 1) out.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a-1", content: [{ type: "text", text: `Answer ${i} ${tag}` }] }, timestamp: ts }));
    else out.push(JSON.stringify({ type: "user", message: { role: "user", content: `Prompt ${i} ${tag}` }, timestamp: ts }));
  }
  return out;
}

/** The index of the whole text in one pass: the oracle for every cut. */
export function wholePass(kind: IndexedKind, relPath: string, lines: string[]) {
  const text = lines.map((l) => `${l}\n`).join("");
  return advanceSessionIndex(kind, null, { startOffset: 0, endOffset: enc.encode(text).length, lines: linesOfText(text) }, relPath);
}

export interface StoredPart {
  row: SessionPartRow;
  bytes: Uint8Array;
}

/** In-memory object store. `reads` lists every key fetched, in order. */
export class FakeObjects implements PartSource {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  /** Throws this after the n-th read of a pass (crash simulation). */
  failAfter: { reads: number; error: Error } | undefined;
  async read(key: string): Promise<Uint8Array> {
    if (this.failAfter && this.reads.length >= this.failAfter.reads) throw this.failAfter.error;
    this.reads.push(key);
    const o = this.objects.get(key);
    if (!o) throw new PartReadError("missing", "the part object does not exist");
    return o;
  }
}

/** Cuts `lines` into parts of `perPart` lines, stores them encrypted in `objects`, returns the rows. */
export async function storeParts(objects: FakeObjects, recipient: string, fileTag: string, lines: string[], perPart: number, startAt = 0, startOffset = 0): Promise<SessionPartRow[]> {
  const rows: SessionPartRow[] = [];
  let offset = startOffset;
  for (let i = startAt; i < lines.length; i += perPart) {
    const plain = enc.encode(lines.slice(i, i + perPart).map((l) => `${l}\n`).join(""));
    const e = new Encrypter();
    e.addRecipient(recipient);
    const stored = await e.encrypt(Bun.gzipSync(plain));
    const key = `objects/v1/node-a/r/${fileTag}/g0/${offset}-${offset + plain.length}.gz.age`;
    objects.objects.set(key, stored);
    rows.push({ startOffset: offset, endOffset: offset + plain.length, lines: Math.min(perPart, lines.length - i), plainBytes: plain.length, objectBytes: stored.length, plainSha256: sha(plain), objectKey: key });
    offset += plain.length;
  }
  return rows;
}

export interface FakeFile {
  fileId: number;
  kind: string;
  relPath: string;
  generation: number;
  parts: SessionPartRow[];
  indexedBytes: number;
  scanState: unknown;
  lastIngestAt: number;
  fields: Record<string, unknown> | null;
  /** Number of successful writes. */
  writes: number;
}

/** In-memory `EnrichStore` with the same rules as the SQL: compare-and-set on `indexed_bytes`, byte-capped part window. */
export class FakeStore implements EnrichStore {
  readonly files = new Map<number, FakeFile>();
  calls = 0;
  /** Makes the next call of the named method throw once. */
  failNext: Partial<Record<"enrichQueue" | "applyEnrichment" | "enrichBacklog", Error>> = {};
  /** Called inside `applyEnrichment` before it writes (a second runner can move the file here). */
  beforeApply: ((w: EnrichWrite) => void) | undefined;

  add(kind: string, relPath: string, parts: SessionPartRow[], lastIngestAt = 1): FakeFile {
    const f: FakeFile = { fileId: this.files.size + 1, kind, relPath, generation: 0, parts, indexedBytes: 0, scanState: {}, lastIngestAt, fields: null, writes: 0 };
    this.files.set(f.fileId, f);
    return f;
  }

  committed(f: FakeFile): number {
    return f.parts.length === 0 ? 0 : f.parts[f.parts.length - 1]!.endOffset;
  }

  private take(name: "enrichQueue" | "applyEnrichment" | "enrichBacklog"): void {
    const e = this.failNext[name];
    if (e) {
      delete this.failNext[name];
      throw e;
    }
  }

  async enrichQueue(limit: number, skipIds: number[] = []): Promise<EnrichCandidate[]> {
    this.calls += 1;
    this.take("enrichQueue");
    return [...this.files.values()]
      .filter((f) => this.committed(f) > f.indexedBytes && ["claude", "codex"].includes(f.kind) && !skipIds.includes(f.fileId))
      .sort((a, b) => a.lastIngestAt - b.lastIngestAt || a.fileId - b.fileId)
      .slice(0, limit)
      .map((f) => ({ fileId: f.fileId, generation: f.generation, kind: f.kind, relPath: f.relPath, committedBytes: this.committed(f), indexedBytes: f.indexedBytes, scanState: structuredClone(f.scanState), lastIngestAt: f.lastIngestAt }));
  }

  async enrichBacklog(): Promise<EnrichBacklog> {
    this.take("enrichBacklog");
    const open = [...this.files.values()].filter((f) => this.committed(f) > f.indexedBytes && ["claude", "codex"].includes(f.kind));
    return { files: open.length, bytes: open.reduce((n, f) => n + this.committed(f) - f.indexedBytes, 0), oldestIngestAt: open.length ? Math.min(...open.map((f) => f.lastIngestAt)) : null };
  }

  async partsFrom(fileId: number, fromOffset: number, maxBytes: number): Promise<SessionPartRow[]> {
    const f = this.files.get(fileId)!;
    let before = 0;
    const out: SessionPartRow[] = [];
    for (const p of f.parts.filter((x) => x.startOffset >= fromOffset).sort((a, b) => a.startOffset - b.startOffset)) {
      if (before >= maxBytes) break;
      out.push(p);
      before += p.plainBytes;
    }
    return out;
  }

  async applyEnrichment(w: EnrichWrite): Promise<boolean> {
    this.take("applyEnrichment");
    this.beforeApply?.(w);
    const f = this.files.get(w.fileId)!;
    if (f.indexedBytes !== w.expectedIndexedBytes || w.fields.indexedBytes > this.committed(f)) return false;
    f.indexedBytes = w.fields.indexedBytes;
    f.scanState = structuredClone(w.state);
    f.fields = { ...w.fields };
    f.writes += 1;
    return true;
  }

  async markIndexed(fileId: number, expected: number): Promise<boolean> {
    const f = this.files.get(fileId)!;
    if (f.indexedBytes !== expected) return false;
    f.indexedBytes = this.committed(f);
    return true;
  }
}

export class RecordingMetrics implements EnrichMetrics {
  files = 0;
  parts = 0;
  plain = 0;
  object = 0;
  errors: EnrichErrorKind[] = [];
  successes: number[] = [];
  backlogs: EnrichBacklog[] = [];
  leaders: boolean[] = [];
  fileEnriched(plain: number, object: number, parts: number): void {
    this.files += 1;
    this.plain += plain;
    this.object += object;
    this.parts += parts;
  }
  error(k: EnrichErrorKind): void {
    this.errors.push(k);
  }
  success(at: number): void {
    this.successes.push(at);
  }
  backlog(b: EnrichBacklog): void {
    this.backlogs.push(b);
  }
  leader(l: boolean): void {
    this.leaders.push(l);
  }
}
