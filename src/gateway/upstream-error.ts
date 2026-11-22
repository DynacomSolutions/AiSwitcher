/**
 * What the provider said when it refused a request, for the gateway's request log. Without it a 400 is only a number and
 * the reason is lost (incident 18 Nov 2026: a Kimi thread failed every turn and the log held `"http":400` alone).
 *
 * Only the error's own fields are kept (type, code, message), each cut short and with anything credential-shaped
 * removed. The request body, the response body as a whole and headers are never logged.
 */
export interface UpstreamErrorSummary {
  type?: string;
  code?: string;
  message?: string;
}

/** Longest message kept. */
export const ERROR_MESSAGE_MAX = 300;
const ERROR_FIELD_MAX = 80;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]"], // JWT
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  [/\b(?:aisg|sk|pk|rk|xai|gsk|ghp|gho|ghs|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]"], // prefixed API keys and gateway tokens
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]"], // long opaque runs: tokens, base64 data
];

/** `s` with credential-shaped text removed, control characters and runs of spaces collapsed, cut to `max` characters. */
export function redactText(s: string, max = ERROR_MESSAGE_MAX): string {
  let out = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined);

/** The JSON of an error body: the body itself, or the first `data:` line of an event stream. */
function parseBody(raw: string): unknown {
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5));
    } catch {
      // the next data line may parse
    }
  }
  return undefined;
}

/**
 * The provider's error from the first bytes of an error body. Understands the Anthropic (`{type:"error",error:{type,message}}`),
 * OpenAI (`{error:{message,type,code}}`), ChatGPT backend (`{detail: ...}`) and plain (`{message}`, `{error:"..."}`) shapes;
 * a body that is not JSON (an HTML error page, plain text) gives its text as the message. Undefined when there is nothing to say.
 */
export function summariseUpstreamError(bytes: Uint8Array): UpstreamErrorSummary | undefined {
  if (bytes.length === 0) return undefined;
  const raw = new TextDecoder().decode(bytes);
  const top = record(parseBody(raw));
  if (top) return summariseErrorJson(top);
  // Not JSON: an edge's HTML page or plain text. Tags go, the words stay.
  const plain = redactText(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "));
  return plain ? { message: plain } : undefined;
}

/** The error fields of one parsed JSON error object (any of the shapes above). Undefined when it names no type, code or message. */
export function summariseErrorJson(top: Record<string, unknown>): UpstreamErrorSummary | undefined {
  const out: UpstreamErrorSummary = {};
  const err = record(top.error) ?? record(top.detail) ?? {};
  const type = text(err.type) ?? (top.type !== "error" ? text(top.type) : undefined);
  const code = text(err.code) ?? text(top.code) ?? text(err.status) ?? text(top.status);
  const message = text(err.message) ?? text(top.message) ?? text(top.error) ?? text(top.detail) ?? text(top.error_description) ?? text(err.detail);
  if (type) out.type = redactText(type, ERROR_FIELD_MAX);
  if (code) out.code = redactText(code, ERROR_FIELD_MAX);
  if (message) out.message = redactText(message);
  return out.type || out.code || out.message ? out : undefined;
}

/** Keeps the first `cap` bytes of a body as it streams past. */
export class ErrorPeek {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}
  write(chunk: Uint8Array): void {
    if (this.size >= this.cap) return;
    const take = chunk.subarray(0, this.cap - this.size);
    this.chunks.push(take);
    this.size += take.length;
  }
  summary(): UpstreamErrorSummary | undefined {
    const bytes = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return summariseUpstreamError(bytes);
  }
}

/** A short, safe name for a failed upstream call (`TimeoutError`, `ECONNRESET`), never its message. */
export function failureName(err: unknown): string | undefined {
  const e = err as { code?: unknown; name?: unknown } | null;
  for (const v of [e?.code, e?.name]) if (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v) && v !== "Error") return v;
  return undefined;
}
