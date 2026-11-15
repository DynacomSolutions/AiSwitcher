import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/**
 * Loopback TCP relay for the gateway CONNECT proxy, run inside `ais gateway local`.
 *
 * Claude Code (HTTPS_PROXY) and the T3 preload (AIS_T3_ANTHROPIC_PROXY) take a single proxy URL. When that URL is a
 * cluster address that only this host's own kube-proxy can route (a ClusterIP), every session on the host loses its
 * proxy when the host's k3s stops, even though gateway replicas still run on the other nodes. This relay listens on
 * 127.0.0.1 and pipes each connection, unchanged, to the first upstream that accepts it. The CONNECT exchange and the
 * TLS inside it pass through as bytes, so any gateway replica serves it.
 *
 * Upstreams are tried in the configured order. A host name expands to all of its addresses, this host's own
 * addresses first (its local replica is the shortest path). An upstream that fails to connect is skipped for `deadMs`,
 * so a dead node costs one connect timeout, not one per connection. When every upstream is marked dead, all are tried.
 */

export const CONNECT_RELAY_DEFAULT_PORT = 47132;
export const CONNECT_RELAY_TIMEOUT_MS = 1_500;
export const CONNECT_RELAY_DEAD_MS = 30_000;
export const CONNECT_RELAY_RESOLVE_MS = 60_000;

export interface Upstream {
  host: string;
  port: number;
}

/** Parses "host:port,host:port" ([v6]:port allowed). Throws on an entry without a valid port. */
export function parseUpstreams(text: string): Upstream[] {
  const out: Upstream[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(entry);
    const port = m ? Number(m[3]) : NaN;
    if (!m || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`connect relay upstream "${entry}" is not host:port`);
    out.push({ host: (m[1] ?? m[2]) as string, port });
  }
  return out;
}

const isLoopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);

export interface ConnectRelayOptions {
  /** 127.0.0.1 port to listen on (0 = ephemeral). */
  port: number;
  upstreams: Upstream[];
  connectTimeoutMs?: number;
  deadMs?: number;
  resolveMs?: number;
  /** All addresses of a host name (tests inject this). */
  lookup?: (host: string) => Promise<string[]>;
  /** Addresses of this host, tried first when a name resolves to one of them. */
  ownAddresses?: () => string[];
  now?: () => number;
  log?: (line: string) => void;
}

export interface ConnectRelay {
  port: number;
  /** Stops accepting; open tunnels get up to `graceMs` (default 5 s) to end. Long keep-alive tunnels would otherwise hold a restart. */
  drain(graceMs?: number): Promise<void>;
  stop(): void;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((a) => a.address);
const defaultOwn = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .map((i) => i?.address)
    .filter((a): a is string => typeof a === "string");

export async function startConnectRelay(opts: ConnectRelayOptions): Promise<ConnectRelay> {
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_RELAY_TIMEOUT_MS;
  const deadMs = opts.deadMs ?? CONNECT_RELAY_DEAD_MS;
  const resolveMs = opts.resolveMs ?? CONNECT_RELAY_RESOLVE_MS;
  const lookup = opts.lookup ?? defaultLookup;
  const ownAddresses = opts.ownAddresses ?? defaultOwn;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.info(line));
  const upstreams = opts.upstreams.filter((u) => {
    if (opts.port !== 0 && isLoopback(u.host) && u.port === opts.port) {
      log(`connect relay: warning: upstream ${u.host}:${u.port} skipped (it would loop back into this relay)`);
      return false;
    }
    return true;
  });
  if (upstreams.length === 0) throw new Error("connect relay: no usable upstream");

  /** Last good resolution per host name; kept when a later lookup fails (DNS may be the thing that is down). */
  const resolved = new Map<string, { at: number; addrs: string[] }>();
  const deadUntil = new Map<string, number>();
  let lastVia = "";

  async function addressesOf(host: string): Promise<string[]> {
    if (net.isIP(host)) return [host];
    const hit = resolved.get(host);
    if (hit && now() - hit.at < resolveMs) return hit.addrs;
    try {
      const own = new Set(ownAddresses());
      const addrs = [...new Set(await lookup(host))].sort((a, b) => Number(own.has(b)) - Number(own.has(a)));
      resolved.set(host, { at: now(), addrs });
      return addrs;
    } catch (err) {
      if (hit) return hit.addrs;
      log(`connect relay: cannot resolve ${host} (${(err as { code?: string }).code ?? (err as Error).message})`);
      return [];
    }
  }

  async function candidates(): Promise<string[]> {
    const all: string[] = [];
    for (const u of upstreams) for (const a of await addressesOf(u.host)) all.push(net.isIPv6(a) ? `[${a}]:${u.port}` : `${a}:${u.port}`);
    const unique = [...new Set(all)];
    const t = now();
    const live = unique.filter((k) => (deadUntil.get(k) ?? 0) <= t);
    return [...live, ...unique.filter((k) => !live.includes(k))];
  }

  function dial(key: string): Promise<net.Socket> {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(key) as RegExpExecArray;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: m[1] as string, port: Number(m[2]) });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      });
    });
  }

  async function open(client: net.Socket): Promise<void> {
    client.pause();
    let clientGone = false;
    client.once("close", () => (clientGone = true));
    client.on("error", () => client.destroy());
    for (const key of await candidates()) {
      if (clientGone) return;
      let up: net.Socket;
      try {
        up = await dial(key);
      } catch (err) {
        if ((deadUntil.get(key) ?? 0) <= now()) log(`connect relay: ${key} unreachable (${(err as { code?: string }).code ?? (err as Error).message}); trying the next upstream`);
        deadUntil.set(key, now() + deadMs);
        continue;
      }
      deadUntil.delete(key);
      if (clientGone) {
        up.destroy();
        return;
      }
      if (key !== lastVia) {
        log(`connect relay: via ${key}`);
        lastVia = key;
      }
      up.on("error", () => client.destroy());
      up.on("close", () => client.destroy());
      client.on("close", () => up.destroy());
      client.pipe(up);
      up.pipe(client);
      return;
    }
    log("connect relay: no upstream reachable; connection closed");
    client.destroy();
  }

  const server = net.createServer({ pauseOnConnect: true }, (client) => void open(client).catch(() => client.destroy()));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Two `ais gateway local` slots share the port during a handover, as the HTTP listeners do.
    server.listen({ host: "127.0.0.1", port: opts.port, reusePort: true } as net.ListenOptions, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    drain: (graceMs = 5_000) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
    stop: () => void server.close(),
  };
}
