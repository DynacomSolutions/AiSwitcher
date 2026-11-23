// Real brand marks for the providers, drawn as inline SVG. The paths come from simple-icons (CC0).
// Only the named icons are imported, so the bundle keeps just these paths.
import { siClaude, siMoonshotai, siOpencode, siZdotai } from "simple-icons";
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";

const NS = "http://www.w3.org/2000/svg";

/** The OpenAI knot. simple-icons dropped it upstream, so the path is vendored here, as in apps/web/src/components/provider-icon.tsx.
 * The web app builds in its own Docker stage from apps/web alone, so a module shared with this one would not reach that stage. */
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9108 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9893 5.9893 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.747-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

/** xAI has no mark in simple-icons, so Grok gets a plain X in a ring, as the web app does with its X monogram. This is not brand art. */
const GROK_RING = "M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21zm0 1.8a8.7 8.7 0 1 1 0 17.4 8.7 8.7 0 0 1 0-17.4z";
const GROK_X = "M8.3 7.4L12 11l3.7-3.6 1.3 1.3L13.3 12.3 17 15.9l-1.3 1.3L12 13.6l-3.7 3.6L7 15.9l3.7-3.6L7 8.7z";
const UNKNOWN_PATH = "M12 1.5a10.5 10.5 0 1 0 0 21 10.5 10.5 0 0 0 0-21zm0 1.8a8.7 8.7 0 1 1 0 17.4 8.7 8.7 0 0 1 0-17.4zM11.1 16.5h1.8V18h-1.8zM12 6a3.3 3.3 0 0 0-3.3 3.3h1.8a1.5 1.5 0 1 1 2.1 1.4c-.9.5-1.5 1.1-1.5 2.3v.5h1.8v-.4c0-.5.3-.8.9-1.2A3.2 3.2 0 0 0 12 6z";

export interface ProviderMark {
  name: string;
  /** Fill colour. It has enough contrast on the light panel, so the dark brand marks stay dark. */
  colour: string;
  /** SVG path data for the 24 by 24 view box. */
  paths: string[];
}

const MARKS: Record<ChatProvider, ProviderMark> = {
  claude: { name: "Claude", colour: `#${siClaude.hex}`, paths: [siClaude.path] },
  codex: { name: "Codex", colour: "#10a37f", paths: [OPENAI_PATH] },
  kimi: { name: "Kimi", colour: "#18181b", paths: [siMoonshotai.path] },
  grok: { name: "Grok", colour: "#3f3f46", paths: [GROK_RING, GROK_X] },
  zai: { name: "Z.ai", colour: `#${siZdotai.hex}`, paths: [siZdotai.path] },
  opencode: { name: "OpenCode", colour: "#18181b", paths: [siOpencode.path] },
};
const UNKNOWN: ProviderMark = { name: "Provider", colour: "#6b7280", paths: [UNKNOWN_PATH] };

export function providerMark(p: ChatProvider | undefined): ProviderMark {
  return p ? MARKS[p] : UNKNOWN;
}

/** The mark as an inline SVG, built with the DOM and never with markup text. The label is the provider name. */
export function providerIconSvg(doc: Document, provider: ChatProvider | undefined, size = 16): SVGSVGElement {
  const m = providerMark(provider);
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", m.colour);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", m.name);
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "provider-svg");
  for (const d of m.paths) {
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
