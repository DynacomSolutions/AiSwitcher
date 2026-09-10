import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Identity } from "./types.ts";
import { expandPath } from "./match.ts";
import { aisConfigDir } from "../shared/ais-home.ts";

/**
 * Identity -> AWS profile resolution for identities that run on AWS Bedrock
 * (e.g. a codex identity whose config.toml sets
 * `model_provider = "amazon-bedrock"`). An AIS identity is tool-agnostic and
 * carries NO AWS credentials of its own — Bedrock inference auth (a Bedrock
 * API key inside the identity's auth.json) is entirely separate from the AWS
 * account auth (SSO via ~/.aws/config) that the AWS Budgets and Cost Explorer
 * reporting APIs need — so reporting needs its own explicit mapping from
 * identity to AWS CLI profile. Never a credential: only profile NAMES travel
 * through here, and the AWS SDK's own credential chain (including the SSO
 * token cache) does the rest.
 *
 * Resolution order (first hit wins):
 *   1. `AWS_PROFILE` in the identity's own registry `env` (Identity.env) —
 *      the explicit, portable, in-registry answer.
 *   2. The machine-local mapping file `~/.ais/config/aws-profiles.json`
 *      (same shape and spirit as chrome-mcp.json: machine-specific account
 *      wiring never belongs in a public repository). Absent file = no
 *      mapping = this machine isn't set up for AWS reporting, which the
 *      callers treat as "nothing to report", not an error.
 * The chosen profile is then enriched with its `region` and
 * `sso_account_id` from the AWS CLI's own config (~/.aws/config), the single
 * source of truth for account ids — nothing here duplicates them.
 */

/** codex marks a Bedrock-backed identity in its config.toml
 * (`model_provider = "amazon-bedrock"`, confirmed on this machine's two live
 * Bedrock identities). Read sync — the limits/usage pipelines call this while
 * seeding pending placeholder rows, which are synchronous by design. Tolerant
 * of a missing/unreadable file: not a Bedrock identity, never a crash. Also
 * honoured: `CLAUDE_CODE_USE_BEDROCK` in the identity's registry env, so a
 * future claude-via-Bedrock identity is detectable the same way without
 * touching this module again. */
export function isBedrockIdentity(identity: Identity, deps: AwsProfileDeps = {}): boolean {
  if (identity.env?.CLAUDE_CODE_USE_BEDROCK) return true;
  const readText = deps.readText ?? defaultReadText;
  try {
    return /^model_provider\s*=\s*["']?amazon-bedrock["']?\s*$/m.test(
      readText(join(expandPath(identity.configDir), "config.toml")),
    );
  } catch {
    return false;
  }
}

export interface AwsProfileTarget {
  profile: string;
  /** From the profile's own ~/.aws/config section. */
  region?: string;
  /** The profile's `sso_account_id` — the AWS account whose Budgets/Cost
   * Explorer data belongs to this identity. */
  accountId?: string;
}

export interface AwsProfileDeps {
  readText?: (path: string) => string;
  home?: string;
  awsProfilesPath?: string;
  awsConfigPath?: string;
}

interface AwsProfilesConfigFile {
  version: 1;
  identities: Record<string, { profile: string }>;
}

export function awsProfilesConfigPath(home: string = homedir()): string {
  return process.env.AIS_AWS_PROFILES_CONFIG ?? join(aisConfigDir(home), "aws-profiles.json");
}

/** The AWS CLI's own profile config (honours the same override the CLI
 * does). This file's per-profile sections carry `region` and
 * `sso_account_id`; the SSO session definition lives under separate
 * `[sso-session ...]` sections this parser deliberately ignores. */
export function awsUserConfigPath(): string {
  return process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
}

/** Minimal INI read of ~/.aws/config: `[profile name]` (or `[name]` for
 * default-style sections) -> { region, accountId }. Indented keys belong to
 * nested tables (e.g. `s3 =` sub-settings) and are ignored; `[sso-session
 * ...]` sections are ignored. Unparsable content is skipped per-section —
 * one malformed profile must not hide every other profile's region. Pure;
 * exported for tests. */
export function parseAwsConfig(text: string): Record<string, { region?: string; accountId?: string }> {
  const result: Record<string, { region?: string; accountId?: string }> = {};
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const section = line.trim().match(/^\[(?:profile\s+)?([^\]]+)\]$/);
    if (section) {
      const name = section[1]!.trim();
      current = name.startsWith("sso-session") ? undefined : name;
      continue;
    }
    if (!current || /^\s/.test(line)) continue;
    const kv = line.match(/^(region|sso_account_id)\s*=\s*(.*?)\s*$/);
    if (!kv) continue;
    const entry = (result[current] ??= {});
    if (kv[1] === "region") entry.region = kv[2];
    else entry.accountId = kv[2];
  }
  return result;
}

function defaultReadText(path: string): string {
  return readFileSync(path, "utf8");
}

function readOptionalText(readText: (path: string) => string, path: string): string | undefined {
  try {
    return readText(path);
  } catch {
    return undefined;
  }
}

/** Loads the machine-local identity -> profile mapping. An absent file is
 * the normal "this machine has no AWS reporting set up" case and returns {};
 * a MALFORMED file is a real configuration error and throws (callers render
 * it as an honest unavailable row, never a crash). Follows chrome-mcp.json's
 * versioned-shape precedent. */
export function loadAwsProfileMapping(path: string = awsProfilesConfigPath(), deps: AwsProfileDeps = {}): Record<string, string> {
  const text = readOptionalText(deps.readText ?? defaultReadText, path);
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid AWS profiles config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = parsed as Partial<AwsProfilesConfigFile>;
  if (file.version !== 1 || !file.identities || typeof file.identities !== "object" || Array.isArray(file.identities)) {
    throw new Error(`Invalid AWS profiles config at ${path}: expected version 1 with an identities object`);
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(file.identities)) {
    if (entry && typeof entry === "object" && typeof (entry as { profile?: unknown }).profile === "string") {
      result[name] = (entry as { profile: string }).profile;
    }
  }
  return result;
}

/** Resolves which AWS CLI profile (if any) an identity reports against —
 * see the module doc for the resolution order. Returns undefined when the
 * identity has no mapping (NOT an error: most identities and most machines
 * have none). */
export function resolveAwsProfileForIdentity(identity: Identity, deps: AwsProfileDeps = {}): AwsProfileTarget | undefined {
  const readText = deps.readText ?? defaultReadText;
  let profile = identity.env?.AWS_PROFILE;
  if (!profile) {
    // A malformed mapping file THROWS (honest configuration error, rendered
    // by the callers as an unavailable row) — silently declining here would
    // hide it behind an indistinguishable "no mapping".
    profile = loadAwsProfileMapping(deps.awsProfilesPath ?? awsProfilesConfigPath(deps.home), { readText })[identity.name];
  }
  if (!profile) return undefined;

  const configText = readOptionalText(readText, deps.awsConfigPath ?? awsUserConfigPath());
  const section = configText !== undefined ? parseAwsConfig(configText)[profile] : undefined;
  return {
    profile,
    ...(section?.region ? { region: section.region } : {}),
    ...(section?.accountId ? { accountId: section.accountId } : {}),
  };
}
