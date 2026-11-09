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

const hostOnly = (value: string | null): string => {
  const first = (value ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.replace(/:\d+$/, "").replace(/\.$/, "");
};

/** Metrics, health, readiness and browser pairing are for the cluster, never for a public host. */
export function isOperationalPath(path: string): boolean {
  return path === "/metrics" || path === "/healthz" || path === "/readyz" || path === "/browser/pair" || path.startsWith("/browser/pair/");
}

/** True when the request arrived under one of the public host names (Host, or X-Forwarded-Host set by a proxy). */
export function viaPublicHost(headers: Headers, url: string, publicHosts: string[]): boolean {
  const names = [hostOnly(headers.get("host")), hostOnly(headers.get("x-forwarded-host")), (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })()];
  return names.some((n) => n !== "" && publicHosts.includes(n));
}
