import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GATEWAY_CLAUDE_APP } from "../../identities/claude-gateway-entry.ts";
import { configureDirectGateway, folderUsageProxyProblem } from "../../identities/claude-usage-proxy.ts";
import { expandPath } from "../../identities/match.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { readSecretsKey } from "./secrets-file.ts";

/** Where `ais gateway serve` publishes the CONNECT proxy's CA for clients (AIS_GATEWAY_CONNECT_CA_PUBLISH in the deployment). */
export const DEFAULT_CONNECT_CA = (): string => join(homedir(), ".ais", "gateway-connect-ca.pem");

/**
 * `ais gateway claude-proxy <dir>...`: points Claude config folders at the direct AIS gateway app.
 * Legacy generic proxy variables are removed. `--check` reports folders that still contain them.
 * Each folder should get a real `claude -p` turn afterwards: running sessions pick the settings up at once.
 */
export async function runClaudeProxyCommand(dirs: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (dirs.length === 0) throw new CliUsageError("Usage: ais gateway claude-proxy <claude config dir>... [--url=<gateway-app-url>] [--check]");
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
  const explicitUrl = stringFlag(flags, "url") ?? stringFlag(flags, "gateway");
  const root = (await readSecretsKey("AIS_GATEWAY_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_PROXY_URL;
  const gatewayUrl = explicitUrl ?? (root ? `${root.replace(/\/+$/, "")}/${GATEWAY_CLAUDE_APP}` : undefined);
  if (!gatewayUrl) throw new CliUsageError("Gateway URL unknown: pass --url=https://<host>/<app> or set AIS_GATEWAY_PROXY_URL in ~/.secrets");
  for (const dir of folders) {
    await configureDirectGateway(dir, gatewayUrl);
    deps.out(`${dir}: AIS API URL configured and generic proxy settings removed`);
  }
}
