import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { Identity } from "./types.ts";
import { InvalidIdentitiesFileError } from "./errors.ts";

function expandTilde(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return raw;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith(sep)) return path.slice(0, -1);
  return path;
}

/** Tilde-expand and resolve to an absolute path — no realpath resolution, so
 * this is safe to call on a path that doesn't exist yet (e.g. a not-yet-
 * created identity's configDir). */
export function expandPath(raw: string): string {
  const expanded = expandTilde(raw);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Tilde-expand, realpath-resolve (if it exists), and strip any trailing
 * separator — the canonical form used to compare a cwd against a pattern's
 * base. Exported so other directory-pattern matchers (e.g. chrome-profile.ts)
 * stay in lockstep with identity resolution instead of drifting. */
export function normalizePath(raw: string): string {
  return stripTrailingSlash(safeRealpath(expandPath(raw)));
}

export interface ParsedPattern {
  raw: string;
  kind: "exact" | "recursive";
  /** normalized, realpath-resolved-if-it-exists absolute path */
  base: string;
}

/**
 * Grammar: no "*" anywhere -> exact match only. A pattern ending in a literal
 * "/*" segment -> recursive (this dir and everything beneath it). Any other
 * use of "*" is rejected at load time rather than guessing at a wider glob
 * dialect standard libraries (picomatch/minimatch) would otherwise apply,
 * where a bare trailing "*" means single-level-only, not recursive.
 */
export function parseDirectoryPattern(raw: string, context: string): ParsedPattern {
  const starIndex = raw.indexOf("*");
  if (starIndex === -1) {
    return { raw, kind: "exact", base: normalizePath(raw) };
  }
  if (raw.endsWith("/*") && raw.indexOf("*") === raw.length - 1) {
    const withoutStar = raw.slice(0, -2) || "/";
    return { raw, kind: "recursive", base: normalizePath(withoutStar) };
  }
  throw new InvalidIdentitiesFileError(
    `${context}: directories pattern "${raw}" is invalid — a wildcard is only supported as a ` +
      `whole trailing "/*" segment (matches that directory and everything beneath it). ` +
      `Wildcards elsewhere (mid-segment, or without recursive intent) are not supported.`,
  );
}

/** Lowercase letters, digits, and single hyphens only (e.g. "identity-a") — the
 * one grammar identity names and aliases are held to, shared by the
 * interactive create flow (prompt.ts) and the `ais identities` CLI. */
export function isValidIdentityKey(value: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
}

function segmentCount(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

/** Higher score = more specific. Exported for reuse by other
 * directory-pattern matchers (see normalizePath's doc comment). */
export function scorePattern(pattern: ParsedPattern): number {
  const segments = segmentCount(pattern.base);
  return pattern.kind === "exact" ? segments * 2 + 1 : segments * 2;
}

/** True if an already-normalizePath'd cwd falls within a parsed pattern's
 * scope. Exported for reuse by other directory-pattern matchers (see
 * normalizePath's doc comment) — the one place this comparison is defined. */
export function patternMatches(normalizedCwd: string, pattern: ParsedPattern): boolean {
  return pattern.kind === "exact"
    ? normalizedCwd === pattern.base
    : normalizedCwd === pattern.base || normalizedCwd.startsWith(pattern.base + sep);
}

export type DirectoryMatchResult =
  | { identity: Identity; pattern: string }
  | { ambiguous: true; candidates: Identity[] }
  | null;

export function matchDirectory(cwd: string, identities: Identity[]): DirectoryMatchResult {
  const normalizedCwd = normalizePath(cwd);

  let bestScore = -1;
  let bestMatches: Array<{ identity: Identity; pattern: string }> = [];

  for (const identity of identities) {
    for (const raw of identity.directories ?? []) {
      const parsed = parseDirectoryPattern(raw, `identity "${identity.name}"`);
      if (!patternMatches(normalizedCwd, parsed)) continue;

      const score = scorePattern(parsed);
      if (score > bestScore) {
        bestScore = score;
        bestMatches = [{ identity, pattern: raw }];
      } else if (score === bestScore) {
        // Only treat as ambiguous if it's a genuinely different identity at
        // the same specificity — multiple patterns on the *same* identity
        // tying is not a conflict.
        if (!bestMatches.some((m) => m.identity.name === identity.name)) {
          bestMatches.push({ identity, pattern: raw });
        }
      }
    }
  }

  if (bestMatches.length === 0) return null;
  if (bestMatches.length === 1) return bestMatches[0]!;
  return { ambiguous: true, candidates: bestMatches.map((m) => m.identity) };
}
