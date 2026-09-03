import type { Context, Next } from "hono";
import { HttpError } from "./types.ts";

/** Request hardening for a server that can read/write real identity state:
 * 1. Host header must be loopback-shaped OR an explicitly allowed vhost
 *    (DNS-rebinding guard: a hostile web page cannot make the browser
 *    resolve its own domain to 127.0.0.1 and keep a valid-looking Host;
 *    an allowlisted vhost is an opt-in deployment choice, not a default).
 * 2. Every /api request must present EITHER the per-boot bearer token OR
 *    originate from a loopback peer address OR arrive on an allowed vhost
 *    (that last arm is what lets a reverse-proxied deployment — where every
 *    peer address is the proxy — serve the WebUI at all).
 * 3. Mutating methods additionally require X-AIS-Console: 1. Browsers cannot
 *    attach custom headers to cross-origin simple requests without a CORS
 *    preflight, and this app never answers preflights, so this closes CSRF
 *    regardless of which arm authenticated the request. */

export function allowedHost(
  hostHeader: string | undefined,
  port: number,
  extraHosts?: ReadonlySet<string>,
): boolean {
  if (!hostHeader) return false;
  const bare = hostHeader.toLowerCase().split(":")[0];
  if (bare !== "127.0.0.1" && bare !== "localhost" && bare !== "::1" && !extraHosts?.has(bare)) return false;
  // If a port is present it must be ours; a bare host with no port is fine.
  if (hostHeader.includes(":") && !hostHeader.endsWith(`:${port}`)) {
    // IPv6 literal [::1]:port form.
    if (!hostHeader.startsWith("[") || !hostHeader.endsWith(`:${port}]`)) return false;
  }
  return true;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface GuardDeps {
  token: string;
  port: number;
  /** Extra vhosts (lowercase, no port) treated as trusted as the loopback
   * peers are. Empty by default; serve.ts populates it from
   * AIS_WEB_ALLOWED_HOSTS so reverse-proxied deployments can serve the
   * WebUI on their real hostname. */
  allowedHosts?: ReadonlySet<string>;
  /** Optional fixed peer address (tests); serve.ts otherwise stamps the Bun
   * peer IP onto the raw request per call. */
  peerAddress?: string;
}

export async function consoleGuard(deps: GuardDeps, c: Context, next: Next): Promise<Response | void> {
  const hostOk = allowedHost(c.req.header("Host"), deps.port, deps.allowedHosts);
  const vhostOk = hostOk && vhostAllowed(c.req.header("Host"), deps.allowedHosts);
  if (!hostOk) {
    throw new HttpError(403, "rejected: Host header is not loopback");
  }
  const auth = c.req.header("Authorization");
  const bearerOk = auth === `Bearer ${deps.token}`;
  // serve.ts stamps the Bun peer address onto the raw request before handing
  // it to Hono. When bound to 127.0.0.1 this always matches, which is the
  // intended default trust model; the token matters only for non-loopback
  // binds (AIS_WEB_HOST) and for tests.
  const remoteAddress = deps.peerAddress ?? (c.req.raw as unknown as { __remoteAddress?: string }).__remoteAddress;
  const localOk = bearerOk || isLoopbackAddress(typeof remoteAddress === "string" ? remoteAddress : undefined) || vhostOk;
  if (!localOk) {
    throw new HttpError(401, "rejected: missing valid bearer token and peer is not loopback");
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("X-AIS-Console") !== "1") {
    throw new HttpError(403, "rejected: mutating requests require the X-AIS-Console header");
  }
  await next();
}

function vhostAllowed(hostHeader: string | undefined, extraHosts?: ReadonlySet<string>): boolean {
  if (!extraHosts || extraHosts.size === 0 || !hostHeader) return false;
  return extraHosts.has(hostHeader.toLowerCase().split(":")[0]);
}
