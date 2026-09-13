/**
 * Per-identity session colours, shared by the CLI, the console server and
 * the WebUI so all three surfaces render the exact same colour for the same
 * identity (the WebUI imports the compiled values via its own build; this
 * module is the single source of truth for the palette and the hash).
 *
 * A registry identity MAY carry an explicit `colour` (validated #rgb/#rrggbb,
 * see store.ts). Every identity also has an EFFECTIVE colour: the explicit
 * one when set, otherwise a stable palette pick derived from
 * hash(tool + ":" + identity name), so the same identity always renders the
 * same colour on every machine and across restarts without any stored state.
 */

/** Tasteful, high-separation palette (Tailwind 500-range hues). Ordered so
 * that consecutive FNV-1a buckets land on visually distinct colours. */
export const IDENTITY_COLOUR_PALETTE: readonly string[] = [
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#14b8a6",
  "#f97316",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
  "#8b5cf6",
  "#f43f5e",
  "#0ea5e9",
  "#10b981",
  "#e879f9",
  "#f59e0b",
];

/** Matches #rgb or #rrggbb (hex digits only). */
const COLOUR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidIdentityColour(raw: unknown): raw is string {
  return typeof raw === "string" && COLOUR_PATTERN.test(raw);
}

/** Normalises a validated colour to the canonical stored/display form:
 * lowercase, expanded to six digits (#abc -> #aabbcc). Returns undefined for
 * anything that fails isValidIdentityColour. */
export function normaliseIdentityColour(raw: string): string | undefined {
  if (!isValidIdentityColour(raw)) return undefined;
  const hex = raw.slice(1).toLowerCase();
  return hex.length === 3 ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : `#${hex}`;
}

/** FNV-1a over the tool-qualified identity key. One implementation so the
 * CLI, server and web always agree on the same auto-assigned colour. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The auto-assigned palette colour for an identity with no explicit colour:
 * a stable function of (tool, name), never of machine state. */
export function autoIdentityColour(tool: string, name: string): string {
  return IDENTITY_COLOUR_PALETTE[hashKey(`${tool}:${name}`) % IDENTITY_COLOUR_PALETTE.length]!;
}

/** The colour an identity renders with: its explicit `colour` when valid,
 * otherwise the auto palette pick. */
export function effectiveIdentityColour(tool: string, name: string, explicit: string | undefined): string {
  const normalised = explicit === undefined ? undefined : normaliseIdentityColour(explicit);
  return normalised ?? autoIdentityColour(tool, name);
}
