// Inline SVG icons for the composer and the model picker. Each one is built with the DOM, never with markup text.
const NS = "http://www.w3.org/2000/svg";

export type IconName = "star" | "star-outline" | "check" | "chevron-down" | "search" | "send" | "stop";

interface Part { tag: "path" | "circle" | "rect"; attrs: Record<string, string> }

const ARROW_STROKE = { fill: "none", stroke: "var(--accent-ink)", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" };
const PARTS: Record<IconName, Part[]> = {
  star: [{ tag: "path", attrs: { d: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.45 4.73L5.82 21z" } }],
  "star-outline": [{ tag: "path", attrs: { d: "M12 15.39l-3.76 2.27.99-4.28-3.32-2.88 4.38-.37L12 6.09l1.71 4.04 4.38.37-3.32 2.88.99 4.28M22 9.24l-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03z" } }],
  check: [{ tag: "path", attrs: { d: "M21 7L9 19l-5.5-5.5 1.41-1.41L9 16.17 19.59 5.59z" } }],
  "chevron-down": [{ tag: "path", attrs: { d: "M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6-6-6z" } }],
  search: [{ tag: "path", attrs: { d: "M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.52 6.52 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5z" } }],
  send: [{ tag: "circle", attrs: { cx: "12", cy: "12", r: "11" } }, { tag: "path", attrs: { d: "M12 17.5V7M7.2 11.8L12 7l4.8 4.8", ...ARROW_STROKE } }],
  stop: [{ tag: "rect", attrs: { x: "6", y: "6", width: "12", height: "12", rx: "2.5" } }],
};

/** An icon that takes its colour from the text colour. It is hidden from assistive technology: the button holds the name. */
export function icon(doc: Document, name: IconName, size = 18): SVGSVGElement {
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon-${name}`);
  for (const p of PARTS[name]) {
    const node = doc.createElementNS(NS, p.tag);
    for (const [k, v] of Object.entries(p.attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}
