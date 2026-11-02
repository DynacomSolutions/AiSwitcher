import { estimateChatModelTokenCost, estimateDetailedModelTokenCost } from "../identities/model-pricing.ts";
import type { UsageStyle } from "./providers/index.ts";
import type { GatewayProvider } from "./types.ts";

/**
 * Token counts for one upstream response.
 *
 * Semantics (identical for every style): `inputTokens` is UNCACHED input only,
 * and cache reads and writes are reported separately. Anthropic already reports
 * it that way. OpenAI reports prompt tokens INCLUDING cached tokens, so the tap
 * subtracts `cached_tokens` from them. Total input is therefore
 * `inputTokens + cacheReadTokens + cacheWriteTokens`, and summing the fields
 * never double counts, for the daily cap or for cost.
 */
export interface UsageCounts {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Largest JSON body held for parsing; beyond it the result is zero counts. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Largest single SSE event held; a bigger event is skipped. */
const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * Outcome of the tap: "ok" usage found, "none" a well-formed body without usage,
 * "unparseable" nothing usable and some of it was not valid, "overflow" part of
 * the body exceeded a cap so counts may be incomplete.
 */
export type UsageStatus = "ok" | "none" | "unparseable" | "overflow";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Observes response bytes and extracts token usage. It never alters or delays
 * the bytes (callers pass the same chunk on), never throws, and holds at most
 * one partial SSE event or a capped JSON body.
 */
export class UsageTap {
  private readonly counts: UsageCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // SSE or JSON. When the upstream names neither (the Codex backend sends no content-type on its
  // SSE), the mode is decided from the first non-whitespace byte: `e`(vent), `d`(ata) or `:` is SSE.
  private sse: boolean;
  private sniffing: boolean;
  private readonly decoder = new TextDecoder("utf-8");
  // JSON mode
  private readonly parts: Uint8Array[] = [];
  private held = 0;
  private overflow = false;
  private found = false;
  private bad = false;
  // SSE mode
  private line = "";
  private lineTooLong = false;
  private skipLf = false;
  private data: string[] = [];
  private dataBytes = 0;
  private eventTooBig = false;

  constructor(private readonly style: UsageStyle, contentType: string) {
    const ct = contentType.toLowerCase();
    this.sse = ct.includes("text/event-stream");
    this.sniffing = !this.sse && !ct.includes("json");
  }

  write(chunk: Uint8Array): void {
    try {
      if (this.sniffing) {
        const first = chunk.findIndex((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
        if (first === -1) return; // Whitespace carries nothing in either mode.
        this.sniffing = false;
        const b = chunk[first]!;
        this.sse = b === 0x65 || b === 0x64 || b === 0x3a;
        chunk = chunk.subarray(first);
      }
      if (this.sse) this.writeSse(chunk);
      else this.writeJson(chunk);
    } catch {
      // Observation must never affect the response.
    }
  }

  /** Call after the body ends (it flushes pending input, like result()). */
  status(): UsageStatus {
    this.result();
    if (this.overflow) return "overflow";
    if (this.found) return "ok";
    return this.bad ? "unparseable" : "none";
  }

  result(): UsageCounts {
    try {
      if (this.sse) {
        this.feedText(this.decoder.decode());
        this.endLine();
        this.dispatch();
      } else if (!this.overflow && this.held > 0 && this.parts.length > 0) {
        const buf = new Uint8Array(this.held);
        let at = 0;
        for (const p of this.parts) {
          buf.set(p, at);
          at += p.length;
        }
        this.parts.length = 0;
        this.apply(JSON.parse(new TextDecoder().decode(buf)));
      }
    } catch {
      this.bad = true; // Malformed body: keep whatever was parsed so far.
    }
    return { ...this.counts };
  }

  private writeJson(chunk: Uint8Array): void {
    if (this.overflow) return;
    if (this.held + chunk.length > MAX_JSON_BYTES) {
      this.overflow = true;
      this.parts.length = 0;
      this.held = 0;
      return;
    }
    this.parts.push(chunk.slice());
    this.held += chunk.length;
  }

  private writeSse(chunk: Uint8Array): void {
    this.feedText(this.decoder.decode(chunk, { stream: true }));
  }

  private feedText(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (this.skipLf) {
        this.skipLf = false;
        if (ch === 10) {
          start = i + 1;
          continue;
        }
      }
      if (ch !== 10 && ch !== 13) continue;
      this.appendLine(text.slice(start, i));
      this.endLine();
      if (ch === 13) this.skipLf = true;
      start = i + 1;
    }
    this.appendLine(text.slice(start));
  }

  private appendLine(s: string): void {
    if (!s || this.lineTooLong) return;
    if (this.line.length + s.length > MAX_EVENT_BYTES) {
      this.lineTooLong = true;
      this.line = "";
      return;
    }
    this.line += s;
  }

  private endLine(): void {
    const line = this.line;
    const tooLong = this.lineTooLong;
    this.line = "";
    this.lineTooLong = false;
    if (tooLong) {
      this.eventTooBig = true;
      this.overflow = true;
      return;
    }
    if (line === "") {
      this.dispatch();
      return;
    }
    if (!line.startsWith("data:")) return; // comments, event:, id:, retry:
    let v = line.slice(5);
    if (v.startsWith(" ")) v = v.slice(1);
    this.dataBytes += v.length + 1; // count the newline so empty lines are bounded too
    if (this.dataBytes > MAX_EVENT_BYTES) {
      this.eventTooBig = true;
      this.overflow = true;
      this.data = [];
      return;
    }
    if (!this.eventTooBig) this.data.push(v);
  }

  private dispatch(): void {
    const data = this.data;
    const skip = this.eventTooBig;
    this.data = [];
    this.dataBytes = 0;
    this.eventTooBig = false;
    if (skip || data.length === 0) return;
    const joined = data.join("\n");
    if (joined === "[DONE]") return;
    try {
      this.apply(JSON.parse(joined));
    } catch {
      this.bad = true; // Not JSON: ignore the event.
    }
  }

  private apply(root: unknown): void {
    if (!isObj(root)) {
      this.bad = true;
      return;
    }
    if (this.style === "anthropic") this.applyAnthropic(root);
    else if (this.style === "openai-responses") this.applyResponses(root);
    else this.applyChat(root);
  }

  private setModel(v: unknown): void {
    if (typeof v === "string" && v) this.counts.model = v;
  }

  private applyAnthropic(root: Obj): void {
    const msg = isObj(root.message) ? root.message : root;
    this.setModel(msg.model);
    const u = isObj(msg.usage) ? msg.usage : isObj(root.usage) ? root.usage : undefined;
    if (!u) return;
    // Values are cumulative, so keep the max: a compat provider sending
    // input_tokens:0 in message_delta must not zero the earlier input count.
    const c = this.counts;
    this.found = true;
    c.inputTokens = Math.max(c.inputTokens, num(u.input_tokens) ?? 0);
    c.outputTokens = Math.max(c.outputTokens, num(u.output_tokens) ?? 0);
    c.cacheReadTokens = Math.max(c.cacheReadTokens, num(u.cache_read_input_tokens) ?? 0);
    c.cacheWriteTokens = Math.max(c.cacheWriteTokens, num(u.cache_creation_input_tokens) ?? 0);
  }

  private applyResponses(root: Obj): void {
    const r = isObj(root.response) ? root.response : root;
    this.setModel(r.model);
    const u = r.usage;
    if (!isObj(u)) return;
    const prompt = num(u.input_tokens);
    if (prompt === undefined) return;
    this.setOpenAi(prompt, num(u.output_tokens), isObj(u.input_tokens_details) ? num(u.input_tokens_details.cached_tokens) : undefined);
  }

  private applyChat(root: Obj): void {
    this.setModel(root.model);
    const u = root.usage;
    if (!isObj(u)) return;
    const prompt = num(u.prompt_tokens);
    if (prompt === undefined) return;
    this.setOpenAi(prompt, num(u.completion_tokens), isObj(u.prompt_tokens_details) ? num(u.prompt_tokens_details.cached_tokens) : undefined);
  }

  private setOpenAi(prompt: number, output: number | undefined, cached: number | undefined): void {
    this.found = true;
    const read = Math.min(cached ?? 0, prompt);
    this.counts.inputTokens = prompt - read;
    this.counts.cacheReadTokens = read;
    this.counts.cacheWriteTokens = 0;
    this.counts.outputTokens = output ?? 0;
  }
}

/**
 * Estimated USD cost, or undefined for an unknown model. Z.AI and Ali price
 * cache reads at their cached-input rate (writes at the input rate); other
 * providers use the chat list prices with separate cache rates.
 */
export function estimateCost(provider: GatewayProvider, c: UsageCounts): number | undefined {
  if (!c.model) return undefined;
  if (provider === "zai" || provider === "ali") {
    return estimateDetailedModelTokenCost(provider === "zai" ? "zai" : "alibaba", c.model, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens);
  }
  return estimateChatModelTokenCost(c.model, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens);
}
