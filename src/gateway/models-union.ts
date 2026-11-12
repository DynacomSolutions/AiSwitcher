import type { GatewayDeps } from "./app.ts";
import { stripHopByHop, upstreamHeaders } from "./app.ts";
import { providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import { allowedMembers } from "./select.ts";
import type { ApiStyle, GatewayApp } from "./types.ts";

/**
 * Model lists for a pool app. Pool members can be on different plans, so one member's list is not what the pool can
 * serve: a request for a model only some members have still succeeds, because the model path fails over to the next
 * member. A collection (`GET /models`) is therefore the union of every member's list; a single model
 * (`GET /models/<id>`) is answered by the first member that has it. A pinned app has one identity and keeps the plain
 * pass-through.
 *
 * Union rules: entries are matched by `slug` (Codex) or `id` (Anthropic and OpenAI style); the entry with the widest
 * visibility wins ("list" beats anything else, anything beats "hide"), and all its other fields come from the member
 * that has that visibility. A member that fails or answers something that is not a model list is left out; when no
 * member answers with a list, the first member's own answer is passed through.
 */

/** Request headers that would let the provider answer 304 (no body to merge). */
const CONDITIONAL = ["if-none-match", "if-modified-since"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PoolModelsInput {
  app: GatewayApp;
  deps: GatewayDeps;
  style: ApiStyle;
  /** Upstream URL including the query string. */
  url: string;
  incoming: Headers;
  signal: AbortSignal;
  /** true: `/models/<id>` (first member that has it); false: the collection (union). */
  single: boolean;
}

interface MemberAnswer {
  name: string;
  res?: Response;
  json?: unknown;
}

export async function poolModels(input: PoolModelsInput): Promise<Response> {
  const { app, deps, style, url, signal } = input;
  let names: string[];
  try {
    names = await allowedMembers(app, deps);
  } catch {
    return providerError(style, 502, "model list unavailable");
  }
  if (names.length === 0) return providerError(style, 502, "model list unavailable");
  const adapter = adapterFor(app.provider);
  const incoming = new Headers(input.incoming);
  for (const h of CONDITIONAL) incoming.delete(h);

  const ask = async (name: string): Promise<MemberAnswer> => {
    try {
      const cred = await deps.creds.get(app.provider, name);
      const res = await deps.fetch(url, { method: "GET", headers: upstreamHeaders(adapter, cred, incoming), signal, redirect: "manual" });
      if (!res.ok) return { name, res };
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { name, res: new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers }), json };
    } catch {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      return { name };
    }
  };

  if (input.single) {
    let first: Response | undefined;
    for (const name of names) {
      const a = await ask(name);
      if (a.res?.ok) {
        if (first) await first.body?.cancel().catch(() => undefined);
        return passThrough(a.res);
      }
      if (!first && a.res) first = a.res;
      else await a.res?.body?.cancel().catch(() => undefined);
    }
    return first ? passThrough(first) : providerError(style, 502, "upstream request failed");
  }

  const answers = await Promise.all(names.map(ask));
  const lists = answers.filter((a) => a.res?.ok && listOf(a.json) !== undefined);
  if (lists.length === 0) {
    const first = answers.find((a) => a.res !== undefined)?.res;
    for (const a of answers) if (a.res && a.res !== first) await a.res.body?.cancel().catch(() => undefined);
    return first ? passThrough(first) : providerError(style, 502, "upstream request failed");
  }
  for (const a of answers) if (!lists.includes(a)) await a.res?.body?.cancel().catch(() => undefined);
  const merged = mergeModelLists(lists.map((a) => a.json));
  const body = JSON.stringify(merged);
  const headers = new Headers({ "content-type": "application/json" });
  // Codex keeps the list's ETag in its models cache: give the union its own, stable for the same content.
  headers.set("etag", `W/"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`);
  return new Response(body, { status: 200, headers });
}

function passThrough(res: Response): Response {
  const headers = new Headers(res.headers);
  stripHopByHop(headers);
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The model array of a list body and the field that names an entry: Codex `{ models: [{ slug }] }`, otherwise `{ data: [{ id }] }`. */
function listOf(body: unknown): { key: "models" | "data"; entries: unknown[] } | undefined {
  if (!isObj(body)) return undefined;
  if (Array.isArray(body.models)) return { key: "models", entries: body.models };
  if (Array.isArray(body.data)) return { key: "data", entries: body.data };
  return undefined;
}

function entryName(e: unknown): string | undefined {
  if (!isObj(e)) return undefined;
  const n = typeof e.slug === "string" ? e.slug : typeof e.id === "string" ? e.id : undefined;
  return n && n.length > 0 ? n : undefined;
}

/** "list" (or any explicit listing) beats no visibility field, which beats "hide". */
function visibilityRank(e: unknown): number {
  const v = isObj(e) ? e.visibility : undefined;
  if (v === undefined || v === null) return 1;
  if (v === "hide" || v === "hidden" || v === "none") return 0;
  return 2;
}

/**
 * The union of several model-list bodies of the same provider. The first body supplies every top-level field; the
 * list is merged; Anthropic's `first_id`/`last_id` follow the merged list and `has_more` is true when any member had more.
 */
export function mergeModelLists(bodies: unknown[]): unknown {
  const first = bodies.find((b) => listOf(b) !== undefined);
  const shape = listOf(first);
  if (!isObj(first) || !shape) return first;
  const order: string[] = [];
  const unnamed: unknown[] = [];
  const best = new Map<string, unknown>();
  for (const b of bodies) {
    const l = listOf(b);
    if (!l || l.key !== shape.key) continue;
    for (const e of l.entries) {
      const name = entryName(e);
      if (name === undefined) {
        if (b === first) unnamed.push(e);
        continue;
      }
      const have = best.get(name);
      if (have === undefined) {
        order.push(name);
        best.set(name, e);
      } else if (visibilityRank(e) > visibilityRank(have)) best.set(name, e);
    }
  }
  let entries: unknown[] = [...order.map((n) => best.get(n)), ...unnamed];
  // Codex lists are ordered by `priority`; keep that order across members (stable, so equal priorities keep first-seen order).
  if (shape.key === "models" && entries.every((e) => isObj(e) && typeof e.priority === "number")) {
    entries = [...entries].sort((a, b) => ((a as Json).priority as number) - ((b as Json).priority as number));
  }
  const out: Json = { ...first, [shape.key]: entries };
  if (shape.key === "data" && ("first_id" in first || "last_id" in first || "has_more" in first)) {
    const ids = entries.map(entryName).filter((n): n is string => n !== undefined);
    if ("first_id" in first) out.first_id = ids[0] ?? null;
    if ("last_id" in first) out.last_id = ids[ids.length - 1] ?? null;
    if ("has_more" in first) out.has_more = bodies.some((b) => isObj(b) && b.has_more === true);
  }
  return out;
}
