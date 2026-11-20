import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandPath } from "../identities/match.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { isRetired } from "../identities/retired.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";

const normaliseDir = (dir: string): string => {
  const r = resolve(expandPath(dir));
  return r.length > 1 ? r.replace(/\/+$/, "") : r;
};

/** Transcript folders a launcher's own config folder may link into an identity's folder (Claude, Codex). */
const TRANSCRIPT_LINKS = ["projects", "sessions"];

const realOrNormal = (dir: string, real: (p: string) => string): string => {
  try {
    return normaliseDir(real(expandPath(dir)));
  } catch {
    return normaliseDir(dir);
  }
};

/** Folder-name candidates for a T3 gateway folder, in order of preference. */
function t3GatewayCandidates(folderName: string): string[] {
  const stem = folderName.replace(/^t3-(?:claude|codex)-/, "");
  // No kimi-/zai- stripping: a Kimi or Z.ai backed session must never get a Claude identity's browser,
  // because it would send page content to another provider.
  return [...new Set([folderName, stem])];
}

/** Identity for a folder directly inside <T3 home>/gateway, matched by name or alias (T3 instance folders hold only a gateway token). */
function identityForT3GatewayFolder(live: Identity[], configDir: string, t3Gateway: string, real: (p: string) => string): Identity | undefined {
  const dir = normaliseDir(configDir);
  if (realOrNormal(dirname(dir), real) !== realOrNormal(t3Gateway, real)) return undefined;
  const pools = live.filter((i) => isSwapPool(i));
  for (const candidate of t3GatewayCandidates(basename(dir))) {
    const named = findIdentityByNameOrAlias(live, candidate);
    if (named) return named;
    if (candidate === "pool" && pools.length === 1) return pools[0];
  }
  return undefined;
}

/**
 * Registered identity (pool or plain) a preset CLAUDE_CONFIG_DIR / CODEX_HOME belongs to (T3 Code,
 * other launchers). Identity resolution skips the registry then, but the browser wiring still needs
 * the identity. Match: the folder is the identity's config dir, or (a launcher's own folder, such as
 * T3's per-account ~/.t3/gateway/t3-claude-<name>) its `projects` / `sessions` link points into the
 * identity's config dir, or the folder sits directly in <T3 home>/gateway and its name (without a
 * t3-claude-/t3-codex- prefix) is an identity name or alias. Retired
 * identities are never returned. `t3Gateway` is injectable for tests.
 */
export function identityForConfigDir(
  file: IdentitiesFile,
  configDir: string,
  real: (p: string) => string = realpathSync,
  t3Gateway: string = join(t3Paths().t3Home, "gateway"),
): Identity | undefined {
  const live = file.identities.filter((i) => !isRetired(i));
  const target = normaliseDir(configDir);
  const direct = live.find((i) => normaliseDir(i.configDir) === target);
  if (direct) return direct;
  for (const sub of TRANSCRIPT_LINKS) {
    let linked: string;
    try {
      linked = normaliseDir(dirname(real(join(expandPath(configDir), sub))));
    } catch {
      continue;
    }
    if (linked === realOrNormal(configDir, real)) continue;
    const owner = live.find((i) => realOrNormal(i.configDir, real) === linked);
    if (owner) return owner;
  }
  return identityForT3GatewayFolder(live, configDir, t3Gateway, real);
}

