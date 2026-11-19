import { hasMemberCopy, memberLoginFile, memberStoreRoot } from "../../identities/gateway-members.ts";
import { classifyLogin } from "../../identities/gateway-routed.ts";
import { expandPath } from "../../identities/match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import { adoptLoginIntoGateway, type AdoptResult } from "../../server/login-flows.ts";
import { CliUsageError } from "../errors.ts";
import { TOOL_CONFIGS } from "./resolve-tool.ts";
import type { RouteAllOptions } from "./route-all.ts";

/**
 * `ais identities adopt-login <tool> <identity>`: the owner-started adopt path (the same one the console runs after a
 * sign-in) for a login that is already in the identity's folder. The sign-in is the owner's choice of account, so the folder's
 * login replaces the gateway's member store copy (the old copy is backed up) and the gateway entry goes back into the folder.
 * Refuses only when the folder holds no login. Output may name emails (local terminal); never a token.
 */
export async function runAdoptLogin(rest: string[], opts: RouteAllOptions = {}, out: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const [tool, name] = rest;
  if ((tool !== "claude" && tool !== "codex") || !name) throw new CliUsageError("Usage: ais identities adopt-login <claude|codex> <identity>");
  const cfg = TOOL_CONFIGS[tool];
  const identity = findIdentityByNameOrAlias((await loadIdentitiesFile(opts.registries?.[tool] ?? cfg.identitiesJsonPath)).identities, name);
  if (!identity) throw new CliUsageError(`identity "${name}" not found in ${tool}'s registry`);
  const configDir = expandPath(identity.configDir);
  const folder = await Bun.file(`${configDir}/${memberLoginFile(tool)}`).text().catch(() => undefined);
  if (classifyLogin(tool, folder) !== "login") throw new CliUsageError(`${tool}/${identity.name}: the folder holds no login to adopt (sign in first)`);
  const root = opts.memberRoot ?? memberStoreRoot();
  if (!hasMemberCopy(tool, identity.name, root)) {
    throw new CliUsageError(`${tool}/${identity.name}: the gateway has no member store login for this identity, so there is nothing to replace; run: ais identities route-all-via-gateway`);
  }
  const result: AdoptResult | undefined = await adoptLoginIntoGateway(tool, identity.name, configDir, opts);
  if (!result) {
    out(`${tool}/${identity.name}: the gateway already uses this login`);
    return;
  }
  out(`${tool}/${identity.name}: ${result.outcome === "error" ? "ERROR" : result.outcome === "attention" ? "WARNING" : "ok"}: ${result.message}`);
  if (result.outcome !== "adopted") process.exitCode = 1;
}
