import type { ApiStyle } from "./types.ts";

function typeFor(style: ApiStyle, status: number): string {
  if (style === "anthropic") {
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 404) return "not_found_error";
    if (status === 413) return "request_too_large";
    if (status === 429) return "rate_limit_error";
    if (status >= 500) return "api_error";
    return "invalid_request_error";
  }
  if (status === 401) return "invalid_request_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

/** A gateway-originated error in the shape the provider's own SDK expects. */
export function providerError(style: ApiStyle, status: number, message: string): Response {
  const type = typeFor(style, status);
  const body =
    style === "anthropic"
      ? { type: "error", error: { type, message } }
      : { error: { message, type, param: null, code: status === 401 ? "invalid_api_key" : null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
