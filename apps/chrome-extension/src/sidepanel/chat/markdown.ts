// Safe markdown for untrusted agent text. The parser makes data only and passes no HTML through.
// The renderer builds nodes with createElement and text nodes. It never uses innerHTML.

export type MdInline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "b" | "i"; v: MdInline[] } | { t: "a"; href: string; v: MdInline[] };
export type MdBlock = { t: "p"; inline: MdInline[] } | { t: "code"; lang?: string; text: string } | { t: "ul" | "ol"; items: MdInline[][] } | { t: "h"; level: 1 | 2 | 3; inline: MdInline[] } | { t: "quote"; inline: MdInline[] };

export const MAX_MARKDOWN_CHARS = 200_000;
const MAX_DEPTH = 4;
const TRUNCATED = "This message is too long. The rest is hidden.";
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** A finder that never rescans: a cached match at or after the new start point is still the next match. */
class Finder {
  private last = new Map<string, { from: number; at: number }>();
  constructor(private s: string) {}
  next(needle: string, from: number): number {
    const c = this.last.get(needle);
    if (c && from >= c.from && (c.at === -1 || from <= c.at)) return c.at;
    const at = this.s.indexOf(needle, from);
    this.last.set(needle, { from, at });
    return at;
  }
}

function safeHref(raw: string): string | undefined {
  const u = raw.trim();
  if (!/^(https?|mailto):/i.test(u)) return undefined;
  try {
    const url = new URL(u);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function parseInline(s: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  const f = new Finder(s);
  let buf = "";
  const flush = (): void => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "`") {
      const end = f.next("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: s.slice(i + 1, end) }); i = end + 1; continue; }
    } else if (c === "[" && depth < MAX_DEPTH) {
      const close = f.next("](", i + 1);
      const paren = close === -1 ? -1 : f.next(")", close + 2);
      if (close > i + 1 && paren !== -1) {
        const label = s.slice(i + 1, close);
        const href = label.includes("[") ? undefined : safeHref(s.slice(close + 2, paren));
        if (href && !/\s/.test(s.slice(close + 2, paren).trim())) {
          flush();
          out.push({ t: "a", href, v: parseInline(label, depth + 1) });
        } else {
          buf += s.slice(i, paren + 1); // not a safe link: keep the source as plain text
        }
        i = paren + 1;
        continue;
      }
    } else if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const double = s[i + 1] === c;
      const mark = double ? c + c : c;
      const prev = i > 0 ? s[i - 1]! : " ";
      if (c === "*" || !/[A-Za-z0-9]/.test(prev)) {
        const end = f.next(mark, i + mark.length);
        if (end > i + mark.length && !/\s/.test(s[i + mark.length]!)) {
          flush();
          out.push({ t: double ? "b" : "i", v: parseInline(s.slice(i + mark.length, end), depth + 1) });
          i = end + mark.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^\s*```\s*([A-Za-z0-9_+.#-]{0,32})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const truncated = src.length > MAX_MARKDOWN_CHARS;
  const lines = (truncated ? src.slice(0, MAX_MARKDOWN_CHARS) : src).split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: MdInline[][] } | undefined;
  const endPara = (): void => { if (para.length) { blocks.push({ t: "p", inline: parseInline(para.join("\n")) }); para = []; } };
  const end = (): void => { endPara(); list = undefined; };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.replace(/\r$/, "");
    const fence = FENCE.exec(line);
    if (fence) {
      end();
      const body: string[] = [];
      n++;
      while (n < lines.length && !FENCE.test(lines[n]!.replace(/\r$/, ""))) body.push(lines[n++]!.replace(/\r$/, ""));
      blocks.push(fence[1] ? { t: "code", lang: fence[1], text: body.join("\n") } : { t: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") { end(); continue; }
    const h = HEADING.exec(line);
    if (h) { end(); blocks.push({ t: "h", level: Math.min(3, h[1]!.length) as 1 | 2 | 3, inline: parseInline(h[2]!.trim()) }); continue; }
    const item = ITEM.exec(line);
    if (item) {
      endPara();
      const t = /^\d/.test(item[1]!) ? "ol" : "ul";
      if (!list || list.t !== t) { list = { t, items: [] }; blocks.push(list); }
      list.items.push(parseInline(item[2]!));
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) { end(); blocks.push({ t: "quote", inline: parseInline(q[1]!) }); continue; }
    list = undefined;
    para.push(line);
  }
  end();
  if (truncated) blocks.push({ t: "p", inline: [{ t: "text", v: TRUNCATED }] });
  return blocks;
}

function renderInline(doc: Document, parent: Node, inline: MdInline[]): void {
  for (const n of inline) {
    if (n.t === "text") parent.appendChild(doc.createTextNode(n.v));
    else if (n.t === "code") { const el = doc.createElement("code"); el.textContent = n.v; parent.appendChild(el); }
    else if (n.t === "a") {
      const el = doc.createElement("a");
      el.setAttribute("href", n.href);
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
      renderInline(doc, el, n.v);
      parent.appendChild(el);
    } else {
      const el = doc.createElement(n.t === "b" ? "strong" : "em");
      renderInline(doc, el, n.v);
      parent.appendChild(el);
    }
  }
}

export function renderBlocks(doc: Document, blocks: MdBlock[]): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    if (b.t === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = b.text;
      pre.appendChild(code);
      frag.appendChild(pre);
    } else if (b.t === "ul" || b.t === "ol") {
      const list = doc.createElement(b.t);
      for (const it of b.items) { const li = doc.createElement("li"); renderInline(doc, li, it); list.appendChild(li); }
      frag.appendChild(list);
    } else {
      const tag = b.t === "p" ? "p" : b.t === "quote" ? "blockquote" : `h${(b as { level: number }).level + 2}`;
      const el = doc.createElement(tag);
      renderInline(doc, el, (b as { inline: MdInline[] }).inline);
      frag.appendChild(el);
    }
  }
  return frag;
}
