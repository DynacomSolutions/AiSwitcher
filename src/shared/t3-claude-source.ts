import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath } from "../identities/match.ts";
import { CLAUDE_CONFIG } from "../identities/tool-configs.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import type { IdentitiesFile } from "../identities/types.ts";
import { identityForConfigDir } from "./browser-wiring.ts";

export interface T3ClaudeSource {
  name: string;
  dir: string;
  /** a restricted identity: no third-party sending plugins or hooks. */
  noThirdParty: boolean;
}

/**
 * Identities that must never get a plugin, hook or env key that sends session content to a third party. The names are host
 * config, not code: env `AIS_NO_THIRD_PARTY_IDENTITIES` (comma list) and the file `~/.ais/config/no-third-party-identities`
 * (one name or alias per line, `#` starts a comment).
 */
export function noThirdPartyNames(opts: { home?: string; env?: Record<string, string | undefined> } = {}): string[] {
  const env = opts.env ?? process.env;
  let fileText = "";
  try {
    fileText = readFileSync(join(opts.home ?? homedir(), ".ais", "config", "no-third-party-identities"), "utf8");
  } catch (err) {
    // Fail closed: only a missing file means "no list". Any other error stops the command.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read the no-third-party identity list: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fromFile = fileText.split("\n").map((l) => l.replace(/#.*/, "").trim());
  return [...(env.AIS_NO_THIRD_PARTY_IDENTITIES ?? "").split(","), ...fromFile].map((n) => n.trim().toLowerCase()).filter(Boolean);
}

export const isNoThirdParty = (i: { name: string; aliases?: string[] }, names: string[]): boolean => {
  const list = names.map((n) => n.toLowerCase());
  return list.includes(i.name.toLowerCase()) || (i.aliases ?? []).some((a) => list.includes(a.toLowerCase()));
};

/** The source identity of a T3 Claude home folder (the pool home maps to the swap pool), or undefined. */
export function t3ClaudeSource(file: IdentitiesFile, folder: string, t3Home: string = t3Paths().t3Home, restricted: string[] = noThirdPartyNames()): T3ClaudeSource | undefined {
  const identity = identityForConfigDir(file, folder, undefined, join(t3Home, "gateway"));
  return identity ? { name: identity.name, dir: expandPath(identity.configDir), noThirdParty: isNoThirdParty(identity, restricted) } : undefined;
}

export async function loadClaudeIdentities(path: string = CLAUDE_CONFIG.identitiesJsonPath): Promise<IdentitiesFile> {
  return loadIdentitiesFile(path);
}
