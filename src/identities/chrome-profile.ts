import type { ChromeProfileOverride, IdentitiesFile } from "./types.ts";
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
 */
export function resolveChromeMcpTarget(
  cwd: string,
  configDirValue: string | undefined,
  file: IdentitiesFile,
): ChromeMcpTargetResolution | null {
  const normalizedCwd = normalizePath(cwd);

  const override = bestOverrideMatch(normalizedCwd, file.chromeProfileOverrides ?? []);
  if (override) {
    return { identityName: override.targetIdentity, source: "directory-override", label: override.label };
  }

  if (!configDirValue) return null;
  const normalizedConfigDir = normalizePath(configDirValue);
  const identity = file.identities.find((i) => normalizePath(i.configDir) === normalizedConfigDir);
  if (identity) {
    return { identityName: identity.name, source: "active-identity" };
  }
  return null;
}
