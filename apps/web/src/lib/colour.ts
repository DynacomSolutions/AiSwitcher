/**
 * Identity colour helpers for the WebUI. The palette and the auto-assign
 * hash mirror src/identities/colour.ts (the single source of truth shared
 * with the CLI and server); keep both lists in sync. The server normally
 * supplies `effectiveColour` on every identity DTO, so these are fallbacks
 * for slices that render before the registry query resolves.
 */

/** Mirrors IDENTITY_COLOUR_PALETTE in src/identities/colour.ts. */
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

/** Matches #rgb or #rrggbb (hex digits only); same rule the server enforces. */
const COLOUR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidIdentityColour(raw: string): boolean {
  return COLOUR_PATTERN.test(raw);
}

/** Expands #abc to #aabbcc, lowercases; undefined when invalid. */
export function normaliseIdentityColour(raw: string): string | undefined {
  if (!isValidIdentityColour(raw)) return undefined;
  const hex = raw.slice(1).toLowerCase();
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : `#${hex}`;
}

/** FNV-1a over the tool-qualified identity key; identical to the server. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The stable auto palette pick for (tool, name), used when no explicit
 * colour is set and the registry DTO has not been fetched yet. */
export function autoIdentityColour(tool: string, name: string): string {
  return IDENTITY_COLOUR_PALETTE[hashKey(`${tool}:${name}`) % IDENTITY_COLOUR_PALETTE.length]!;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb | undefined {
  const normalised = normaliseIdentityColour(hex);
  if (!normalised) return undefined;
  const n = Number.parseInt(normalised.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Readable foreground for text rendered over the colour. */
export function readableTextOn(hex: string): string {
  return relativeLuminance(hex) > 0.4 ? "#1a1a1e" : "#ffffff";
}
