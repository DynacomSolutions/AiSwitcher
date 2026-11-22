import { describe, expect, test } from "bun:test";
import { parseMarkdown, renderBlocks, type MdBlock, type MdInline } from "../src/sidepanel/chat/markdown.ts";

const flat = (inl: MdInline[]): string => inl.map((i) => (i.t === "text" || i.t === "code" ? i.v : flat(i.v))).join("");
const links = (blocks: MdBlock[]): string[] => {
  const out: string[] = [];
  const walk = (inl: MdInline[]): void => { for (const i of inl) { if (i.t === "a") { out.push(i.href); walk(i.v); } else if (i.t === "b" || i.t === "i") walk(i.v); } };
  for (const b of blocks) {
    if (b.t === "p" || b.t === "h" || b.t === "quote") walk(b.inline);
    else if (b.t === "ul" || b.t === "ol") b.items.forEach(walk);
  }
  return out;
};

// A tiny Document stand-in: the tests run without a DOM.
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  textContent = "";
  constructor(public tag: string) {}
  append(...n: FakeNode[]): void { this.children.push(...n); }
  appendChild(n: FakeNode): FakeNode { this.children.push(n); return n; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  get innerHTML(): string { throw new Error("innerHTML used"); }
  set innerHTML(_v: string) { throw new Error("innerHTML used"); }
}
const fakeDoc = (): Document => ({
  createElement: (t: string) => new FakeNode(t),
  createTextNode: (v: string) => { const n = new FakeNode("#text"); n.textContent = v; return n; },
  createDocumentFragment: () => new FakeNode("#frag"),
}) as unknown as Document;
const walk = (n: FakeNode, out: FakeNode[] = []): FakeNode[] => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
const render = (src: string): FakeNode[] => walk(renderBlocks(fakeDoc(), parseMarkdown(src)) as unknown as FakeNode);

describe("parseMarkdown", () => {
  test("<script>alert(1)</script> stays text", () => {
    const b = parseMarkdown("<script>alert(1)</script>");
    expect(b).toEqual([{ t: "p", inline: [{ t: "text", v: "<script>alert(1)</script>" }] }]);
    const nodes = render("<script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(nodes.some((x) => x.tag === "script" || x.tag === "img")).toBe(false);
  });
  test("event attributes stay text", () => {
    const nodes = render('<a href="x" onclick="alert(1)">x</a>');
    expect(nodes.some((x) => x.tag === "a")).toBe(false);
    expect(nodes.some((x) => "onclick" in x.attrs)).toBe(false);
  });
  test("HTML entities stay verbatim text", () => {
    const b = parseMarkdown("&lt;script&gt; &amp; &#60;");
    expect(flat((b[0] as { inline: MdInline[] }).inline)).toBe("&lt;script&gt; &amp; &#60;");
  });
  test("[x](javascript:alert(1)) renders as text with no link", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.test", "/relative"]) {
      const b = parseMarkdown(`[x](${u})`);
      expect(links(b)).toEqual([]);
      expect(render(`[x](${u})`).some((n) => n.tag === "a")).toBe(false);
    }
  });
  test("[x](https://example.test) becomes an anchor block", () => {
    const b = parseMarkdown("[x](https://example.test)");
    expect(links(b)).toEqual(["https://example.test/"]);
    const a = render("[x](https://example.test) [m](mailto:a@example.test) [h](http://example.test)").filter((n) => n.tag === "a");
    expect(a).toHaveLength(3);
    for (const n of a) { expect(n.attrs.rel).toBe("noopener noreferrer"); expect(n.attrs.target).toBe("_blank"); }
  });
  test("markdown images are not rendered", () => {
    const nodes = render("![x](https://example.test/a.png)");
    expect(nodes.some((n) => n.tag === "img")).toBe(false);
  });
  test("a fenced block keeps its text verbatim", () => {
    const b = parseMarkdown("```ts\nconst a = <b>*x*</b>;\n  [y](javascript:z)\n```");
    expect(b).toEqual([{ t: "code", lang: "ts", text: "const a = <b>*x*</b>;\n  [y](javascript:z)" }]);
  });
  test("inline emphasis, code, headings and lists parse", () => {
    const b = parseMarkdown("# T\n\n**b** *i* `c`\n\n- a\n- b\n\n1. x\n2. y\n\n> q");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "quote"]);
    expect(flat((b[1] as { inline: MdInline[] }).inline)).toBe("b i c");
  });
  test("a 1 MB input returns blocks within 200 000 characters and appends a truncation notice", () => {
    const b = parseMarkdown("a".repeat(1_000_000));
    const chars = b.reduce((s, x) => s + (x.t === "p" ? flat(x.inline).length : x.t === "code" ? x.text.length : 0), 0);
    expect(chars).toBeLessThanOrEqual(200_000 + 200);
    const last = b[b.length - 1] as { t: string; inline: MdInline[] };
    expect(flat(last.inline).toLowerCase()).toContain("too long");
  });
  test("unterminated fence, stray backticks and nested lists do not throw", () => {
    expect(() => parseMarkdown("```js\nnever closed")).not.toThrow();
    expect(parseMarkdown("```js\nnever closed")[0]).toEqual({ t: "code", lang: "js", text: "never closed" });
    expect(() => parseMarkdown("` `` ``` ` **unclosed *x [a](b ](")).not.toThrow();
    expect(() => parseMarkdown("- a\n  - b\n    - c\n- d\n   1. e")).not.toThrow();
    expect(() => parseMarkdown("*".repeat(5000) + "[".repeat(5000))).not.toThrow();
  });
  test("10 000 paragraphs parse in under 500 ms", () => {
    const src = Array.from({ length: 10_000 }, (_, i) => `**${i}** *i* \`c\``).join("\n\n");
    const t = performance.now();
    const b = parseMarkdown(src);
    expect(performance.now() - t).toBeLessThan(500);
    expect(b.length).toBe(10_000);
  });
});
