import { estimateChatModelTokenCost, estimateModelTokenCost } from "../identities/model-pricing.ts";
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
  private readonly sse: boolean;
  private readonly decoder = new TextDecoder("utf-8");
  // JSON mode
  private readonly parts: Uint8Array[] = [];
  private held = 0;
  private overflow = false;
  // SSE mode
  private line = "";
  private lineTooLong = false;
  private skipLf = false;
  private data: string[] = [];
  private dataBytes = 0;
  private eventTooBig = false;

  constructor(private readonly style: UsageStyle, contentType: string) {
    this.sse = contentType.toLowerCase().includes("text/event-stream");
  }

  write(chunk: Uint8Array): void {
    try {
      if (this.sse) this.writeSse(chunk);
      else this.writeJson(chunk);
    } catch {
      // Observation must never affect the response.
    }
  }

  result(): UsageCounts {
    try {
      if (this.sse) {
        this.feedText(this.decoder.decode());
        this.endLine();
        this.dispatch();
      } else if (!this.overflow && this.held > 0) {
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
      // Malformed body: keep whatever was parsed so far.
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
      return;
    }
    if (line === "") {
      this.dispatch();
      return;
    }
    if (!line.startsWith("data:")) return; // comments, event:, id:, retry:
    let v = line.slice(5);
    if (v.startsWith(" ")) v = v.slice(1);
    this.dataBytes += v.length;
    if (this.dataBytes > MAX_EVENT_BYTES) {
      this.eventTooBig = true;
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
      // Not JSON: ignore the event.
    }
  }

  private apply(root: unknown): void {
    if (!isObj(root)) return;
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
    // Later events carry cumulative values, so a present field replaces the earlier one.
    const c = this.counts;
    c.inputTokens = num(u.input_tokens) ?? c.inputTokens;
    c.outputTokens = num(u.output_tokens) ?? c.outputTokens;
    c.cacheReadTokens = num(u.cache_read_input_tokens) ?? c.cacheReadTokens;
    c.cacheWriteTokens = num(u.cache_creation_input_tokens) ?? c.cacheWriteTokens;
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
    const read = Math.min(cached ?? 0, prompt);
    this.counts.inputTokens = prompt - read;
    this.counts.cacheReadTokens = read;
    this.counts.cacheWriteTokens = 0;
    this.counts.outputTokens = output ?? 0;
  }
}

/**
 * Estimated USD cost, or undefined for an unknown model. Z.AI and Ali only have
 * flat in/out prices, so all input-side tokens are charged at the input rate
 * (a slight over-estimate when cache reads are present). Other providers use
 * the chat list prices with the separate cache rates.
 */
export function estimateCost(provider: GatewayProvider, c: UsageCounts): number | undefined {
  if (!c.model) return undefined;
  if (provider === "zai" || provider === "ali") {
    const input = c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
    return estimateModelTokenCost(provider === "zai" ? "zai" : "alibaba", c.model, input, c.outputTokens);
  }
  return estimateChatModelTokenCost(c.model, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens);
}
