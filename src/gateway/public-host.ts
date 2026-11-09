/**
 * Host names the gateway is published under on the internet (the tunnel). Operational endpoints are not served on them.
 * No name is written into the source (the identifier scan forbids hardcoded domains): the deployment sets AIS_GATEWAY_PUBLIC_HOSTS.
 */
export const DEFAULT_PUBLIC_HOSTS: string[] = [];

/** AIS_GATEWAY_PUBLIC_HOSTS: comma-separated host names; unset or empty means none are public. */
export function publicHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const list = (env.AIS_GATEWAY_PUBLIC_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_PUBLIC_HOSTS;
}

const hostOnly = (value: string): string => value.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** Every comma-separated value of a header, as bare host names. */
const hostsIn = (value: string | null): string[] => (value ?? "").split(",").map(hostOnly).filter(Boolean);

/** `host=` parameters of a Forwarded header (RFC 7239). */
const forwardedHosts = (value: string | null): string[] => [...(value ?? "").matchAll(/host="?([^;,"\s]+)/gi)].map((m) => hostOnly(m[1] ?? "")).filter(Boolean);

/**
 * The path as the router will see it: repeated slashes collapsed, percent-encoding decoded (repeatedly), lower-cased, trailing slash
 * dropped. An undecodable path comes back as undefined (it cannot be shown to be harmless).
 */
export function normalisePath(path: string): string | undefined {
  let p = path;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return undefined;
    }
    if (next === p) break;
    p = next;
  }
  p = p.replace(/\/{2,}/g, "/").toLowerCase();
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Metrics, health, readiness and browser pairing are for the cluster, never for a public host. Spelling tricks do not hide them. */
export function isOperationalPath(path: string): boolean {
  const p = normalisePath(path);
  if (p === undefined) return true;
  return p === "/metrics" || p === "/healthz" || p === "/readyz" || p === "/browser/pair" || p.startsWith("/browser/pair/");
}

/** True when the request arrived under one of the public host names (Host, any X-Forwarded-Host value, or a Forwarded host=). */
export function viaPublicHost(headers: Headers, url: string, publicHosts: string[]): boolean {
  let fromUrl = "";
  try {
    fromUrl = new URL(url).hostname.toLowerCase();
  } catch {
    // no usable URL host
  }
  const names = [...hostsIn(headers.get("host")), ...hostsIn(headers.get("x-forwarded-host")), ...forwardedHosts(headers.get("forwarded")), fromUrl];
  return names.some((n) => n !== "" && publicHosts.includes(n));
}
