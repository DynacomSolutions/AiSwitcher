// Six chat colours. They match tab group colours, so a chat and its tab group look alike. Colours are unique per window.
import type { GroupColor } from "../background/chrome-api.ts";

export const CHAT_PALETTE: ReadonlyArray<{ hex: string; group: GroupColor }> = [
  { hex: "#3b82f6", group: "blue" },
  { hex: "#f97316", group: "orange" },
  { hex: "#22c55e", group: "green" },
  { hex: "#8b5cf6", group: "purple" },
  { hex: "#ec4899", group: "pink" },
  { hex: "#06b6d4", group: "cyan" },
];

/** The lowest palette colour not in `used`. Returns undefined when all six are used. */
export function nextChatColour(used: ReadonlyArray<string>): string | undefined {
  return CHAT_PALETTE.find(p => !used.includes(p.hex))?.hex;
}
