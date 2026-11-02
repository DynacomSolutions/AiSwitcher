// Shared plumbing for the per-provider gateway proofs. The SDK client itself is
// built in each script from baseURL + apiKey only, so nothing here can hide a
// gateway-specific client setting.

export const PROMPT = "Reply with the single word: ok";
export const MAX_TOKENS = 32;

/** The only two settings an app gets from its Secret ais-gateway-<app>. */
export function gatewayEnv(): { baseURL: string; apiKey: string } {
  const baseURL = process.env.AIS_GATEWAY_URL;
  const apiKey = process.env.AIS_GATEWAY_TOKEN;
  if (!baseURL || !apiKey) {
    console.error("AIS_GATEWAY_URL (including the app path) and AIS_GATEWAY_TOKEN must be set");
    process.exit(2);
  }
  return { baseURL, apiKey };
}

export const modelFor = (fallback: string): string => process.env.AIS_E2E_MODEL || fallback;

/** One JSON line on stdout: what the SDK itself reported for each request. */
export function printResult(provider: string, model: string, nonStreamed: unknown, streamed: unknown, labels: [string, string] = ["nonStreamed", "streamed"]): void {
  console.log(JSON.stringify({ provider, model, [labels[0]]: nonStreamed, [labels[1]]: streamed }));
}

/** Exit non-zero with the upstream status and a truncated error body (never the token). */
export function fail(provider: string, e: unknown): never {
  const err = e as { status?: number; error?: unknown; message?: string };
  const body = typeof err.error === "string" ? err.error : JSON.stringify(err.error ?? err.message ?? String(e));
  console.error(JSON.stringify({ provider, failed: true, status: err.status ?? null, body: body.slice(0, 600) }));
  process.exit(1);
}
