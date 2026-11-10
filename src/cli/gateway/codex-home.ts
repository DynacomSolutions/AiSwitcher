import { resolve } from "node:path";
import { codexGatewayHomeProblem, configureCodexGatewayHome, readCodexGatewayHomeApp, registerCodexGatewayHome } from "../../identities/codex-gateway-home.ts";
import { expandPath } from "../../identities/match.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { appTokenKey, readSecretsKey } from "./secrets-file.ts";

/**
 * `ais gateway codex-home <dir>...`: sets up Codex folders that run through the gateway (placeholder ChatGPT login,
 * chatgpt_base_url, requires_openai_auth) and registers them so `app rotate` keeps their auth.json current.
 * `--check` writes nothing and fails when a folder is not fully configured. Never prints a token.
 */
export async function runCodexHomeCommand(dirs: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (dirs.length === 0) throw new CliUsageError("Usage: ais gateway codex-home <codex home dir>... [--check]");
  const folders = dirs.map((d) => resolve(expandPath(d)));
  if (boolFlag(flags, "check")) {
    let bad = 0;
    for (const dir of folders) {
      const problem = await codexGatewayHomeProblem(dir);
      if (problem) bad += 1;
      deps.out(`${dir}: ${problem ?? "ok"}`);
    }
    if (bad > 0) throw new Error(`${bad} folder(s) not configured for gateway usage limits`);
    return;
  }
  let failed = 0;
  for (const dir of folders) {
    try {
      const { app } = await readCodexGatewayHomeApp(dir);
      const key = appTokenKey(app);
      const token = await readSecretsKey(key, deps.secretsPath);
      if (!token) throw new Error(`no ${key} in ~/.secrets`);
      await configureCodexGatewayHome(dir, token);
      await registerCodexGatewayHome({ dir, app }, deps.codexHomesPath);
      deps.out(`${dir}: configured for app ${app} (auth.json 0600, chatgpt_base_url set); registered for rotation`);
    } catch (e) {
      failed += 1;
      deps.out(`${dir}: skipped, ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} folder(s) not configured`);
}
