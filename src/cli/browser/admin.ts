import { access, chmod, constants, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../../identities/tool-configs.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { connect, table, type GatewayCliDeps } from "../gateway/apps.ts";
import { appendSecretsFile, removeSecretsKey } from "../gateway/secrets-file.ts";


export const BROWSER_TOKEN_FILE = "ais-browser-token";

export interface BrowserCliDeps extends GatewayCliDeps {
  /** Config dirs (and canonical name) of an identity across the claude and codex tools. Defaults to the local registries. */
  identityDirs?(identity: string): Promise<{ name: string; dirs: string[] }>;
}

async function localIdentityDirs(identity: string): Promise<{ name: string; dirs: string[] }> {
  const dirs: string[] = [];
  let name: string | undefined;
  for (const cfg of [CLAUDE_CONFIG, CODEX_CONFIG]) {
    const found = findIdentityByNameOrAlias((await loadIdentitiesFile(cfg.identitiesJsonPath)).identities, identity);
    if (!found) continue;
    name ??= found.name;
    dirs.push(found.configDir);
  }
  return { name: name ?? identity, dirs };
}

/** AIS_BROWSER_AGENT_<IDENTITY_UPPER_SNAKE>_TOKEN */
export const agentTokenKey = (identity: string): string => `AIS_BROWSER_AGENT_${identity.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;

async function writeTokenFile(dir: string, token: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, BROWSER_TOKEN_FILE);
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(`${token}\n`);
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "-");

function targetText(t: unknown): string {
  if (typeof t !== "object" || t === null) return "-";
  const r = t as Record<string, unknown>;
  return r.kind === "pool" ? `pool:${str(r.pool)}` : `identity:${str(r.identity)}`;
}

export async function runBrowserAdmin(sub: string | undefined, rest: string[], flags: ParsedArgs["flags"], deps: BrowserCliDeps): Promise<void> {
  switch (sub) {
    case "approve": {
      const code = rest[0]?.trim().toUpperCase();
      if (!code) throw new CliUsageError("Usage: ais browser approve <code> (--identity=<id> | --pool=<pool>) [--name=<n>]");
      const identity = stringFlag(flags, "identity");
      const pool = stringFlag(flags, "pool");
      if (identity !== undefined && (pool !== undefined || flags.pool !== undefined)) throw new CliUsageError("Use either --identity=<id> or --pool=<pool>, not both");
      if (identity === undefined && pool === undefined) throw new CliUsageError("Choose a target: --identity=<id> or --pool=<pool>");
      const target = identity !== undefined ? { kind: "identity", identity } : { kind: "pool", pool };
      const name = stringFlag(flags, "name");
      const { admin } = await connect(deps);
      const { json } = await admin.call("POST", `/browser/pairings/${encodeURIComponent(code)}/approve`, { target, ...(name !== undefined ? { name } : {}) });
      const b = (json.binding ?? {}) as Record<string, unknown>;
      deps.out(`approved: binding ${str(b.name)} -> ${targetText(b.target)}`);
      return;
    }
    case "list": {
      const { admin } = await connect(deps);
      const { json } = await admin.call("GET", "/browser/bindings");
      const bindings = Array.isArray(json.bindings) ? (json.bindings as Record<string, unknown>[]) : [];
      if (boolFlag(flags, "json")) return deps.out(JSON.stringify(json, null, 2));
      if (bindings.length === 0) return deps.out("no browser bindings");
      deps.out(table(["NAME", "TARGET", "PROFILE", "STATE", "LAST SEEN"], bindings.map((b) => [str(b.name), targetText(b.target), str(b.profileLabel), str(b.state), str(b.lastSeenAt) || "never"])));
      return;
    }
    case "revoke": {
      const name = rest[0];
      if (!name) throw new CliUsageError("Usage: ais browser revoke <name>");
      const { admin } = await connect(deps);
      await admin.call("DELETE", `/browser/bindings/${encodeURIComponent(name)}`);
      deps.out(`revoked: binding ${name}`);
      return;
    }
    case "agent-token": {
      const given = rest[0];
      if (!given) throw new CliUsageError("Usage: ais browser agent-token <identity> [--revoke]");
      const { admin, secretsPath } = await connect(deps);
      const local = await (deps.identityDirs ?? localIdentityDirs)(given);
      if (boolFlag(flags, "revoke")) {
        const { json } = await admin.call("DELETE", `/browser/agents/${encodeURIComponent(given)}/tokens`);
        const identity = typeof json.identity === "string" ? json.identity : local.name;
        for (const dir of local.dirs) await rm(join(dir, BROWSER_TOKEN_FILE), { force: true });
        await removeSecretsKey(agentTokenKey(identity), secretsPath);
        deps.out(`revoked: agent token for ${identity}`);
        return;
      }
      if (local.dirs.length === 0) throw new CliUsageError(`identity "${given}" not found in the claude or codex registry`);
      // Fail before the POST rotates the server token if any target is unwritable.
      for (const dir of local.dirs) {
        await mkdir(dir, { recursive: true });
        await access(dir, constants.W_OK);
      }
      const { json } = await admin.call("POST", `/browser/agents/${encodeURIComponent(given)}/tokens`);
      const token = json.token;
      if (typeof token !== "string" || !token) throw new Error("gateway admin returned no token");
      const identity = typeof json.identity === "string" ? json.identity : local.name;
      try {
        for (const dir of local.dirs) await writeTokenFile(dir, token);
        await appendSecretsFile(agentTokenKey(identity), token, secretsPath);
      } catch (e) {
        deps.out(`token write failed after the server token was rotated; re-run ais browser agent-token ${given} to mint again`);
        throw e;
      }
      deps.out(`agent token for ${identity} written to ${local.dirs.map((d) => join(d, BROWSER_TOKEN_FILE)).join(", ")} and ~/.secrets (${agentTokenKey(identity)})`);
      deps.out("Mint once per identity, not per host: ais sync distributes the token file to your other hosts.");
      return;
    }
    default:
      throw new CliUsageError("Usage: ais browser approve|list|revoke|agent-token ...  (ais browser --help)");
  }
}
