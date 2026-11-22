// A small Document stand-in: the tests run without a DOM. Anything that could run agent HTML throws.
const BANNED = ["innerHTML", "outerHTML", "href", "src"];

export class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e?: any) => void>> = {};
  style: Record<string, string> = {};
  value = "";
  disabled = false;
  maxLength = -1;
  className = "";
  hidden = false;
  tabIndex = 0;
  private text = "";
  constructor(public tag: string, private doc?: FakeDoc) {
    for (const k of BANNED) Object.defineProperty(this, k, { set() { throw new Error(`${k} written`); }, get() { throw new Error(`${k} read`); } });
  }
  get textContent(): string { return this.tag === "#text" ? this.text : this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children.forEach((c) => { c.parent = undefined; }); this.children = []; this.text = v; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get nextSibling(): FakeNode | null { const i = this.parent ? this.parent.children.indexOf(this) : -1; return i < 0 ? null : (this.parent!.children[i + 1] ?? null); }
  private adopt(n: FakeNode): void { n.remove(); n.parent = this; }
  append(...n: FakeNode[]): void { for (const x of n) { this.adopt(x); this.children.push(x); } }
  appendChild(n: FakeNode): FakeNode { this.append(n); return n; }
  replaceChildren(...n: FakeNode[]): void {
    for (const c of this.children) c.parent = undefined;
    this.children = [];
    this.text = "";
    for (const x of n) if (x.tag === "#frag") this.append(...[...x.children]); else this.append(x);
  }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    this.adopt(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  remove(): void { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = undefined; } }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  addEventListener(t: string, fn: (e?: any) => void): void { (this.listeners[t] ??= []).push(fn); }
  dispatch(t: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners[t] ?? []) fn({ preventDefault() {}, ...e }); }
  click(): void { for (const fn of this.listeners.click ?? []) fn(); }
  focus(): void { if (this.doc) this.doc.activeElement = this; }
  insertAdjacentHTML(): never { throw new Error("insertAdjacentHTML used"); }
}

export class FakeDoc {
  activeElement?: FakeNode;
  listeners: Record<string, Array<(e?: any) => void>> = {};
  addEventListener(t: string, fn: (e?: any) => void): void { (this.listeners[t] ??= []).push(fn); }
  dispatch(t: string, e: Record<string, unknown> = {}): void { for (const fn of this.listeners[t] ?? []) fn({ preventDefault() {}, ...e }); }
  createElement(t: string): FakeNode { return new FakeNode(t, this); }
  createTextNode(v: string): FakeNode { const n = new FakeNode("#text", this); n.textContent = v; return n; }
  createDocumentFragment(): FakeNode { return new FakeNode("#frag", this); }
  write(): never { throw new Error("document.write used"); }
}

export const fakeDoc = (): FakeDoc => new FakeDoc();
export const asDoc = (d: FakeDoc): Document => d as unknown as Document;
export const asEl = (n: FakeNode): HTMLElement => n as unknown as HTMLElement;
export const walk = (n: FakeNode, out: FakeNode[] = []): FakeNode[] => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
