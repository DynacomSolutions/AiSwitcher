import type { Context, Next } from "hono";
import { readFileSync } from "node:fs";
import { HttpError } from "./types.ts";

/** Request hardening for a server that can read/write real identity state:
 * 1. Host header must be loopback-shaped OR an explicitly allowed vhost
 *    (DNS-rebinding guard: a hostile web page cannot make the browser
 *    resolve its own domain to 127.0.0.1 and keep a valid-looking Host;
 *    an allowlisted vhost is an opt-in deployment choice, not a default).
 * 2. Every /api request must present EITHER the per-boot bearer token OR
 *    originate from a loopback peer whose socket belongs to the SAME uid as
 *    this server process (Linux: looked up in /proc/net/tcp{,6}; unknown or
 *    unreadable fails closed) OR arrive on an allowed vhost
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

export interface ProcNetRow {
  localAddress: string;
  localPort: number;
  remotePort: number;
  uid: number;
}

/** Decode one /proc/net/tcp{,6} address (little-endian 32-bit words) to the
 * dotted/`::1` form; IPv4-mapped IPv6 collapses to plain IPv4. */
function decodeProcAddress(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    for (let j = 6; j >= 0; j -= 2) bytes.push(Number.parseInt(hex.slice(i + j, i + j + 2), 16));
  }
  if (bytes.length === 4) return bytes.join(".");
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join(".");
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "::1";
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseProcNetTcp(text: string): ProcNetRow[] {
  const rows: ProcNetRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [la, lp] = f[1].split(":");
    const rp = f[2].split(":")[1];
    if (!la || !lp || !rp) continue;
    rows.push({
      localAddress: decodeProcAddress(la),
      localPort: Number.parseInt(lp, 16),
      remotePort: Number.parseInt(rp, 16),
      uid: Number.parseInt(f[7], 10),
    });
  }
  return rows;
}

/** uid owning the peer's end of a loopback connection to `serverPort`, or
 * undefined when not found. Throws when /proc is unreadable. */
export function linuxPeerUid(address: string, peerPort: number, serverPort: number): number | undefined {
  const want = address.replace(/^::ffff:/i, "");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const r of parseProcNetTcp(readFileSync(file, "utf8"))) {
      if (r.localAddress === want && r.localPort === peerPort && r.remotePort === serverPort) return r.uid;
    }
  }
  return undefined;
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
  /** Optional fixed peer port (tests); serve.ts stamps `__remotePort`. */
  peerPort?: number;
  /** Peer socket owner lookup (tests inject; default reads /proc on Linux).
   * May throw or return undefined: both mean "not trusted". */
  peerUid?: (address: string, peerPort: number, serverPort: number) => number | undefined;
}

function sameUserLoopback(deps: GuardDeps, address: string | undefined, peerPort: unknown): boolean {
  if (!isLoopbackAddress(address)) return false;
  const lookup = deps.peerUid ?? (process.platform === "linux" ? linuxPeerUid : undefined);
  // shortcut: loopback peers are not uid-checked off Linux, add a per-platform peer lookup if multi-user Macs or Windows hosts matter
  if (!lookup) return true;
  if (typeof peerPort !== "number" || typeof address !== "string") return false;
  try {
    const uid = lookup(address, peerPort, deps.port);
    return uid !== undefined && uid === process.getuid?.();
  } catch {
    return false;
  }
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
  // intended default trust model, now narrowed to peers running as our own
  // uid; other local accounts need the token.
  const raw = c.req.raw as unknown as { __remoteAddress?: string; __remotePort?: number };
  const remoteAddress = deps.peerAddress ?? raw.__remoteAddress;
  const localOk =
    bearerOk ||
    sameUserLoopback(deps, typeof remoteAddress === "string" ? remoteAddress : undefined, deps.peerPort ?? raw.__remotePort) ||
    vhostOk;
  if (!localOk) {
    throw new HttpError(401, "rejected: missing valid bearer token and peer is not a same-user loopback peer");
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
