import type { ChromeProfileOverride, IdentitiesFile } from "./types.ts";
import { isRetired } from "./retired.ts";
import { normalizePath, parseDirectoryPattern, patternMatches, scorePattern } from "./match.ts";

export interface ChromeMcpTargetResolution {
  identityName: string;
  source: "directory-override" | "active-identity";
  /** Human note from the matched override, if it set one — surfaced in
   * open.ts's diagnostic log so a redirect is traceable to its config entry. */
  label?: string;
}

function bestOverrideMatch(
  normalizedCwd: string,
  overrides: ChromeProfileOverride[],
): ChromeProfileOverride | undefined {
  let best: { override: ChromeProfileOverride; score: number } | undefined;
  for (const override of overrides) {
    for (const raw of override.directories) {
      const parsed = parseDirectoryPattern(raw, "chromeProfileOverrides");
      if (!patternMatches(normalizedCwd, parsed)) continue;
      const score = scorePattern(parsed);
      if (!best || score > best.score) best = { override, score };
    }
  }
  return best?.override;
}

/**
 * Resolve which identity's Chrome (Claude MCP) instance a link auto-opened
 * from `cwd` (under the identity whose config dir is `configDirValue`)
 * should open in. Directory overrides win outright over the naturally active
 * identity — they exist specifically to redirect to a different one. Returns
 * null when nothing resolves, so callers fall back to unmodified `open`
 * behavior.
 *
 * A retired identity never gets a Chrome instance started for it: an override
 * whose target is retired (or a retired active identity) resolves to null so
 * the link falls through to the unmodified `open`, rather than failing a
 * plain link-open or silently redirecting to some other identity's profile.
 */
export function resolveChromeMcpTarget(
  cwd: string,
  configDirValue: string | undefined,
  file: IdentitiesFile,
): ChromeMcpTargetResolution | null {
  const normalizedCwd = normalizePath(cwd);

  const override = bestOverrideMatch(normalizedCwd, file.chromeProfileOverrides ?? []);
  if (override) {
    const target = file.identities.find((i) => i.name === override.targetIdentity);
    if (target && isRetired(target)) return null;
    return { identityName: override.targetIdentity, source: "directory-override", label: override.label };
  }

  if (!configDirValue) return null;
  const normalizedConfigDir = normalizePath(configDirValue);
  const identity = file.identities.find((i) => normalizePath(i.configDir) === normalizedConfigDir);
  if (identity && !isRetired(identity)) {
    return { identityName: identity.name, source: "active-identity" };
  }
  return null;
}
