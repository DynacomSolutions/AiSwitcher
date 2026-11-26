/** A response body that fails before delivery can be retried against another pool member. */
export type RetryReason = "server_error";

export interface RetryInfo {
  reason: RetryReason;
  /** A provider-confirmed usage limit delivered inside a successful event stream. */
  quota?: boolean;
  http: number;
  errorType?: string;
  requestId?: string;
}

/**
 * `rest` is the path after the app name, as the client sends it. The provider base holds the version for the OpenAI-style
 * providers, so the client path may have none (`/responses`, `/chat/completions`) or a version (`/v1/...`, `/v4/...`). Codex
 * also sends `/backend-api/codex/...`, and Z.AI's own base path. Nothing else matches (`/v1/files`, `/messages/batches`).
 */
const MODEL_CALL_PATH = /^(?:\/v\d+|(?:\/backend-api)?\/codex|\/api\/(?:coding\/)?paas\/v\d+)?\/(?:messages|chat\/completions|responses(?:\/compact)?|completions)\/?$/;

/**
 * True for inference calls that can replay after confirmed quota exhaustion. Create calls can have side effects.
 */
export const isModelCall = (method: string, rest: string): boolean => method.toUpperCase() === "POST" && MODEL_CALL_PATH.test(rest);

/** What the bounded SSE prefix says. `pending`: pre-content events continue. `pass`: content starts. `error`: an error event starts. */
export type FirstEvent = { state: "pending" } | { state: "pass" } | { state: "error"; errorType?: string; errorCode?: string; errorMessage?: string; requestId?: string };

/**
 * Reads pre-content SSE lifecycle events until the stream starts content or reports an error.
 */
export function firstEventOf(bytes: Uint8Array): FirstEvent {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  // The last element is an unfinished line (or empty): it is not read.
  lines.pop();
  let eventName = "";
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(":")) continue; // comment (ping)
    if (line === "") {
      eventName = "";
      continue; // blank lines before the first event
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      if (eventName !== "error" && eventName !== "response.failed" && eventName !== "ping" && eventName !== "response.created" && eventName !== "response.in_progress") return { state: "pass" };
      continue;
    }
    if (line.startsWith("data:")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(5));
      } catch {
        return eventName === "error" || eventName === "response.failed" ? { state: "error" } : { state: "pass" };
      }
      const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { type?: unknown; error?: { type?: unknown; code?: unknown; message?: unknown } | string; response?: { error?: { code?: unknown; message?: unknown } | null }; request_id?: unknown; code?: unknown; message?: unknown };
      const error = typeof obj.error === "object" && obj.error !== null ? obj.error : undefined;
      const responseError = obj.response?.error;
      const isError = eventName === "error" || eventName === "response.failed" || obj.type === "error" || obj.type === "response.failed" || error !== undefined || responseError != null;
      if (!isError) {
        const lifecycle = eventName === "ping" || eventName === "response.created" || eventName === "response.in_progress" || obj.type === "response.created" || obj.type === "response.in_progress";
        if (lifecycle) continue;
        return { state: "pass" };
      }
      const errorType = typeof error?.type === "string" ? error.type : undefined;
      const errorCode = typeof error?.code === "string" ? error.code : typeof responseError?.code === "string" ? responseError.code : typeof obj.code === "string" ? obj.code : undefined;
      const errorMessage = typeof error?.message === "string" ? error.message : typeof responseError?.message === "string" ? responseError.message : typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : undefined;
      const requestId = typeof obj.request_id === "string" ? obj.request_id : undefined;
      return { state: "error", ...(errorType ? { errorType } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}), ...(requestId ? { requestId } : {}) };
    }
    if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) continue;
    return { state: "pass" }; // not an event stream line
  }
  return { state: "pending" };
}
