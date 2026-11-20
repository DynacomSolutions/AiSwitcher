import { resolve } from "node:path";
import { expandPath } from "../../identities/match.ts";
import { checkT3Proxy, installT3Proxy, removeT3Proxy, type T3Options } from "../../identities/t3-anthropic-proxy.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { DEFAULT_CONNECT_CA } from "./claude-proxy.ts";
import { readSecretsKey } from "./secrets-file.ts";

export function deriveT3ConnectProxyUrl(gatewayBase: string, port = 47132): string {
  let url: URL;
  try {
    url = new URL(gatewayBase);
  } catch {
    throw new CliUsageError("AIS_GATEWAY_PROXY_URL must be an HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliUsageError("AIS_GATEWAY_PROXY_URL must be an HTTP(S) URL");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliUsageError("T3 CONNECT proxy port must be between 1 and 65535");
  url.protocol = "http:";
  url.username = "";
  url.password = "";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.port = String(port);
  return url.toString().replace(/\/$/, "");
}

/**
 * `ais gateway t3-proxy [--proxy=<url>] [--ca=<path>] [--check] [--remove]`: routes api.anthropic.com, the OpenCode usage
 * call (opencode.ai /zen/go/v1/usage) and the Grok billing call (cli-chat-proxy.grok.com /v1/billing) of the T3 Code
 * server (only) through the gateway CONNECT proxy, so T3's account usage and reset credits come from the gateway.
 * Every other host and path is untouched.
 * Never restarts T3: it must be restarted to apply.
 */
export async function runT3ProxyCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: T3Options = {}): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-proxy [--proxy=<url>] [--ca=<path>] [--check] [--remove]");
  const check = boolFlag(flags, "check");
  const remove = boolFlag(flags, "remove");
  if (check && remove) throw new CliUsageError("--check and --remove cannot be combined");
  if (check) {
    const problems = await checkT3Proxy(opts);
    if (problems.length === 0) {
      deps.out("t3-proxy: installed and current");
      return;
    }
    for (const p of problems) deps.out(`t3-proxy: ${p}`);
    throw new Error(`${problems.length} problem(s) with the T3 anthropic proxy`);
  }
  if (remove) {
    const r = await removeT3Proxy(opts);
    deps.out(r.changed ? `t3-proxy: removed (preload ${r.preload}${r.backup ? `; backup ${r.backup}` : ""})` : "t3-proxy: nothing to remove");
    deps.out("Restart T3 Code to apply (not restarted by this command).");
    return;
  }
  const configuredGateway = (await readSecretsKey("AIS_GATEWAY_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_PROXY_URL;
  const port = Number(stringFlag(flags, "port") ?? process.env.AIS_GATEWAY_CONNECT_PROXY_PORT ?? 47132);
  const configuredProxy = (await readSecretsKey("AIS_GATEWAY_CONNECT_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_CONNECT_PROXY_URL;
  const proxyHost = configuredProxy ? URL.parse(configuredProxy)?.hostname : undefined;
  const legacyLoopback = proxyHost === "localhost" || proxyHost === "[::1]" || proxyHost?.startsWith("127.");
  const proxyUrl = stringFlag(flags, "proxy") ?? (legacyLoopback ? undefined : configuredProxy) ??
    (configuredGateway ? deriveT3ConnectProxyUrl(configuredGateway, port) : undefined);
  if (!proxyUrl) throw new CliUsageError("Proxy URL unknown: pass --proxy=http://<host>:<port> or set AIS_GATEWAY_CONNECT_PROXY_URL in ~/.secrets");
  const caPath = resolve(expandPath(stringFlag(flags, "ca") ?? DEFAULT_CONNECT_CA()));
  const r = await installT3Proxy({ ...opts, proxyUrl, caPath });
  deps.out(`t3-proxy: ${r.changed ? "installed" : "already current"} (preload ${r.preload}, ${r.serviceEnv}${r.backup ? `; backup ${r.backup}` : ""})`);
  deps.out("Restart T3 Code to apply (not restarted by this command).");
}
