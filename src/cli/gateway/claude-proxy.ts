import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configureUsageProxy, folderUsageProxyProblem } from "../../identities/claude-usage-proxy.ts";
import { expandPath } from "../../identities/match.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { readSecretsKey } from "./secrets-file.ts";

/** Where `ais gateway serve` publishes the CONNECT proxy's CA for clients (AIS_GATEWAY_CONNECT_CA_PUBLISH in the deployment). */
export const DEFAULT_CONNECT_CA = (): string => join(homedir(), ".ais", "gateway-connect-ca.pem");

/**
 * `ais gateway claude-proxy <dir>...`: turns the gateway usage proxy on for Claude config folders (identities, the swap
 * pool, T3 gateway folders). HTTPS_PROXY is always written with a loopback NO_PROXY (see claude-usage-proxy.ts).
 * `--check` writes nothing and fails when a folder has a proxy that would break its loopback base URL.
 * Each folder should get a real `claude -p` turn afterwards: running sessions pick the settings up at once.
 */
export async function runClaudeProxyCommand(dirs: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (dirs.length === 0) throw new CliUsageError("Usage: ais gateway claude-proxy <claude config dir>... [--proxy=<url>] [--ca=<path>] [--check]");
  const folders = dirs.map((d) => resolve(expandPath(d)));
  if (boolFlag(flags, "check")) {
    let bad = 0;
    for (const dir of folders) {
      const problem = await folderUsageProxyProblem(dir);
      if (problem) bad += 1;
      deps.out(`${dir}: ${problem ?? "ok"}`);
    }
    if (bad > 0) throw new Error(`${bad} folder(s) would send model calls to the proxy`);
    return;
  }
  const proxyUrl = stringFlag(flags, "proxy") ?? (await readSecretsKey("AIS_GATEWAY_CONNECT_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_CONNECT_PROXY_URL;
  if (!proxyUrl) throw new CliUsageError("Proxy URL unknown: pass --proxy=http://<host>:<port> or set AIS_GATEWAY_CONNECT_PROXY_URL in ~/.secrets");
  const caPath = resolve(expandPath(stringFlag(flags, "ca") ?? DEFAULT_CONNECT_CA()));
  for (const dir of folders) {
    const env = await configureUsageProxy(dir, { proxyUrl, caPath });
    deps.out(`${dir}: HTTPS_PROXY set, NO_PROXY=${String(env.NO_PROXY)}; run a real claude -p turn on it now`);
  }
}
