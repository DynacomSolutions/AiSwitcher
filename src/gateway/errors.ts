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

/** Set on every error answer the gateway itself builds: a short slug for why. Upstream answers never carry it. */
export const GATEWAY_ERROR_HEADER = "x-ais-gateway-error";
/** Set on every answer that came from a provider and passes through: the provider's name. */
export const GATEWAY_UPSTREAM_HEADER = "x-ais-gateway-upstream";
/** Every message the gateway writes starts with this, so a client can tell it from a provider's own error. */
export const GATEWAY_MESSAGE_PREFIX = "AIS gateway: ";

/** Marks an answer the gateway built itself (a limit answer in a provider's native shape) with the reason slug. The body stays as it is. */
export function markGatewayError(res: Response, reason: string): Response {
  res.headers.set(GATEWAY_ERROR_HEADER, reason);
  return res;
}

function build(style: ApiStyle, status: number, text: string, reason: string): Response {
  const type = typeFor(style, status);
  const body =
    style === "anthropic"
      ? { type: "error", error: { type, message: text } }
      : { error: { message: text, type, param: null, code: status === 401 ? "invalid_api_key" : null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", [GATEWAY_ERROR_HEADER]: reason } });
}

/**
 * A gateway-originated error in the shape the provider's own SDK expects. The message starts with "AIS gateway: " and the
 * header `x-ais-gateway-error` names the reason, so no client takes it for a provider answer. Never use status 529 here:
 * that is the provider's own overload code.
 */
export function providerError(style: ApiStyle, status: number, message: string, reason: string): Response {
  return build(style, status, message.startsWith(GATEWAY_MESSAGE_PREFIX) ? message : `${GATEWAY_MESSAGE_PREFIX}${message}`, reason);
}

/**
 * A limit answer (429) in the provider's error shape. Its message keeps the form `You've hit your <kind> limit (...)`
 * that clients read to wait for the reset (see `limitMessage`), so it carries no prefix. It still names the gateway in
 * its header and in its reason text.
 */
export function limitError(style: ApiStyle, message: string, reason: string): Response {
  return build(style, 429, message, reason);
}
