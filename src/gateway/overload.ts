/**
 * Upstream answers that mean "this provider login could not serve the request, another one may": an overload or a server
 * error. They arrive before any content, so a pool request with a replayable body can go to the next member. They are not
 * quota: the member is not held back.
 */
import { summariseUpstreamError } from "./upstream-error.ts";

export type RetryReason = "overloaded" | "server_error";

export interface RetryInfo {
  reason: RetryReason;
  /** A usage-limit error delivered inside a successful event stream. */
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
 * True for a call that asks a model for an answer (messages, chat completions, responses, completions). Only these may
 * fail over on an overload: a create call such as a file upload or a message batch may have taken effect already.
 */
export const isModelCall = (method: string, rest: string): boolean => method.toUpperCase() === "POST" && MODEL_CALL_PATH.test(rest);

/** HTTP statuses that fail over: 529 is Anthropic's overload, the others are server errors. */
const RETRY_STATUSES = new Set([500, 502, 503, 504, 529]);

export function retryReasonForStatus(status: number, errorType?: string): RetryReason | undefined {
  if (!RETRY_STATUSES.has(status)) return undefined;
  return status === 529 || errorType === "overloaded_error" ? "overloaded" : "server_error";
}

/** What the first bytes of an event stream say. `pending`: not enough bytes yet. `pass`: a normal stream. `error`: the first event is an error event. */
export type FirstEvent = { state: "pending" } | { state: "pass" } | { state: "error"; errorType?: string; errorCode?: string; errorMessage?: string; requestId?: string };

/**
 * Reads the start of an SSE body and decides as early as it can. A normal stream is decided on its first `event:` line
 * (anything but `error`), so it is never held back for more bytes. An error event is decided when its data line is whole.
 */
export function firstEventOf(bytes: Uint8Array): FirstEvent {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  // The last element is an unfinished line (or empty): it is not read.
  lines.pop();
  let sawError = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(":")) continue; // comment (ping)
    if (line === "") {
      if (sawError) return { state: "error" }; // an error event without data
      continue; // blank lines before the first event
    }
    if (line.startsWith("event:")) {
      if (line.slice(6).trim() !== "error") return { state: "pass" };
      sawError = true;
      continue;
    }
    if (line.startsWith("data:")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(5));
      } catch {
        return sawError ? { state: "error" } : { state: "pass" };
      }
      const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { type?: unknown; error?: { type?: unknown; code?: unknown; message?: unknown } | string; response?: { error?: { code?: unknown; message?: unknown } | null }; request_id?: unknown; code?: unknown; message?: unknown };
      const error = typeof obj.error === "object" && obj.error !== null ? obj.error : undefined;
      const responseError = obj.response?.error;
      const isError = sawError || obj.type === "error" || obj.type === "response.failed" || error !== undefined || responseError != null;
      if (!isError) return { state: "pass" };
      const errorType = typeof error?.type === "string" ? error.type : undefined;
      const errorCode = typeof error?.code === "string" ? error.code : typeof responseError?.code === "string" ? responseError.code : typeof obj.code === "string" ? obj.code : undefined;
      const errorMessage = typeof error?.message === "string" ? error.message : typeof responseError?.message === "string" ? responseError.message : typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : undefined;
      const requestId = typeof obj.request_id === "string" ? obj.request_id : undefined;
      return { state: "error", ...(errorType ? { errorType } : {}), ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}), ...(requestId ? { requestId } : {}) };
    }
    return { state: "pass" }; // not an event stream line
  }
  return { state: "pending" };
}

/** The retry reason for a first error event of a stream: only overload and api errors fail over. */
export function retryReasonForStreamError(errorType: string | undefined): RetryReason | undefined {
  if (errorType === "overloaded_error") return "overloaded";
  if (errorType === "api_error") return "server_error";
  return undefined;
}

/** The provider's error type from a bounded error body, for the log. */
export function errorTypeOfBody(bytes: Uint8Array): string | undefined {
  return summariseUpstreamError(bytes)?.type;
}
