// Original monogram marks for the providers. They are plain letters on a colour, not vendor logos.
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";

export interface ProviderMark { text: string; colour: string; name: string }

const MARKS: Record<ChatProvider, ProviderMark> = {
  claude: { text: "Cl", colour: "#b45309", name: "Claude" },
  codex: { text: "Cx", colour: "#0f766e", name: "Codex" },
  kimi: { text: "Ki", colour: "#1d4ed8", name: "Kimi" },
  grok: { text: "Gk", colour: "#4b5563", name: "Grok" },
  zai: { text: "Z", colour: "#7c3aed", name: "Z.ai" },
  opencode: { text: "Oc", colour: "#be185d", name: "OpenCode" },
};
const UNKNOWN: ProviderMark = { text: "?", colour: "#6b7280", name: "Provider" };

export function providerMark(p: ChatProvider | undefined): ProviderMark {
  return p ? MARKS[p] : UNKNOWN;
}
