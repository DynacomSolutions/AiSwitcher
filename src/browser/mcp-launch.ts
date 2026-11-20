/**
 * Launch side of the gateway MCP endpoint: names, the session headers a launch sends, and small helpers.
 * Light imports only: every agent launch loads this file. The endpoint itself is `src/gateway/browser/mcp.ts`.
 */

/** Path of the shared MCP endpoint on the gateway. */
export const GATEWAY_MCP_PATH = "/browser/mcp";
/** Env var that carries the agent token to the launched tool. The token itself never appears in argv. */
export const MCP_TOKEN_ENV = "AIS_BROWSER_AGENT_TOKEN";

/** The endpoint URL for a gateway root URL (any path prefix is kept). */
export const gatewayMcpUrl = (gateway: string): string => `${gateway.replace(/\/+$/, "")}${GATEWAY_MCP_PATH}`;

export interface LaunchHeaderInput {
  /** Claude only: the `--session-id` / `--resume` value of the launch. Others get a session id from the gateway. */
  sessionId?: string | undefined;
  /** Readable session name. Sent percent-encoded, so any text is a valid header value. */
  label?: string | undefined;
  /** Pool name when the launch is a pool launch. */
  pool?: string | undefined;
}

/** The session description a launch sends with every request. The bearer token is added by the caller as an env reference. */
export function launchHeaders(i: LaunchHeaderInput): Record<string, string> {
  const h: Record<string, string> = {};
  if (i.sessionId) h["X-AIS-Session-Id"] = i.sessionId;
  if (i.label) h["X-AIS-Session-Label"] = encodeURIComponent(i.label.slice(0, 80));
  if (i.pool) h["X-AIS-Pool"] = i.pool;
  return h;
}

/** Value of `--session-id <id>` or `--resume <id>` (also `--flag=id`, `-r <id>`) when it is a UUID; the Claude transcript id of the launch. */
export function claudeSessionIdFromArgv(argv: readonly string[]): string | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (flag !== "--session-id" && flag !== "--resume" && flag !== "-r") continue;
    const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
    if (value && uuid.test(value)) found = value.toLowerCase();
  }
  return found;
}
