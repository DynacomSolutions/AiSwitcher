import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { resolveAwsProfileForIdentity, type AwsProfileDeps } from "../identities/aws-profile.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";

/**
 * Enumerates every AWS account the guard enforces on, by walking ALL tool
 * registries and resolving each identity through the same machine-local
 * mapping the reporting fetchers use (identities/aws-profile.ts: registry
 * env AWS_PROFILE first, then ~/.ais/config/aws-profiles.json, enriched
 * with sso_account_id/region from ~/.aws/config). Identities with no
 * mapping are invisible here — the guard never applies to them. Accounts
 * group every identity that resolves to them: scope is per ACCOUNT, the
 * sum of all its identities (requirement: no per-identity caps).
 *
 * A malformed aws-profiles.json throws inside loadAll's per-registry loop;
 * that is a real configuration error callers surface (the cycle records it
 * in `errors`, the launch gate warns and allows — never block on missing
 * data), never a crash.
 */

export interface GuardIdentity {
  toolName: ToolConfig["toolName"];
  identity: Identity;
}

export interface GuardAccount {
  accountId: string;
  profile: string;
  region?: string;
  identities: GuardIdentity[];
}

export async function resolveGuardAccounts(
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
  awsProfileDeps: AwsProfileDeps = {},
): Promise<{ accounts: GuardAccount[]; errors: string[] }> {
  const accounts = new Map<string, GuardAccount>();
  const errors: string[] = [];
  const loaded = await loadAll(configs);
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      let target;
      try {
        target = resolveAwsProfileForIdentity(identity, awsProfileDeps);
      } catch (err) {
        errors.push(`${cfg.toolName}/${identity.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!target?.accountId) continue;
      const account = accounts.get(target.accountId) ?? {
        accountId: target.accountId,
        profile: target.profile,
        ...(target.region ? { region: target.region } : {}),
        identities: [] as GuardIdentity[],
      };
      account.identities.push({ toolName: cfg.toolName, identity });
      accounts.set(target.accountId, account);
    }
  }
  return { accounts: [...accounts.values()], errors };
}
