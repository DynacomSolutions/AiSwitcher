import type { ApiStyle, GatewayProvider } from "../types.ts";

export type UsageStyle = "anthropic" | "openai-responses" | "openai-chat";

/** Resolved upstream credential. Never serialised, logged or put in errors. */
export interface ProviderCredential {
  identity: string;
  accessToken: string;
  accountId?: string;
  expiresAtMs?: number;
}

export interface ProviderAdapter {
  provider: GatewayProvider;
  upstreamBase(style: ApiStyle): string;
  authHeaders(cred: ProviderCredential): Record<string, string>;
  /** Lower-case request headers removed before the upstream call (gateway auth and anything the adapter sets). */
  stripRequestHeaders: string[];
  refreshable: boolean;
  usageStyle(style: ApiStyle): UsageStyle;
}

/** Headers that can carry the gateway token (or a caller-supplied upstream credential). */
export const BASE_STRIP_HEADERS = ["authorization", "x-api-key", "api-key"];

export function unsupportedStyle(provider: GatewayProvider, style: ApiStyle): Error {
  return new Error(`gateway: provider ${provider} has no ${style} upstream configured in AIS`);
}

export const bearer = (token: string): string => `Bearer ${token}`;
