import { DEFAULT_CALL_TIMEOUT_MS, WAIT_CALL_TIMEOUT_MS } from "../../../../src/browser/protocol.ts";
import type { BrowserErrorCode, CallRequest, CallResult } from "../../../../src/browser/protocol.ts";
import { TOOL_SCHEMAS, validateToolArgs } from "../../../../src/browser/tool-args.ts";
import type { ExtensionTool, ToolArgs } from "../../../../src/browser/tool-args.ts";
import type { ChromeApi, TabInfo } from "./chrome-api.ts";
import { parseKeys } from "./keys.ts";
import type { State } from "./state.ts";
import type { TabManager } from "./tabs.ts";
import { noopUi } from "./ui.ts";
import type { ActionKind, Ui, UiSession } from "./ui.ts";

export const MAX_TEXT_CHARS = 100_000;
export const MAX_SCREENSHOT_EDGE = 1568;
export const JPEG_QUALITY = 80;
const NAVIGATE_LOAD_WAIT_MS = 15_000;
const BUFFER_LIMIT = 500;

type Content = Extract<CallResult, { ok: true }>["content"];

export class ToolError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) { super(message); }
}

export function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]` : text;
}

const text = (t: string): Content => [{ type: "text", text: capText(t) }];

/** Read pixel dimensions from a JPEG header (SOF marker). */
export function jpegSize(base64: string): { width: number; height: number } | undefined {
  const bin = atob(base64.slice(0, 65536 - (65536 % 4)));
  for (let i = 2; i + 9 < bin.length;) {
    if (bin.charCodeAt(i) !== 0xff) { i++; continue; }
    const marker = bin.charCodeAt(i + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6), width: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8) };
    }
    i += 2 + ((bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3));
  }
  return undefined;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "option", "listbox", "treeitem"]);
const NOISE = new Set(["none", "generic", "InlineTextBox", "LineBreak", "presentation", "RootWebArea", "paragraph", "Section"]);

interface RefTable { byRef: Map<string, number>; byNode: Map<number, string>; next: number }
interface NetEntry { id: string; method: string; url: string; status?: number; error?: string }

export interface ExecutorDeps {
  api: ChromeApi;
  tabs: TabManager;
  state: State;
  ui?: Ui;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  defaultTimeoutMs?: number;
}

export class Executor {
  private readonly api: ChromeApi;
  private readonly tabs: TabManager;
  private readonly state: State;
  private readonly ui: Ui;
  private readonly attached = new Set<number>();
  private readonly domReady = new Set<number>();
  private readonly scales = new Map<number, number>();
  private readonly refTables = new Map<number, RefTable>();
  private readonly consoleBuf = new Map<number, string[]>();
  private readonly netBuf = new Map<number, NetEntry[]>();
  private readonly lastPoint = new Map<number, { x: number; y: number }>();
  private readonly waiters = new Map<number, Set<{ methods: string[]; resolve: () => void }>>();

  constructor(deps: ExecutorDeps) {
    this.api = deps.api;
    this.tabs = deps.tabs;
    this.state = deps.state;
    this.ui = deps.ui ?? noopUi;
    this.sleepFn = deps.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    }));
    this.defaultTimeout = deps.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.api.debugger.onEvent((tabId, method, params) => this.onEvent(tabId, method, params));
    this.api.debugger.onDetach((tabId, reason) => {
      this.dropTab(tabId);
      // The user dismissed Chrome's debugging bar: treat as Stop for everything.
      if (reason === "canceled_by_user") void this.state.stop();
    });
    this.api.tabs.onRemoved(tabId => { this.dropTab(tabId); void this.unmark(tabId); });
    this.state.onStop(async () => { await Promise.all([this.detachAll(), this.ui.unmarkAll()]); });
    this.state.onChange(paused => { if (paused) void this.ui.unmarkAll(); });
  }

  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly defaultTimeout: number;

  async run(req: CallRequest): Promise<CallResult> {
    const { id } = req;
    const fail = (error: BrowserErrorCode, message: string): CallResult => ({ id, ok: false, error, message });
    if (this.state.paused) return fail("paused_by_user", "The user paused this browser. Do not retry until they resume it.");
    if (req.tool === "list_browsers") return fail("bad_args", "list_browsers is answered by the gateway");
    if (!Object.hasOwn(TOOL_SCHEMAS, req.tool)) return fail("bad_args", `Unknown tool ${String(req.tool)}`);
    const tool: ExtensionTool = req.tool;
    const invalid = validateToolArgs(tool, req.args);
    if (invalid) return fail("bad_args", invalid);

    const controller = this.state.track(id);
    const timeoutMs = tool === "wait" ? WAIT_CALL_TIMEOUT_MS + 1000 : this.defaultTimeout;
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new ToolError(this.abortCode(controller.signal.reason), this.abortMessage(controller.signal.reason)));
      if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      const content = await Promise.race([this.dispatch(tool, req, controller.signal), aborted]);
      return { id, ok: true, content };
    } catch (e) {
      if (controller.signal.aborted) return fail(this.abortCode(controller.signal.reason), this.abortMessage(controller.signal.reason));
      if (e instanceof ToolError) return fail(e.code, e.message);
      return fail("internal", e instanceof Error ? e.message : "Unknown error");
    } finally {
      clearTimeout(timer);
      this.state.untrack(id);
    }
  }

  private abortCode(reason: unknown): BrowserErrorCode { return reason === "stopped" ? "stopped_by_user" : "timeout"; }
  private abortMessage(reason: unknown): string {
    if (reason === "stopped") return "The user pressed Stop. Do not retry.";
    if (reason === "aborted") return "Call aborted by the gateway.";
    return "The call timed out.";
  }

  // ---- dispatch ----------------------------------------------------------

  private async dispatch(tool: ExtensionTool, req: CallRequest, signal: AbortSignal): Promise<Content> {
    const sig = signal;
    const session = req.session;
    const args = req.args as unknown;
    const a = <T extends ExtensionTool>(_t: T): ToolArgs[T] => args as ToolArgs[T];
    switch (tool) {
      case "tabs_context": {
        const { own, other } = await this.tabs.list(session.id);
        const view = (t: TabInfo) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active });
        return text(JSON.stringify({ sessionTabs: own.map(view), otherTabs: other.map(view), note: "otherTabs are read-only; use adopt_tab to control one." }));
      }
      case "tabs_create": {
        this.throwIfAborted(sig);
        const tab = await this.tabs.create(session, a("tabs_create").url ? this.normaliseUrl(a("tabs_create").url!) : undefined);
        await this.markControlled(tab.id, session);
        return text(JSON.stringify({ tabId: tab.id, url: tab.url }));
      }
      case "adopt_tab": {
        const { tabId } = a("adopt_tab");
        const tab = await this.api.tabs.get(tabId);
        if (!tab) throw new ToolError("tab_closed", `Tab ${tabId} no longer exists.`);
        const owner = this.tabs.ownerOf(tabId);
        if (owner !== undefined && owner !== session.id) throw new ToolError("forbidden_tab", `Tab ${tabId} belongs to another session.`);
        this.throwIfAborted(sig);
        await this.tabs.addToSession(session, tabId);
        await this.markControlled(tabId, session);
        return text(`Adopted tab ${tabId}: ${tab.title}`);
      }
      case "wait": {
        await this.sleepFn(a("wait").seconds * 1000, signal);
        return text(`Waited ${a("wait").seconds} seconds.`);
      }
      default:
        break;
    }
    const { tabId } = a("screenshot");
    const tab = await this.ownedTab(req, tabId);
    this.throwIfAborted(sig);
    switch (tool) {
      case "navigate": return this.navigate(sig, tab, a("navigate").url);
      case "screenshot": return this.screenshot(sig, tabId);
      case "read_page": return text(await this.readPage(sig, tabId, a("read_page").filter ?? "interactive"));
      case "find": return text(await this.find(sig, tabId, a("find").query));
      case "click": {
        const p = await this.target(sig, tabId, a("click"));
        await this.input(sig, tabId, p, "click");
        const button = a("click").button ?? "left";
        const clickCount = a("click").clickCount ?? 1;
        const base = { x: p.x, y: p.y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4 };
        await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
        await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount });
        await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount, buttons: 0 });
        return text(`Clicked at (${Math.round(p.x)}, ${Math.round(p.y)}).`);
      }
      case "hover": {
        const p = await this.target(sig, tabId, a("hover"));
        await this.input(sig, tabId, p, "hover");
        await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
        return text(`Hovered at (${Math.round(p.x)}, ${Math.round(p.y)}).`);
      }
      case "type": {
        const { ref, text: value } = a("type");
        let p = this.lastPoint.get(tabId) ?? { x: 0, y: 0 };
        if (ref) {
          const r = await this.refPoint(sig, tabId, ref);
          p = { x: r.x, y: r.y };
          await this.cdp(sig, tabId, "DOM.focus", { backendNodeId: r.backendNodeId });
        }
        await this.input(sig, tabId, p, "type");
        await this.cdp(sig, tabId, "Input.insertText", { text: value });
        return text(`Typed ${value.length} characters.`);
      }
      case "key": {
        let specs;
        try { specs = parseKeys(a("key").key); } catch (e) { throw new ToolError("bad_args", (e as Error).message); }
        await this.input(sig, tabId, this.lastPoint.get(tabId) ?? { x: 0, y: 0 }, "key");
        for (let n = 0; n < (a("key").repeat ?? 1); n++) {
          for (const k of specs) {
            const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
            await this.cdp(sig, tabId, "Input.dispatchKeyEvent", { ...common, type: k.text !== undefined ? "keyDown" : "rawKeyDown", ...(k.text !== undefined ? { text: k.text } : {}), ...(k.commands ? { commands: k.commands } : {}) });
            await this.cdp(sig, tabId, "Input.dispatchKeyEvent", { ...common, type: "keyUp" });
          }
        }
        return text(`Pressed ${a("key").key}.`);
      }
      case "scroll": {
        const s = a("scroll");
        if (!s.direction) {
          if (!s.ref) throw new ToolError("bad_args", "scroll needs a direction or a ref");
          const p = await this.refPoint(sig, tabId, s.ref);
          await this.input(sig, tabId, p, "scroll");
          return text("Scrolled element into view.");
        }
        const p = s.ref || s.coordinate ? await this.target(sig, tabId, s) : await this.viewportCentre(sig, tabId);
        await this.input(sig, tabId, p, "scroll");
        const delta = (s.amount ?? 3) * 100;
        const dx = s.direction === "left" ? -delta : s.direction === "right" ? delta : 0;
        const dy = s.direction === "up" ? -delta : s.direction === "down" ? delta : 0;
        await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy });
        return text(`Scrolled ${s.direction}.`);
      }
      case "form_input": return this.formInput(sig, tabId, a("form_input").ref, a("form_input").value);
      case "javascript": {
        const r = (await this.cdp(sig, tabId, "Runtime.evaluate", { expression: a("javascript").code, awaitPromise: true, returnByValue: true, userGesture: true })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (r.exceptionDetails) throw new ToolError("internal", `JavaScript error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown"}`);
        const v = r.result?.value;
        return text(v === undefined ? (r.result?.description ?? "undefined") : JSON.stringify(v));
      }
      case "get_console": {
        const s = a("get_console");
        const pattern = s.pattern?.toLowerCase();
        const lines = (this.consoleBuf.get(tabId) ?? []).filter(l => (!s.onlyErrors || /^\[(error|exception)\]/.test(l)) && (!pattern || l.toLowerCase().includes(pattern)));
        if (s.clear) this.consoleBuf.set(tabId, []);
        return text(lines.length ? lines.join("\n") : "No console messages.");
      }
      case "get_network": {
        const s = a("get_network");
        const pattern = s.urlPattern?.toLowerCase();
        const rows = (this.netBuf.get(tabId) ?? []).filter(n => !pattern || n.url.toLowerCase().includes(pattern)).map(n => `${n.method} ${n.url} ${n.error ? `FAILED ${n.error}` : (n.status ?? "pending")}`);
        if (s.clear) this.netBuf.set(tabId, []);
        return text(rows.length ? rows.join("\n") : "No network requests.");
      }
      case "upload_file": {
        const u = a("upload_file");
        const id = this.refTable(tabId).byRef.get(u.ref);
        if (id === undefined) throw new ToolError("bad_args", `Unknown ref ${u.ref}; call read_page or find first.`);
        await this.ensureDom(sig, tabId);
        await this.cdp(sig, tabId, "DOM.setFileInputFiles", { files: u.paths, backendNodeId: id });
        return text(`Set ${u.paths.length} file(s).`);
      }
      case "resize": {
        this.throwIfAborted(sig);
        await this.api.windows.resize(tab.windowId, a("resize").width, a("resize").height);
        this.scales.delete(tabId);
        return text(`Resized window to ${a("resize").width}x${a("resize").height}.`);
      }
      case "close_tab": {
        this.throwIfAborted(sig);
        await this.api.tabs.remove(tabId);
        this.tabs.forget(tabId);
        await this.detach(tabId);
        await this.unmark(tabId);
        return text(`Closed tab ${tabId}.`);
      }
      default:
        throw new ToolError("bad_args", `Unsupported tool ${tool}`);
    }
  }

  // ---- ownership ---------------------------------------------------------

  private async ownedTab(req: CallRequest, tabId: number): Promise<TabInfo> {
    if (!this.tabs.owns(req.session.id, tabId)) throw new ToolError("forbidden_tab", `Tab ${tabId} is not in this session. Use tabs_create, or adopt_tab to take one of the user's tabs.`);
    const tab = await this.api.tabs.get(tabId);
    if (!tab) {
      this.tabs.forget(tabId);
      this.dropTab(tabId);
      throw new ToolError("tab_closed", `Tab ${tabId} was closed.`);
    }
    await this.markControlled(tabId, req.session);
    return tab;
  }

  private async markControlled(tabId: number, session: UiSession): Promise<void> {
    if (this.state.paused) return;
    try { await this.ui.markControlled(tabId, session); } catch { /* visuals never fail a tool call */ }
  }

  private async unmark(tabId: number): Promise<void> {
    try { await this.ui.unmark(tabId); } catch { /* best effort */ }
  }

  // ---- CDP ---------------------------------------------------------------

  private throwIfAborted(sig: AbortSignal): void {
    if (sig.aborted) throw new ToolError(this.abortCode(sig.reason), this.abortMessage(sig.reason));
  }

  private async ensureAttached(sig: AbortSignal, tabId: number): Promise<void> {
    this.throwIfAborted(sig);
    if (this.attached.has(tabId)) return;
    try {
      await this.api.debugger.attach(tabId);
    } catch (e) {
      if (!/already attached/i.test((e as Error).message ?? "")) throw new ToolError("internal", `Cannot attach debugger: ${(e as Error).message}`);
    }
    if (sig.aborted && sig.reason === "stopped") {
      // Stop landed while attaching: never leave the debugger attached, and forget any state a concurrent call recorded.
      try { await this.api.debugger.detach(tabId); } catch { /* already gone */ }
      this.dropTab(tabId);
      this.throwIfAborted(sig);
    }
    // A timeout or gateway abort keeps the attachment: a concurrent call may already rely on it.
    this.attached.add(tabId);
    for (const d of ["Page", "Runtime", "Log", "Network"]) await this.api.debugger.send(tabId, `${d}.enable`);
  }

  private async cdp(sig: AbortSignal, tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureAttached(sig, tabId);
    this.throwIfAborted(sig);
    const result = await this.api.debugger.send(tabId, method, params);
    this.throwIfAborted(sig);
    return result;
  }

  /** DOM calls on backend node ids need the DOM agent to know the document. */
  private async ensureDom(sig: AbortSignal, tabId: number): Promise<void> {
    if (this.domReady.has(tabId)) return;
    await this.cdp(sig, tabId, "DOM.enable");
    await this.cdp(sig, tabId, "DOM.getDocument", { depth: 0 });
    this.domReady.add(tabId);
  }

  private async detach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) {
      try { await this.api.debugger.detach(tabId); } catch { /* already gone */ }
    }
    this.dropTab(tabId);
  }

  private async detachAll(): Promise<void> {
    await Promise.all([...this.attached].map(id => this.detach(id)));
  }

  private dropTab(tabId: number): void {
    this.attached.delete(tabId);
    this.domReady.delete(tabId);
    this.scales.delete(tabId);
    this.refTables.delete(tabId);
    this.consoleBuf.delete(tabId);
    this.netBuf.delete(tabId);
    this.lastPoint.delete(tabId);
  }

  private push<T>(map: Map<number, T[]>, tabId: number, item: T): void {
    const arr = map.get(tabId) ?? [];
    arr.push(item);
    if (arr.length > BUFFER_LIMIT) arr.shift();
    map.set(tabId, arr);
  }

  private onEvent(tabId: number, method: string, p: Record<string, unknown>): void {
    const ws = this.waiters.get(tabId);
    if (ws) for (const w of [...ws]) if (w.methods.includes(method)) { ws.delete(w); w.resolve(); }
    if (method === "Page.frameNavigated" && !(p.frame as { parentId?: string } | undefined)?.parentId) this.domReady.delete(tabId);
    if (method === "Runtime.consoleAPICalled") {
      const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      this.push(this.consoleBuf, tabId, `[${String(p.type)}] ${args.map(x => (x.value !== undefined ? String(x.value) : (x.description ?? ""))).join(" ")}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = (p.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string } };
      this.push(this.consoleBuf, tabId, `[exception] ${d.exception?.description ?? d.text ?? ""}`);
    } else if (method === "Log.entryAdded") {
      const e = (p.entry ?? {}) as { level?: string; text?: string };
      this.push(this.consoleBuf, tabId, `[${e.level ?? "info"}] ${e.text ?? ""}`);
    } else if (method === "Network.requestWillBeSent") {
      const r = (p.request ?? {}) as { url?: string; method?: string };
      this.push(this.netBuf, tabId, { id: String(p.requestId), method: r.method ?? "GET", url: r.url ?? "" });
    } else if (method === "Network.responseReceived") {
      const e = this.netBuf.get(tabId)?.find(n => n.id === p.requestId);
      if (e) e.status = ((p.response ?? {}) as { status?: number }).status;
    } else if (method === "Network.loadingFailed") {
      const e = this.netBuf.get(tabId)?.find(n => n.id === p.requestId);
      if (e) e.error = String(p.errorText ?? "failed");
    }
  }

  private waitForEvent(tabId: number, methods: string[], ms: number): { promise: Promise<void>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const w = { methods, resolve: () => {} };
    const promise = new Promise<void>(resolve => {
      w.resolve = () => { if (timer) clearTimeout(timer); resolve(); };
      timer = setTimeout(resolve, ms);
    });
    const set = this.waiters.get(tabId) ?? new Set();
    set.add(w);
    this.waiters.set(tabId, set);
    return { promise, cancel: () => { set.delete(w); if (timer) clearTimeout(timer); } };
  }

  // ---- tools -------------------------------------------------------------

  private normaliseUrl(raw: string): string {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let u: URL;
    try { u = new URL(withScheme); } catch { throw new ToolError("bad_args", `Invalid URL ${raw}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:" && withScheme !== "about:blank") throw new ToolError("bad_args", "Only http(s) URLs and about:blank are allowed.");
    return u.protocol === "about:" ? "about:blank" : u.toString();
  }

  private async navigate(sig: AbortSignal, tab: TabInfo, target: string): Promise<Content> {
    const tabId = tab.id;
    await this.ensureAttached(sig, tabId);
    const loaded = this.waitForEvent(tabId, ["Page.loadEventFired", "Page.navigatedWithinDocument"], NAVIGATE_LOAD_WAIT_MS);
    try {
      if (target === "back" || target === "forward") {
        const h = (await this.cdp(sig, tabId, "Page.getNavigationHistory")) as { currentIndex: number; entries: Array<{ id: number }> };
        const entry = h.entries[h.currentIndex + (target === "back" ? -1 : 1)];
        if (!entry) throw new ToolError("bad_args", `No ${target} history entry.`);
        await this.cdp(sig, tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
      } else {
        const r = (await this.cdp(sig, tabId, "Page.navigate", { url: this.normaliseUrl(target) })) as { errorText?: string };
        if (r.errorText) throw new ToolError("internal", `Navigation failed: ${r.errorText}`);
      }
      await Promise.race([loaded.promise, new Promise<void>(r => sig.addEventListener("abort", () => r(), { once: true }))]);
      this.throwIfAborted(sig);
    } finally {
      loaded.cancel();
    }
    this.refTables.delete(tabId);
    this.domReady.delete(tabId);
    this.scales.delete(tabId);
    const now = await this.api.tabs.get(tabId);
    return text(`Navigated. Now at ${now?.url ?? target}`);
  }

  private async viewport(sig: AbortSignal, tabId: number): Promise<{ w: number; h: number; x: number; y: number }> {
    const m = (await this.cdp(sig, tabId, "Page.getLayoutMetrics")) as { cssVisualViewport?: { clientWidth: number; clientHeight: number; pageX: number; pageY: number }; cssLayoutViewport?: { clientWidth: number; clientHeight: number } };
    const v = m.cssVisualViewport;
    const l = m.cssLayoutViewport;
    return { w: v?.clientWidth ?? l?.clientWidth ?? 800, h: v?.clientHeight ?? l?.clientHeight ?? 600, x: v?.pageX ?? 0, y: v?.pageY ?? 0 };
  }

  private async viewportCentre(sig: AbortSignal, tabId: number): Promise<{ x: number; y: number }> {
    const v = await this.viewport(sig, tabId);
    return { x: v.w / 2, y: v.h / 2 };
  }

  private async shoot(sig: AbortSignal, tabId: number, v: { w: number; h: number; x: number; y: number }, scale: number): Promise<string> {
    const r = (await this.cdp(sig, tabId, "Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY, clip: { x: v.x, y: v.y, width: v.w, height: v.h, scale } })) as { data: string };
    return r.data;
  }

  private async screenshot(sig: AbortSignal, tabId: number): Promise<Content> {
    const v = await this.viewport(sig, tabId);
    let scale = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(v.w, v.h));
    let data = await this.shoot(sig, tabId, v, scale);
    let size = jpegSize(data);
    if (size && Math.max(size.width, size.height) > MAX_SCREENSHOT_EDGE) {
      // High-DPI output is larger than requested: scale down once more.
      scale *= MAX_SCREENSHOT_EDGE / Math.max(size.width, size.height);
      data = await this.shoot(sig, tabId, v, scale);
      size = jpegSize(data);
    }
    this.scales.set(tabId, size ? size.width / v.w : scale);
    return [{ type: "image", mimeType: "image/jpeg", data }];
  }

  private refTable(tabId: number): RefTable {
    let t = this.refTables.get(tabId);
    if (!t) { t = { byRef: new Map(), byNode: new Map(), next: 1 }; this.refTables.set(tabId, t); }
    return t;
  }

  private refFor(tabId: number, backendNodeId: number): string {
    const t = this.refTable(tabId);
    let ref = t.byNode.get(backendNodeId);
    if (!ref) {
      ref = `ref_${t.next++}`;
      t.byNode.set(backendNodeId, ref);
      t.byRef.set(ref, backendNodeId);
    }
    return ref;
  }

  private async axNodes(sig: AbortSignal, tabId: number): Promise<AxNode[]> {
    const r = (await this.cdp(sig, tabId, "Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
    return r.nodes ?? [];
  }

  private describe(tabId: number, n: AxNode, indent: string): string {
    const role = n.role?.value ?? "";
    const name = n.name?.value ? ` "${String(n.name.value).replace(/\s+/g, " ").slice(0, 200)}"` : "";
    const value = n.value?.value !== undefined && n.value.value !== "" ? ` value="${String(n.value.value).slice(0, 200)}"` : "";
    const ref = n.backendDOMNodeId !== undefined ? ` [${this.refFor(tabId, n.backendDOMNodeId)}]` : "";
    return `${indent}${role}${name}${value}${ref}`;
  }

  private async readPage(sig: AbortSignal, tabId: number, filter: "interactive" | "all"): Promise<string> {
    const nodes = await this.axNodes(sig, tabId);
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const lines: string[] = [];
    const walk = (n: AxNode, depth: number): void => {
      const role = n.role?.value ?? "";
      const named = Boolean(n.name?.value);
      const show = !n.ignored && (filter === "interactive" ? INTERACTIVE.has(role) : !NOISE.has(role) && (named || INTERACTIVE.has(role)));
      if (show) lines.push(this.describe(tabId, n, "  ".repeat(depth)));
      for (const c of n.childIds ?? []) {
        const child = byId.get(c);
        if (child) walk(child, show ? depth + 1 : depth);
      }
    };
    if (nodes[0]) walk(nodes[0], 0);
    return lines.length ? lines.join("\n") : "No matching elements.";
  }

  private async find(sig: AbortSignal, tabId: number, query: string): Promise<string> {
    const q = query.toLowerCase();
    const hits = (await this.axNodes(sig, tabId)).filter(n => {
      if (n.ignored || n.backendDOMNodeId === undefined) return false;
      const hay = `${n.role?.value ?? ""} ${n.name?.value ?? ""} ${String(n.value?.value ?? "")}`.toLowerCase();
      return hay.includes(q) && !NOISE.has(n.role?.value ?? "");
    }).slice(0, 20);
    return hits.length ? hits.map(n => this.describe(tabId, n, "")).join("\n") : "No matching elements.";
  }

  private async refPoint(sig: AbortSignal, tabId: number, ref: string): Promise<{ x: number; y: number; backendNodeId: number }> {
    const backendNodeId = this.refTable(tabId).byRef.get(ref);
    if (backendNodeId === undefined) throw new ToolError("bad_args", `Unknown ref ${ref}; call read_page or find first.`);
    try {
      await this.ensureDom(sig, tabId);
      await this.cdp(sig, tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const q = (await this.cdp(sig, tabId, "DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
      const quad = q.quads?.[0];
      if (!quad || quad.length < 8) throw new Error("not visible");
      const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
      const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      return { x, y, backendNodeId };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      this.throwIfAborted(sig);
      throw new ToolError("bad_args", `Element ${ref} is stale or not visible; call read_page again.`);
    }
  }

  /** Resolve ref or screenshot-space coordinate to page CSS pixels. */
  private async target(sig: AbortSignal, tabId: number, t: { ref?: string; coordinate?: [number, number] }): Promise<{ x: number; y: number }> {
    if (t.ref) return this.refPoint(sig, tabId, t.ref);
    if (t.coordinate) {
      const scale = this.scales.get(tabId);
      if (scale === undefined) throw new ToolError("bad_args", "Take a screenshot first: coordinates are in screenshot pixels.");
      return { x: t.coordinate[0] / scale, y: t.coordinate[1] / scale };
    }
    throw new ToolError("bad_args", "Give either ref or coordinate.");
  }

  private async input(sig: AbortSignal, tabId: number, p: { x: number; y: number }, kind: ActionKind): Promise<void> {
    this.lastPoint.set(tabId, { x: p.x, y: p.y });
    try { await this.ui.beforeAction(tabId, { x: p.x, y: p.y, kind }, sig); } catch { /* visuals never fail a tool call */ }
    this.throwIfAborted(sig);
  }

  private async formInput(sig: AbortSignal, tabId: number, ref: string, value: string | number | boolean): Promise<Content> {
    const backendNodeId = this.refTable(tabId).byRef.get(ref);
    if (backendNodeId === undefined) throw new ToolError("bad_args", `Unknown ref ${ref}; call read_page or find first.`);
    await this.ensureDom(sig, tabId);
    const node = (await this.cdp(sig, tabId, "DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
    const objectId = node.object?.objectId;
    if (!objectId) throw new ToolError("bad_args", `Element ${ref} is stale; call read_page again.`);
    const r = (await this.cdp(sig, tabId, "Runtime.callFunctionOn", { objectId, returnByValue: true, arguments: [{ value }], functionDeclaration: FORM_INPUT_FN })) as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (r.exceptionDetails) throw new ToolError("bad_args", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Cannot set value");
    return text(`Set ${ref}.`);
  }
}

const FORM_INPUT_FN = `function (v) {
  const el = this;
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = Boolean(v);
  } else if (el instanceof HTMLSelectElement) {
    const opt = Array.from(el.options).find(o => o.value === String(v) || o.text === String(v));
    if (!opt) throw new Error("No option " + v);
    el.value = opt.value;
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(v));
  } else if (el.isContentEditable) {
    el.textContent = String(v);
  } else {
    throw new Error("Element is not a form control");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;
