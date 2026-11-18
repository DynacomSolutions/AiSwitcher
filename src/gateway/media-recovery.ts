/**
 * Keeps a conversation usable when the provider refuses it for a media file it holds itself.
 *
 * Incident 18 Nov 2026 (board 4.213). kimi-code uploads each image to Kimi's file service (`POST /files`) and sends the
 * returned id (`ms://<id>`) in the chat request, caching the id on disk. Kimi answers some uploads `200` with
 * `"status":"error"` (for example `"image moderation unavailable"`). Every chat request that names such a file is then
 * refused with `400 Invalid request Error`, and because the client replays its whole history each turn, the session
 * fails for ever. The same images are accepted when sent inline.
 *
 * Two repairs, both for the OpenAI-style Kimi API only:
 * - an upload the provider marked as failed is answered as an error (`rejectedUpload`), so the client does not keep the
 *   id and sends the image inline instead;
 * - a chat request refused with 400 (or 404, for an app pinned to one account) has each file it names looked up; the
 *   parts whose file is failed (or gone, pinned apps only) are replaced by a text note and the request is sent once more
 *   (`fileIds`, `withoutFiles`). Ids found bad are remembered, so later turns of the same conversation are repaired
 *   before the first send.
 *
 * Inline (`data:`) media is never touched: the provider does not say which part it could not read.
 */
import { KIMI_ANTHROPIC_BASE } from "./providers/kimi.ts";
import type { GatewayProvider } from "./types.ts";

/** Response header on an answer made from a repaired request: the number of media parts replaced. */
export const MEDIA_REMOVED_HEADER = "x-ais-gateway-media-removed";

export const MEDIA_PLACEHOLDER = { image: "[image removed: rejected by provider]", video: "[video removed: rejected by provider]" } as const;

const FILE_URL = "ms://";
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** The bytes an id is made of (FILE_ID's character class). */
const ID_BYTE = Array.from({ length: 256 }, (_, c) => /[A-Za-z0-9._-]/.test(String.fromCharCode(c)));
const CHAT_PATH = /^(?:\/v1)?\/chat\/completions\/?$/;
const FILES_PATH = /^(?:\/v1)?\/files\/?$/;
/** Most files looked up for one refused request; a request naming more is left alone. */
export const MAX_FILE_CHECKS = 256;
const CHECK_CONCURRENCY = 8;
const KNOWN_BAD_MAX = 2000;
const KNOWN_BAD_TTL_MS = 24 * 3_600_000;

/** Where a provider's files are looked up by id (`<base>/<id>`), or undefined for a provider without the file-reference API this module understands. */
export const filesBase = (provider: GatewayProvider): string | undefined => (provider === "kimi" ? `${KIMI_ANTHROPIC_BASE}/v1/files` : undefined);
export const mediaAware = (provider: GatewayProvider): boolean => filesBase(provider) !== undefined;
export const isChatRequest = (method: string, rest: string): boolean => method.toUpperCase() === "POST" && CHAT_PATH.test(rest);
export const isUploadRequest = (method: string, rest: string): boolean => method.toUpperCase() === "POST" && FILES_PATH.test(rest);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

/** The provider file id a content part names (`image_url` or `video_url` with an `ms://<id>` url), and its kind. */
function fileOf(part: unknown): { id: string; kind: "image" | "video" } | undefined {
  const p = obj(part);
  const kind = p?.type === "image_url" ? "image" : p?.type === "video_url" ? "video" : undefined;
  if (!p || !kind) return undefined;
  const url = obj(p[`${kind}_url`])?.url;
  if (typeof url !== "string" || !url.startsWith(FILE_URL)) return undefined;
  const id = url.slice(FILE_URL.length);
  return FILE_ID.test(id) ? { id, kind } : undefined;
}

function eachPart(body: unknown, visit: (content: unknown[], index: number) => void): void {
  const messages = obj(body)?.messages;
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    const content = obj(m)?.content;
    if (Array.isArray(content)) for (let i = 0; i < content.length; i++) visit(content, i);
  }
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** The distinct provider file ids a chat request names, in order. Empty for a body that is not a chat request. */
export function fileIds(bytes: Uint8Array): string[] {
  if (!includes(bytes, FILE_URL)) return [];
  const ids = new Set<string>();
  eachPart(parse(bytes), (content, i) => {
    const f = fileOf(content[i]);
    if (f) ids.add(f.id);
  });
  return [...ids];
}

/**
 * Every `ms://<id>` in the raw bytes, without parsing them: a cheap superset of `fileIds` (it also sees an id inside plain
 * text), used to decide whether a request is worth parsing at all.
 */
export function mentionedFileIds(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids = new Set<string>();
  for (let at = buf.indexOf(FILE_URL); at !== -1; at = buf.indexOf(FILE_URL, at + FILE_URL.length)) {
    let end = at + FILE_URL.length;
    while (end < buf.length && end - at <= 205 && ID_BYTE[buf[end] as number]) end++;
    const id = buf.toString("latin1", at + FILE_URL.length, end);
    if (FILE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

/** The request with every part naming one of `bad` replaced by a text note, and how many were replaced. Undefined when none was. */
export function withoutFiles(bytes: Uint8Array, bad: ReadonlySet<string>): { bytes: Uint8Array; removed: number } | undefined {
  if (bad.size === 0 || !includes(bytes, FILE_URL)) return undefined;
  const body = parse(bytes);
  let removed = 0;
  eachPart(body, (content, i) => {
    const f = fileOf(content[i]);
    if (!f || !bad.has(f.id)) return;
    content[i] = { type: "text", text: MEDIA_PLACEHOLDER[f.kind] };
    removed++;
  });
  return removed > 0 ? { bytes: new TextEncoder().encode(JSON.stringify(body)), removed } : undefined;
}

function includes(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle);
}

/**
 * The provider's own failure note when an upload answer (a 2xx JSON file object) says the file failed, with the file id.
 * Undefined for a usable file or any other body.
 */
export function rejectedUpload(bytes: Uint8Array): { id?: string; details: string } | undefined {
  const file = obj(parse(bytes));
  if (!file || file.status !== "error") return undefined;
  const details = typeof file.status_details === "string" && file.status_details.trim() !== "" ? file.status_details : "file processing failed";
  return { ...(typeof file.id === "string" && FILE_ID.test(file.id) ? { id: file.id } : {}), details };
}

export type FileVerdict = "ok" | "bad" | "unknown";

/**
 * What a file lookup answer means: a failed file is "bad"; so is one that is gone (404) when `goneIsBad`. Anything unclear
 * is "unknown" and never removes a part. A file belongs to the account that uploaded it, so for a pool a 404 may only
 * mean that another member holds the file: there `goneIsBad` is false.
 */
export function fileVerdict(status: number, bytes: Uint8Array, goneIsBad: boolean): FileVerdict {
  if (status === 404) return goneIsBad ? "bad" : "unknown";
  if (status < 200 || status >= 300) return "unknown";
  const file = obj(parse(bytes));
  if (!file || typeof file.status !== "string") return "unknown";
  return file.status === "error" ? "bad" : "ok";
}

/** Looks up `ids` (at most CHECK_CONCURRENCY at once) and returns the bad ones. A lookup that throws counts as unknown. */
export async function badFiles(ids: string[], lookup: (id: string) => Promise<FileVerdict>): Promise<Set<string>> {
  const bad = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++] as string;
      try {
        if ((await lookup(id)) === "bad") bad.add(id);
      } catch {
        // unknown: the part stays
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, ids.length) }, worker));
  return bad;
}

/** File ids a provider has refused, per provider, for this process. Bounded and time-limited; a failed or deleted file never recovers. */
export class KnownBadFiles {
  private readonly until = new Map<string, number>();
  private key(provider: GatewayProvider, id: string): string {
    return `${provider}\u0000${id}`;
  }
  add(provider: GatewayProvider, id: string, nowMs: number): void {
    const k = this.key(provider, id);
    this.until.delete(k);
    this.until.set(k, nowMs + KNOWN_BAD_TTL_MS);
    while (this.until.size > KNOWN_BAD_MAX) this.until.delete(this.until.keys().next().value as string);
  }
  /** The ids of `ids` known to be bad now. */
  among(provider: GatewayProvider, ids: string[], nowMs: number): Set<string> {
    const out = new Set<string>();
    if (this.until.size === 0) return out;
    for (const id of ids) {
      const k = this.key(provider, id);
      const t = this.until.get(k);
      if (t === undefined) continue;
      if (t <= nowMs) this.until.delete(k);
      else out.add(id);
    }
    return out;
  }
  get size(): number {
    return this.until.size;
  }
}
