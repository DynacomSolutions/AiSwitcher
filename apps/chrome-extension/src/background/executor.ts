import { isInternalUrl } from "./chrome-api.ts";
import { GroupPrompt } from "./group-prompt.ts";
import type { PromptAnswer } from "./group-prompt.ts";
import { PROMPT_WAIT_MS } from "../shared/request.ts";
import type { PendingRequest } from "../shared/request.ts";
import { DEFAULT_CALL_TIMEOUT_MS, REQUEST_GROUP_CALL_TIMEOUT_MS, SESSION_END_TOOL, WAIT_CALL_TIMEOUT_MS } from "../../../../src/browser/protocol.ts";
import type { BrowserErrorCode, CallRequest, CallResult } from "../../../../src/browser/protocol.ts";
import { TOOL_SCHEMAS, validateToolArgs } from "../../../../src/browser/tool-args.ts";
import type { ExtensionTool, ToolArgs, UploadFile } from "../../../../src/browser/tool-args.ts";
import { splitUnsupported, UnsupportedApiError } from "./chrome-api.ts";
import type { ChromeApi, TabInfo } from "./chrome-api.ts";
import { parseKeys } from "./keys.ts";
import type { State } from "./state.ts";
import type { SessionRef, TabManager } from "./tabs.ts";
import { noopUi } from "./ui.ts";
import type { ActionKind, Ui, UiSession } from "./ui.ts";

export const MAX_TEXT_CHARS = 100_000;
export const MAX_SCREENSHOT_EDGE = 1568;
export const JPEG_QUALITY = 80;
const NAVIGATE_LOAD_WAIT_MS = 15_000;
const BUFFER_LIMIT = 500;
/** A capture that takes longer than this means Chrome is not rendering the tab. */
export const CAPTURE_TIMEOUT_MS = 8000;
/** After a hover the overlay stays hidden this long (or until the next non-hover call) so it cannot steal the pointer. */
export const HOVER_HOLD_MS = 1500;
/** How long the click of an upload may take to open the file chooser. */
export const FILE_CHOOSER_WAIT_MS = 3000;
/** Cross-origin iframes inside iframes: how deep the upload looks for a file chooser. */
const MAX_FRAME_DEPTH = 5;
/** Only iframes: workers and other targets of the page stay unattached. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe" }] };

type Content = Extract<CallResult, { ok: true }>["content"];

/** What a request_group request carries to its answer: the tabs the owner saw, and whether closing was asked. */
interface GroupMeta { tabIds: number[]; closable: boolean }
/** One request_group call waits this long. Agent tool timeouts are near 135 seconds, so the call returns before them. */
const GROUP_WAIT_MS = 100_000;

export class ToolError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) { super(message); }
}

/** The page did not answer the debugger's first commands: most often a dialog that opened before the attach, which Chrome never reports. */
class PageUnresponsive extends ToolError {
  constructor(tabId: number) {
    super("timeout", `Tab ${tabId} does not respond. It probably shows a JavaScript dialog (alert, confirm, prompt or "Leave site?") that opened before AIS attached to it; AIS cannot see or answer that one. Ask the user to answer it in Chrome, then try again. Do not retry before that.`);
  }
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
/** An event a waiter was resolved with; `sessionId` is set when it came from a cross-origin iframe. */
interface Waited { params: Record<string, unknown>; sessionId?: string }
interface Waiter { methods: string[]; frames: boolean; resolve: (e: Waited) => void }

/** A JavaScript dialog (alert, confirm, prompt, beforeunload) open on a tab, as CDP reported it. */
export interface PendingDialog {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
  /** The tool call that was running on the tab when it opened, if any. */
  openedDuring?: string;
  /** Set when a cross-origin iframe opened it: the dialog is answered on that session. */
  sessionId?: string;
}
/** Calls that still work while a dialog is open: they only read what the extension already holds, or answer the dialog. */
const DIALOG_SAFE = new Set<ExtensionTool>(["get_console", "get_network", "handle_dialog"]);
const MAX_DIALOG_TEXT = 300;
/** How long close_tab waits for Chrome to close the tab (or for the page's "Leave site?" dialog). */
const CLOSE_WAIT_MS = 5000;
const CLOSE_POLL_MS = 100;
/** How long a fresh attach waits for the page to answer before the call fails with PageUnresponsive. */
export const ATTACH_ANSWER_MS = 5000;
const clip = (t: string): string => (t.length > MAX_DIALOG_TEXT ? `${t.slice(0, MAX_DIALOG_TEXT)}...` : t);

export interface ExecutorDeps {
  api: ChromeApi;
  tabs: TabManager;
  state: State;
  ui?: Ui;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  defaultTimeoutMs?: number;
  captureTimeoutMs?: number;
  hoverHoldMs?: number;
  fileChooserWaitMs?: number;
  /** How long a fresh attach waits for the page to answer (tests shorten it). */
  attachAnswerMs?: number;
  /** A chat session's link set changed (a tab it created): the gateway must hear of it before the call result. */
  onLinks?: (sessionId: string, tabIds: number[]) => void | Promise<void>;
  /** How long request_group waits for the user (tests shorten it). */
  groupPromptMs?: number;
  /** How long one request_group call waits before it reports "pending" (tests shorten it). */
  groupWaitMs?: number;
}

export class Executor {
  private readonly api: ChromeApi;
  private readonly tabs: TabManager;
  private readonly state: State;
  private readonly ui: Ui;
  private readonly onLinks: (sessionId: string, tabIds: number[]) => void | Promise<void>;
  private readonly groupPrompt: GroupPrompt<GroupMeta>;
  private readonly groupWaitMs: number;
  private readonly groupPromptMs: number;
  /** Pending request_group approvals, and the one way to answer them. */
  get requests(): { list(): PendingRequest[]; answer(id: string, approve: boolean): boolean; onChange(l: () => void): void; popupRequestId(tabId: number): string | undefined } {
    const p = this.groupPrompt;
    return { list: () => p.list(), answer: (id, approve) => (approve ? p.approve(id) : p.deny(id)), onChange: l => p.onChange(l), popupRequestId: tabId => p.popupRequestId(tabId) };
  }
  /** Per tab: the tail of the calls of chat sessions, so chats that share a tab never run on it at the same time. */
  private readonly tabLocks = new Map<number, Promise<void>>();
  private readonly attached = new Set<number>();
  /** Per tab: the domain enables of an attach the page has not answered yet. */
  private readonly enabling = new Map<number, Promise<void>>();

  /** Tabs the debugger is attached to right now. */
  attachedTabIds(): number[] { return [...this.attached]; }

  private readonly domReady = new Set<number>();
  private readonly scales = new Map<number, number>();
  private readonly refTables = new Map<number, RefTable>();
  private readonly consoleBuf = new Map<number, string[]>();
  private readonly netBuf = new Map<number, NetEntry[]>();
  private readonly lastPoint = new Map<number, { x: number; y: number }>();
  private readonly waiters = new Map<number, Set<Waiter>>();
  /** Per tab: the sessions told to attach to their cross-origin iframes (undefined is the page), and the sessions of those iframes. Set up by the first upload. */
  private readonly autoAttached = new Map<number, Set<string | undefined>>();
  private readonly frameSessions = new Map<number, Set<string>>();
  /** Per tab: the JavaScript dialog open right now, and the calls running on the tab that a new dialog must end. */
  private readonly dialogs = new Map<number, PendingDialog>();
  private readonly dialogWatchers = new Map<number, Set<{ tool: ExtensionTool; reject: (e: ToolError) => void }>>();

  /** The dialog open on a tab, if the extension saw one open. */
  pendingDialog(tabId: number): PendingDialog | undefined { return this.dialogs.get(tabId); }

  constructor(deps: ExecutorDeps) {
    this.api = deps.api;
    this.tabs = deps.tabs;
    this.state = deps.state;
    this.ui = deps.ui ?? noopUi;
    this.onLinks = deps.onLinks ?? (() => {});
    this.groupPrompt = new GroupPrompt<GroupMeta>(deps.api);
    this.groupWaitMs = deps.groupWaitMs ?? GROUP_WAIT_MS;
    this.groupPromptMs = deps.groupPromptMs ?? PROMPT_WAIT_MS;
    if (deps.onLinks) this.tabs.onLinksChanged = deps.onLinks;
    this.sleepFn = deps.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    }));
    this.defaultTimeout = deps.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.captureTimeout = deps.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
    this.hoverHold = deps.hoverHoldMs ?? HOVER_HOLD_MS;
    this.chooserWait = deps.fileChooserWaitMs ?? FILE_CHOOSER_WAIT_MS;
    this.attachAnswer = deps.attachAnswerMs ?? ATTACH_ANSWER_MS;
    this.api.debugger.onEvent((tabId, method, params, sessionId) => this.onEvent(tabId, method, params, sessionId));
    this.api.debugger.onDetach((tabId, reason) => {
      this.dropTab(tabId);
      // Chrome's Cancel button stops the sessions marked on this tab.
      if (reason === "canceled_by_user") {
        this.state.stopTab(tabId);
        this.state.abortTab(tabId);
      }
    });
    this.api.tabs.onRemoved(tabId => { this.dropTab(tabId); this.cancelHold(tabId); void this.unmark(tabId); });
    this.api.tabs.onReplaced((added, removed) => {
      // The debugger was attached to the retired id: mark it detached, so the next call attaches to the new tab.
      this.dropTab(removed);
      this.cancelHold(removed);
      if (this.ui.replaceTab) void Promise.resolve(this.ui.replaceTab(added, removed)).catch(() => {});
    });
    this.state.onStop(async () => { await Promise.all([this.detachAll(), this.ui.unmarkAll(), this.releaseAllHolds()]); });
    this.state.onChange(paused => { if (paused) void this.ui.unmarkAll(); });
  }

  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly defaultTimeout: number;
  private readonly captureTimeout: number;
  private readonly hoverHold: number;
  private readonly chooserWait: number;
  private readonly attachAnswer: number;
  private readonly held = new Map<number, ReturnType<typeof setTimeout>>();

  async run(req: CallRequest): Promise<CallResult> {
    const { id } = req;
    const fail = (error: BrowserErrorCode, message: string): CallResult => ({ id, ok: false, error, message });
    if (req.tool === SESSION_END_TOOL) return this.endSession(req);
    if (this.state.paused) return fail("paused_by_user", "The user paused this browser. Do not retry until they resume it.");
    if (this.state.isStopped(req.session.id)) {
      for (const tabId of this.ui.markedTabs?.(req.session.id) ?? []) void Promise.resolve(this.ui.unmarkSession(tabId, req.session.id)).catch(() => {});
      return fail("stopped_by_user", "You stopped this agent on this page.");
    }
    if (req.tool === "list_browsers") return fail("bad_args", "list_browsers is answered by the gateway");
    if (!Object.hasOwn(TOOL_SCHEMAS, req.tool)) return fail("bad_args", `Unknown tool ${String(req.tool)}`);
    const tool: ExtensionTool = req.tool;
    const invalid = validateToolArgs(tool, req.args);
    if (invalid) return fail("bad_args", invalid);

    if (this.tabs.touch(req.session)) {
      for (const tabId of this.ui.markedTabs?.(req.session.id) ?? []) void this.markControlled(tabId, req.session);
    }
    const tabId = typeof req.args.tabId === "number" ? req.args.tabId : undefined;
    const controller = this.state.track(id, req.session.id, req.session.identity, tabId);
    this.tabs.callStarted(req.session.id);
    const timeoutMs = tool === "wait" ? WAIT_CALL_TIMEOUT_MS + 1000 : tool === "request_group" ? REQUEST_GROUP_CALL_TIMEOUT_MS : this.defaultTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new ToolError(this.abortCode(controller.signal.reason), this.abortMessage(controller.signal.reason)));
      if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      await Promise.race([this.tabs.regrant(req.session).catch(() => {}), aborted]);
      this.throwIfAborted(controller.signal);
      await Promise.race([this.tabs.reclaim(req.session).catch(() => {}), aborted]);
      this.throwIfAborted(controller.signal);
      timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
      const content = await Promise.race([this.dispatch(tool, req, controller.signal), aborted]);
      return { id, ok: true, content };
    } catch (e) {
      if (controller.signal.aborted) return fail(this.abortCode(controller.signal.reason), this.abortMessage(controller.signal.reason));
      if (e instanceof ToolError) return fail(e.code, e.message);
      return fail("internal", e instanceof Error ? e.message : "Unknown error");
    } finally {
      clearTimeout(timer);
      this.tabs.callEnded(req.session.id);
      this.state.untrack(id);
    }
  }

  /** The agent session ended: closes the tabs it created, releases the rest. Works while paused, so a pause never leaves a dead session's tabs behind. */
  private async endSession(req: CallRequest): Promise<CallResult> {
    this.groupPrompt.cancelSession(req.session.id);
    const s = this.tabs.sessions.get(req.session.id);
    if (!s || s.identity === req.session.identity) this.state.resumeSession(req.session.id, req.session.identity);
    if (s && s.identity !== req.session.identity) return { id: req.id, ok: true, content: [{ type: "text", text: "no such session" }] };
    const tabIds = s ? [...s.tabIds] : [];
    await this.tabs.closeSession(req.session.id, req.session.identity);
    if (req.session.chat === true) this.tabs.dropChat(req.session.id);
    await Promise.all(tabIds.map(async tabId => { await this.detach(tabId); await this.unmark(tabId); }));
    return { id: req.id, ok: true, content: [{ type: "text", text: "session ended" }] };
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
        if (session.chat === true) return this.chatContext(session.id);
        const listed = await this.tabs.list(session.id);
        // Browser and extension pages are left out: no agent tool may use them.
        const usable = (t: TabInfo) => !isInternalUrl(t.url);
        const own = listed.own.filter(usable), granted = listed.granted.filter(usable), other = listed.other.filter(usable);
        const view = (t: TabInfo) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, groupId: t.groupId, ...(t.splitViewId !== undefined && t.splitViewId !== -1 ? { splitViewId: t.splitViewId } : {}) });
        const dialog = (t: TabInfo) => {
          const d = this.dialogs.get(t.id);
          return d ? { dialog: { type: d.type, message: d.message, url: d.url, ...(d.defaultPrompt !== undefined ? { defaultPrompt: d.defaultPrompt } : {}) } } : {};
        };
        const actionable = (t: TabInfo) => ({ ...view(t), ...dialog(t) });
        const grantedView = (t: TabInfo) => ({ ...actionable(t), scope: "granted", groupId: t.groupId });
        const mineGroup = this.tabs.sessions.get(session.id)?.groupId;
        // `scope` and `grantedGroups` are additive: "own" tabs are in this session's own group, "granted" tabs sit in a group the user granted.
        const ownView = (t: TabInfo) => (t.groupId !== -1 && t.groupId !== mineGroup && this.tabs.grantee(t.groupId) === session.id ? grantedView(t) : { ...actionable(t), scope: "own" });
        return text(JSON.stringify({ sessionTabs: [...own.map(ownView), ...granted.map(grantedView)], otherTabs: other.map(view), grantedGroups: this.tabs.grantedGroups(session.id), groups: await this.tabs.groupsOverview(session.id), savedGroups: await this.tabs.savedGroups(session.identity), note: "groupId is -1 for a tab that is in no group. A group in groups with scope other can be asked for with request_group (the user must approve). groups lists every open tab group: scope own is the group of this session, granted is a group the user granted, saved is a saved group, other is any other group. otherTabs are read-only; use adopt_tab to control one. scope \"granted\" tabs belong to a group the user granted: use and open tabs in them (tabs_create with groupId), but you cannot rename or close that group. savedGroups are named groups that outlive a session: open one with open_group. A tab with \"dialog\" has a JavaScript dialog open: other calls on it fail with dialog_open until you answer it with handle_dialog." }));
      }
      case "tabs_create": {
        this.throwIfAborted(sig);
        const { url, groupId, splitWithTabId } = a("tabs_create");
        const target = url ? this.normaliseUrl(url) : undefined;
        if (session.chat === true && groupId !== undefined) throw new ToolError("forbidden_tab", "A chat cannot open tabs in a granted group.");
        if (splitWithTabId !== undefined) {
          if (groupId !== undefined) throw new ToolError("bad_args", "Use either groupId or splitWithTabId, not both. The new tab opens in the group of the tab it splits with.");
          this.requireSplit();
          const base = await this.ownedTab(req, splitWithTabId);
          if (base.splitViewId !== -1) throw new ToolError("bad_args", `Tab ${splitWithTabId} is already in a split view. Use unsplit_tabs first.`);
          const made = await this.splitError(async () => {
            const opts = { splitWithTabId, windowId: base.windowId };
            if (this.tabs.inGrantedGroup(session.id, session.identity, base)) return this.tabs.createInGranted(session, base.groupId, target, opts);
            if (base.groupId === -1 || base.groupId !== this.tabs.sessions.get(session.id)?.groupId) throw new ToolError("bad_args", `Tab ${splitWithTabId} is not in this session's tab group, so a split tab cannot join its group.`);
            return this.tabs.create(session, target, opts);
          });
          if (!made) throw new ToolError("forbidden_tab", `Group ${base.groupId} is not granted to this session.`);
          await this.markControlled(made.id, session);
          const now = await this.api.tabs.get(made.id);
          return text(JSON.stringify({ tabId: made.id, url: made.url, ...(base.groupId !== -1 ? { groupId: base.groupId } : {}), splitViewId: now?.splitViewId ?? -1 }));
        }
        if (groupId !== undefined) {
          const made = await this.tabs.createInGranted(session, groupId, target);
          if (!made) throw new ToolError("forbidden_tab", `Group ${groupId} is not granted to this session.`);
          await this.markControlled(made.id, session);
          return text(JSON.stringify({ tabId: made.id, url: made.url, groupId }));
        }
        const tab = await this.tabs.create(session, target);
        if (session.chat === true) {
          // The gateway must accept the new tab before the agent can use it.
          const links = [...new Set([...this.tabs.chatLinks(session.id), tab.id])];
          this.tabs.setChatLinks(session.id, links, true);
          await this.onLinks(session.id, links);
        }
        await this.markControlled(tab.id, session);
        return text(JSON.stringify({ tabId: tab.id, url: tab.url }));
      }
      case "split_tabs": {
        this.throwIfAborted(sig);
        const [idA, idB] = a("split_tabs").tabIds;
        if (idA === idB) throw new ToolError("bad_args", "split_tabs needs two different tabs.");
        this.requireSplit();
        const first = await this.ownedTab(req, idA);
        const second = await this.ownedTab(req, idB);
        if (first.splitViewId !== -1 && first.splitViewId === second.splitViewId) return text(JSON.stringify({ splitViewId: first.splitViewId, tabIds: [idA, idB] }));
        for (const t of [first, second]) if (t.splitViewId !== -1) throw new ToolError("bad_args", `Tab ${t.id} is already in another split view. Use unsplit_tabs first.`);
        if (first.windowId !== second.windowId) throw new ToolError("bad_args", "The two tabs are in different windows. A split view needs one window.");
        if (first.pinned !== second.pinned) throw new ToolError("bad_args", "One tab is pinned and the other is not. A split view needs the same pinned state.");
        if (first.groupId !== second.groupId) throw new ToolError("bad_args", "The two tabs are in different tab groups. A split view needs the same group.");
        const splitViewId = await this.splitError(async () => {
          let moved = false;
          const originalIndex = second.index;
          if (Math.abs(first.index - second.index) !== 1) {
            // Move the second tab to sit right after the first. Moving removes it first, so the target index depends on the side it comes from.
            await this.api.tabs.move(idB, originalIndex > first.index ? first.index + 1 : first.index);
            moved = true;
          }
          try {
            return await this.api.tabs.createSplit([idA, idB]);
          } catch (e) {
            if (moved) await this.api.tabs.move(idB, originalIndex).catch(() => {}); // best effort: put the tab back where the user had it
            throw e;
          }
        });
        return text(JSON.stringify({ splitViewId, tabIds: [idA, idB] }));
      }
      case "unsplit_tabs": {
        this.throwIfAborted(sig);
        const { tabId } = a("unsplit_tabs");
        this.requireSplit();
        const tab = await this.ownedTab(req, tabId);
        if (tab.splitViewId === -1) throw new ToolError("bad_args", `Tab ${tabId} is not in a split view.`);
        const members = (await this.api.tabs.query()).filter(t => t.splitViewId === tab.splitViewId);
        for (const t of members) {
          if (!this.tabs.owns(session.id, t.id, session.identity) && !this.tabs.inGrantedGroup(session.id, session.identity, t)) throw new ToolError("forbidden_tab", `Tab ${t.id} in this split view is not in this session, so the split view cannot be removed.`);
        }
        await this.splitError(() => this.api.tabs.unsplit(tab.splitViewId));
        return text(JSON.stringify({ unsplit: true, splitViewId: tab.splitViewId, tabIds: members.map(t => t.id) }));
      }
      case "save_group": {
        this.throwIfAborted(sig);
        const { name, groupId } = a("save_group");
        const key = this.groupName(name);
        const r = await this.tabs.save(session, key, groupId);
        if (!r.ok) throw new ToolError(r.code, r.message);
        return text(JSON.stringify({ name: key, groupId: r.groupId, tabCount: r.tabCount, saved: true, note: "The tabs stay open after the session ends. Use open_group to open the group again." }));
      }
      case "open_group": {
        this.throwIfAborted(sig);
        const key = this.groupName(a("open_group").name);
        const r = await this.tabs.open(session, key);
        if (!r.ok) throw new ToolError(r.code, r.message);
        return text(JSON.stringify({ name: r.name, groupId: r.groupId, tabs: r.tabs, ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}) }));
      }
      case "forget_group": {
        const key = this.groupName(a("forget_group").name);
        const r = await this.tabs.forgetSaved(session, key);
        if (!r.ok) throw new ToolError(r.code, r.message);
        return text(JSON.stringify({ name: key, forgotten: true, open: r.wasOpen, note: "No tab was closed." }));
      }
      case "close_group": {
        this.throwIfAborted(sig);
        const { groupId } = a("close_group");
        if (session.chat === true) throw new ToolError("forbidden_tab", "A chat cannot close a tab group.");
        // The tab set is read once. A tab added to the group later is never closed.
        const members = (await this.api.tabs.query()).filter(t => t.groupId === groupId);
        const rule = this.tabs.checkClose(session, groupId, members.map(t => t.id));
        if (!rule.ok) throw new ToolError(rule.code, rule.message);
        if (members.length === 0) throw new ToolError("bad_args", `Group ${groupId} no longer exists or has no tab.`);
        // One tab that this session may not close refuses the whole call, and nothing is closed.
        for (const t of members) {
          if (isInternalUrl(t.url)) throw new ToolError("forbidden_tab", `Tab ${t.id} shows a browser or extension page. Group ${groupId} is not closed.`);
          const refusal = this.closeRefusal(session, t.id);
          if (refusal) throw new ToolError("forbidden_tab", `${refusal} Group ${groupId} is not closed and no tab was closed.`);
        }
        // Read again right before the remove: no await between this check, the abort check and the remove call.
        const latest = (await this.api.tabs.query()).filter(t => t.groupId === groupId);
        const ids = members.map(t => t.id).filter(id => latest.some(t => t.id === id));
        for (const t of latest) {
          if (!ids.includes(t.id)) continue;
          if (isInternalUrl(t.url)) throw new ToolError("forbidden_tab", `Tab ${t.id} shows a browser or extension page. Group ${groupId} is not closed.`);
          const refusal = this.closeRefusal(session, t.id);
          if (refusal) throw new ToolError("forbidden_tab", `${refusal} Group ${groupId} is not closed and no tab was closed.`);
        }
        if (this.tabs.checkClose(session, groupId, ids).ok !== true) throw new ToolError("forbidden_tab", `Group ${groupId} changed. It is not closed and no tab was closed.`);
        // A Stop or gateway abort here leaves every tab open.
        this.throwIfAborted(sig);
        // No debugger attach: like a discarded tab, the tabs close in one call. A page that asks "Leave site?" stays open and is reported below.
        // Chrome can throw after it closed some tabs (for example "No tab with id"). The wait and the report below show what is left.
        if (ids.length > 0) { try { await this.api.tabs.remove(ids); } catch { /* the stillOpen report below is the truth */ } }
        for (let waited = 0; waited < CLOSE_WAIT_MS; waited += CLOSE_POLL_MS) {
          if (!(await this.anyOpen(ids))) break;
          await this.sleepFn(CLOSE_POLL_MS, sig);
        }
        const stillOpen: number[] = [];
        for (const id of ids) {
          if (await this.api.tabs.get(id)) { stillOpen.push(id); continue; } // it stays owned
          this.tabs.forget(id);
          await this.detach(id);
          await this.unmark(id);
        }
        if (!(await this.api.tabs.query()).some(t => t.groupId === groupId)) this.tabs.closedGroup(groupId);
        const closed = ids.length - stillOpen.length;
        const left = stillOpen.length;
        const note = left > 0
          ? `${left} tab${left === 1 ? "" : "s"} stayed open and stay${left === 1 ? "s" : ""} yours. The page may ask "Leave site?" in Chrome, and this tool cannot see that dialog. The user must answer it in Chrome. Ask the user.`
          : "Every tab of the group is closed.";
        return text(JSON.stringify({ groupId, closed, stillOpen, note }));
      }
      case "request_group": {
        this.throwIfAborted(sig);
        const { groupId, allowClose } = a("request_group");
        if (session.chat === true) throw new ToolError("forbidden_tab", "A chat cannot ask for a tab group.");
        // The request outlives this call. A repeat call from the same session reads the answer that came after the last call returned, or joins the open request.
        let ticket = this.groupPrompt.pendingFor(session.id, groupId);
        let answer: PromptAnswer | "waiting" | undefined;
        let meta: GroupMeta | undefined = ticket?.meta;
        const earlier = ticket ? undefined : this.groupPrompt.answerFor(session.id, groupId);
        if (earlier) { answer = earlier.answer; meta = earlier.meta; }
        if (!ticket && !earlier) {
          const closable = allowClose === true;
          const first = await this.tabs.checkRequest(session, groupId, closable);
          if (!first.ok) throw new ToolError(first.code, first.message);
          if (first.already) return text(JSON.stringify({ groupId, already: true, note: "This group is already yours." }));
          if (!this.tabs.beginRequest(groupId)) throw new ToolError("forbidden_tab", `Another request for group ${groupId} is waiting for the user.`);
          meta = { tabIds: first.tabIds, closable };
          const started = this.groupPrompt.start(session.id, { agentLabel: session.label, identity: session.identity, groupId, groupTitle: first.title, tabCount: first.tabCount, allowClose: closable, shared: first.shared }, this.groupPromptMs, meta);
          void this.groupPrompt.wait(started.id, this.groupPromptMs + 1000, new AbortController().signal).then(() => this.tabs.endRequest(groupId));
          ticket = { ...started, meta };
        }
        if (answer === undefined) answer = await this.groupPrompt.wait(ticket!.id, this.groupWaitMs, sig);
        this.throwIfAborted(sig);
        if (answer === "waiting") {
          return text(JSON.stringify({ pending: true, requestId: ticket!.id, deadline: ticket!.deadline, message: "Waiting for the owner. Call request_group again with the same groupId to get the answer." }));
        }
        this.groupPrompt.forgetAnswer(session.id, groupId); // delivered now: a repeat call asks again
        if (answer !== "approve") throw new ToolError("forbidden_tab", answer === "timeout" ? "The user did not answer in time. Do not ask again unless the user asks." : answer === "deny" ? "The user denied access to this group. Do not ask again." : "The user closed the question without an answer. Do not ask again unless the user asks.");
        const closable = meta!.closable;
        const done = await this.tabs.takeGroup(session, groupId, meta!.tabIds, closable);
        if (!done.ok) throw new ToolError(done.code, done.message);
        return text(JSON.stringify({ groupId, approved: true, tabCount: done.tabCount, ...(done.allowCloseSkipped ? { allowCloseSkipped: true } : {}), note: closable && done.allowCloseSkipped ? "The group is now your own group and every tab is adopted. allowClose was not applied: an earlier approval may protect some tabs and they could not be told apart, so the session end closes none of them." : closable ? "The group is now your own group. You can close its tabs with close_tab, and the session end closes them. A tab that an earlier approval protected stays protected." : "The group is now your own group and every tab is adopted. The session end closes and ungroups none of them." }));
      }
      case "adopt_tab": {
        const { tabId } = a("adopt_tab");
        if (session.chat === true && !this.tabs.chatLinked(session.id, tabId) && !this.tabs.owns(session.id, tabId, session.identity)) throw new ToolError("forbidden_tab", "Only tabs you linked to this chat can be used. Link it in the side panel.");
        const tab = await this.api.tabs.get(tabId);
        if (!tab) throw new ToolError("tab_closed", `Tab ${tabId} no longer exists.`);
        this.assertDrivable(tab);
        if (session.chat === true) {
          return text(`Tab ${tabId} is linked to this chat and is already usable.`);
        }
        if (this.tabs.inGrantedGroup(session.id, session.identity, tab)) return text(`Tab ${tabId} is in a group granted to this session and is already usable.`);
        if (this.tabs.grantee(tab.groupId) !== undefined) throw new ToolError("forbidden_tab", `Tab ${tabId} is in a group the user granted to another session.`);
        const savedName = await this.tabs.savedNameOfGroup(tab.groupId);
        if (savedName !== undefined) throw new ToolError("forbidden_tab", `Tab ${tabId} is in the saved group "${savedName}". Use open_group to use it.`);
        const owner = this.tabs.ownerOf(tabId);
        if (owner !== undefined && !this.tabs.owns(session.id, tabId, session.identity)) throw new ToolError("forbidden_tab", `Tab ${tabId} belongs to another session.`);
        this.throwIfAborted(sig);
        await this.tabs.addToSession(session, tabId);
        // The owner's tab may already show a dialog, which blocks the page marker: attached first, so it is seen (or the page is found unresponsive) before the marker hangs.
        try {
          await this.watchDialogs(tabId, tool, async () => {
            await this.ensureAttached(sig, tabId);
            this.throwIfAborted(sig);
            await this.markControlled(tabId, session);
          }, sig);
        } catch (e) {
          const d = this.dialogs.get(tabId);
          if (e instanceof PageUnresponsive) return text(`Adopted tab ${tabId}: ${tab.title}. ${e.message}`);
          if (!(e instanceof ToolError && e.code === "dialog_open" && d)) throw e;
          void this.markControlled(tabId, session);
          return text(`Adopted tab ${tabId}: ${tab.title}. ${this.dialogError(tabId, d).message}`);
        }
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
    // A page blocked by a dialog answers neither CDP input nor script injection: a dialog that opens mid-call ends the call at once.
    // The dialog is read inside `work`, after a chat has the tab lock: an earlier call may have opened one.
    const work = async (): Promise<Content> => {
      const open = this.dialogs.get(tabId);
      if (open && !DIALOG_SAFE.has(tool)) throw this.dialogError(tabId, open);
      return this.watchDialogs(tabId, tool, async () => {
        // close_tab attaches itself, and only for a live page: a discarded, frozen or unresponsive tab must still close.
        if (tool === "close_tab") return this.tabTool(tool, req, sig, tab);
        // Attached before anything touches the page: a page that does not answer (a dialog Chrome never reported) ends the call here.
        await this.ensureAttached(sig, tabId);
        this.throwIfAborted(sig);
        if (open) void this.markControlled(tabId, session); else await this.markControlled(tabId, session);
        this.throwIfAborted(sig);
        if (tool !== "hover") await this.releaseHold(tabId);
        return this.tabTool(tool, req, sig, tab);
      }, sig);
    };
    return session.chat === true ? this.withTabLock(tabId, work, sig) : work();
  }

  private async anyOpen(ids: number[]): Promise<boolean> {
    const open = new Set((await this.api.tabs.query()).map(t => t.id));
    return ids.some(id => open.has(id));
  }

  /** Runs `work` after every earlier chat call on the same tab has ended. */
  private async withTabLock<T>(tabId: number, work: () => Promise<T>, sig: AbortSignal): Promise<T> {
    const prev = this.tabLocks.get(tabId) ?? Promise.resolve();
    const start = (): Promise<T> => {
      // A call aborted while it waited never starts.
      if (sig.aborted) return Promise.reject(new ToolError(this.abortCode(sig.reason), this.abortMessage(sig.reason)));
      return work();
    };
    const run = prev.then(start, start);
    // An abort ends this call's own hold on the lock. It never ends the hold of the call before it.
    const aborted = new Promise<void>(resolve => { if (sig.aborted) resolve(); else sig.addEventListener("abort", () => resolve(), { once: true }); });
    const settle = (): Promise<void> => Promise.race([run.then(() => {}, () => {}), aborted]);
    const tail = prev.then(settle, settle);
    this.tabLocks.set(tabId, tail);
    void tail.then(() => { if (this.tabLocks.get(tabId) === tail) this.tabLocks.delete(tabId); });
    return run;
  }

  /** What a chat sees: its linked tabs and the tabs it created. Nothing else. */
  private async chatContext(sessionId: string): Promise<Content> {
    const all = await this.api.tabs.query();
    const live = new Set(all.map(t => t.id));
    const links = this.tabs.chatLinks(sessionId);
    const dead = links.filter(id => !live.has(id));
    if (dead.length > 0) this.tabs.setChatLinks(sessionId, links.filter(id => live.has(id)));
    const created = this.tabs.sessions.get(sessionId)?.tabIds ?? new Set<number>();
    const mine = all.filter(t => !isInternalUrl(t.url) && (created.has(t.id) || this.tabs.chatLinked(sessionId, t.id)));
    const row = (t: TabInfo) => {
      const d = this.dialogs.get(t.id);
      return {
        tabId: t.id, url: t.url, title: t.title, active: t.active,
        ...(d ? { dialog: { type: d.type, message: d.message, url: d.url, ...(d.defaultPrompt !== undefined ? { defaultPrompt: d.defaultPrompt } : {}) } } : {}),
        scope: created.has(t.id) ? "own" : "linked",
      };
    };
    return text(JSON.stringify({ sessionTabs: mine.map(row), otherTabs: [], grantedGroups: [], note: "You can use only the tabs listed here: tabs the user linked to this chat and tabs you created. A tab with \"dialog\" has a JavaScript dialog open: other calls on it fail with dialog_open until you answer it with handle_dialog." }));
  }

  private async tabTool(tool: ExtensionTool, req: CallRequest, sig: AbortSignal, tab: TabInfo): Promise<Content> {
    const session = req.session;
    const args = req.args as unknown;
    const a = <T extends ExtensionTool>(_t: T): ToolArgs[T] => args as ToolArgs[T];
    const tabId = tab.id;
    switch (tool) {
      case "navigate": return this.navigate(sig, tab, a("navigate").url);
      case "screenshot": return this.hidden(sig, tabId, () => this.screenshot(sig, tabId));
      case "read_page": return text(await this.readPage(sig, tabId, a("read_page").filter ?? "interactive"));
      case "find": return text(await this.find(sig, tabId, a("find").query));
      case "click": {
        const p = await this.target(sig, tabId, a("click"));
        await this.input(sig, tabId, p, "click", session.id);
        await this.press(sig, tabId, p, a("click").button ?? "left", a("click").clickCount ?? 1);
        return text(`Clicked at (${Math.round(p.x)}, ${Math.round(p.y)}).`);
      }
      case "hover": {
        const p = await this.target(sig, tabId, a("hover"));
        await this.input(sig, tabId, p, "hover", session.id);
        await this.hidden(sig, tabId, () => this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }), true);
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
        await this.input(sig, tabId, p, "type", session.id);
        await this.cdp(sig, tabId, "Input.insertText", { text: value });
        return text(`Typed ${value.length} characters.`);
      }
      case "key": {
        let specs;
        try { specs = parseKeys(a("key").key); } catch (e) { throw new ToolError("bad_args", (e as Error).message); }
        await this.input(sig, tabId, this.lastPoint.get(tabId) ?? { x: 0, y: 0 }, "key", session.id);
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
          await this.input(sig, tabId, p, "scroll", session.id);
          return text("Scrolled element into view.");
        }
        const p = s.ref || s.coordinate ? await this.target(sig, tabId, s) : await this.viewportCentre(sig, tabId);
        await this.input(sig, tabId, p, "scroll", session.id);
        const delta = (s.amount ?? 3) * 100;
        const dx = s.direction === "left" ? -delta : s.direction === "right" ? delta : 0;
        const dy = s.direction === "up" ? -delta : s.direction === "down" ? delta : 0;
        await this.hidden(sig, tabId, () => this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy }));
        return text(`Scrolled ${s.direction}.`);
      }
      case "form_input": return this.formInput(sig, tabId, a("form_input").ref, a("form_input").value);
      case "upload_file": return this.uploadFile(sig, tabId, a("upload_file"), session.id);
      case "javascript": {
        const r = (await this.cdp(sig, tabId, "Runtime.evaluate", { expression: a("javascript").code, awaitPromise: true, returnByValue: true, userGesture: true })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (r.exceptionDetails) throw new ToolError("internal", `JavaScript error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown"}`);
        const v = r.result?.value;
        return text(v === undefined ? (r.result?.description ?? "undefined") : JSON.stringify(v));
      }
      case "handle_dialog": return this.handleDialog(sig, tabId, a("handle_dialog"));
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
      case "resize": {
        this.throwIfAborted(sig);
        const { width: w, height: h } = a("resize");
        // Responsive-mode emulation of this one tab only: the owner's browser window is never resized or moved.
        await this.cdp(sig, tabId, "Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 0, mobile: false });
        this.scales.delete(tabId);
        return text(`Emulated a ${w}x${h} viewport on tab ${tabId} (responsive mode). The browser window was not changed.`);
      }
      case "close_tab": {
        const refusal = this.closeRefusal(session, tabId);
        if (refusal) throw new ToolError("forbidden_tab", refusal);
        // A discarded or frozen page runs no script, so it cannot raise "Leave site?" and does not answer a debugger attach: close it directly.
        const before = await this.api.tabs.get(tabId);
        let unresponsive = false;
        if (!before?.discarded && !before?.frozen) {
          // Attached first, so a "Leave site?" (beforeunload) dialog that closing raises is seen and ends the call instead of hanging it.
          // A page that does not answer the attach (UnresponsiveTab) is still closed below; a real dialog keeps the tab open and ends the call there.
          try { await this.ensureAttached(sig, tabId); } catch (e) { if (!(e instanceof PageUnresponsive)) throw e; unresponsive = true; }
        }
        // A Stop or gateway abort during the attach (or on the discarded path) must leave the tab open.
        this.throwIfAborted(sig);
        await this.api.tabs.remove(tabId);
        // A page that asks "Leave site?" keeps its tab open: its dialog ends this call (dialog_open) while we wait. Cancel keeps the tab, and its ownership.
        for (let waited = 0; await this.api.tabs.get(tabId); waited += CLOSE_POLL_MS) {
          if (waited >= CLOSE_WAIT_MS) throw unresponsive ? new PageUnresponsive(tabId) : new ToolError("internal", `Tab ${tabId} is still open.`);
          await this.sleepFn(CLOSE_POLL_MS, sig);
        }
        this.tabs.forget(tabId);
        await this.detach(tabId);
        await this.unmark(tabId);
        return text(`Closed tab ${tabId}.`);
      }
      default:
        throw new ToolError("bad_args", `Unsupported tool ${tool}`);
    }
  }

  /** Why this session may not close the tab, or undefined when it may. The one rule of close_tab and close_group. */
  private closeRefusal(session: SessionRef, tabId: number): string | undefined {
    // Only tabs this session opened or adopted: tabs that merely sit in a granted group are the user's.
    if (!this.tabs.owns(session.id, tabId, session.identity)) return `Tab ${tabId} was not opened by this session, so it cannot be closed.`;
    if (this.tabs.isApproved(session.id, tabId)) return `Tab ${tabId} is in a group the user approved for this session. The session never closes these tabs.`;
    return undefined;
  }

  /** Fails before anything changes when this Chrome has no split view. */
  private groupName(name: string): string {
    const key = name.trim();
    if (key === "" || key.length > 100) throw new ToolError("bad_args", "name must have 1 to 100 characters.");
    return key;
  }

  private requireSplit(): void {
    if (!this.api.tabs.splitSupported()) throw new ToolError("bad_args", splitUnsupported().message);
  }

  /** Runs a split view call: a Chrome without the API becomes a ToolError the agent can read. */
  private async splitError<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) {
      if (e instanceof UnsupportedApiError) throw new ToolError("bad_args", e.message);
      throw e;
    }
  }

  // ---- ownership ---------------------------------------------------------

  private async ownedTab(req: CallRequest, tabId: number): Promise<TabInfo> {
    const own = this.tabs.owns(req.session.id, tabId, req.session.identity);
    if (req.session.chat === true) {
      if (!own && !this.tabs.chatLinked(req.session.id, tabId)) throw new ToolError("forbidden_tab", `Tab ${tabId} is not linked to this chat. Only tabs you linked to this chat can be used. Link it in the side panel.`);
      const linked = await this.api.tabs.get(tabId);
      if (!linked) {
        this.tabs.forget(tabId);
        this.dropTab(tabId);
        throw new ToolError("tab_closed", `Tab ${tabId} was closed.`);
      }
      this.assertDrivable(linked);
      return linked;
    }
    const forbidden = (): ToolError => new ToolError("forbidden_tab", `Tab ${tabId} is not in this session. Use tabs_create, or adopt_tab to take one of the user's tabs.`);
    if (!own && this.tabs.grantedGroups(req.session.id).length === 0) throw forbidden();
    const tab = await this.api.tabs.get(tabId);
    if (!own && (!tab || !this.tabs.inGrantedGroup(req.session.id, req.session.identity, tab))) throw forbidden();
    if (!tab) {
      this.tabs.forget(tabId);
      this.dropTab(tabId);
      throw new ToolError("tab_closed", `Tab ${tabId} was closed.`);
    }
    this.assertDrivable(tab);
    return tab;
  }

  /** Browser and extension pages are never driven by an agent. An extension page could answer an approval request. */
  private assertDrivable(tab: TabInfo): void {
    if (isInternalUrl(tab.url)) throw new ToolError("forbidden_tab", `Tab ${tab.id} shows a browser or extension page. Agents cannot use these pages.`);
  }

  // ---- JavaScript dialogs ------------------------------------------------

  private dialogError(tabId: number, d: PendingDialog): ToolError {
    const during = d.openedDuring ? ` It opened during ${d.openedDuring}.` : "";
    const prompt = d.defaultPrompt ? ` Default prompt text: "${clip(d.defaultPrompt)}".` : "";
    const answer = d.type === "beforeunload"
      ? `The page has unsaved changes and asks whether to leave. Answer with handle_dialog {tabId: ${tabId}, accept: false} to stay on the page; accept: true leaves the page (or closes the tab) and discards the user's unsaved changes, so only do that if the user asked for it.`
      : `Answer it with handle_dialog {tabId: ${tabId}, accept: true|false${d.type === "prompt" ? ", promptText" : ""}}.`;
    return new ToolError("dialog_open", `A JavaScript ${d.type} dialog is open on tab ${tabId} (${clip(d.url)}): "${clip(d.message)}".${during}${prompt} Calls on this tab fail until it is answered. ${answer}`);
  }

  /** Runs a call on a tab; a dialog that opens on that tab meanwhile fails the call at once with dialog_open. The call's own work is left to finish (or hang) on its own. */
  private async watchDialogs<T>(tabId: number, tool: ExtensionTool, work: () => Promise<T>, sig?: AbortSignal): Promise<T> {
    let watcher: { tool: ExtensionTool; reject: (e: ToolError) => void } | undefined;
    const opened = new Promise<never>((_, reject) => { watcher = { tool, reject }; });
    opened.catch(() => {});
    const set = this.dialogWatchers.get(tabId) ?? new Set();
    set.add(watcher!);
    this.dialogWatchers.set(tabId, set);
    // An aborted call is no longer the cause of a dialog that opens later.
    const onAbort = (): void => { set.delete(watcher!); };
    if (sig) { if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true }); }
    const running = work();
    running.catch(() => {});
    try {
      return await Promise.race([running, opened]);
    } finally {
      sig?.removeEventListener("abort", onAbort);
      set.delete(watcher!);
      if (set.size === 0 && this.dialogWatchers.get(tabId) === set) this.dialogWatchers.delete(tabId);
    }
  }

  private onDialogOpening(tabId: number, p: Record<string, unknown>, sessionId?: string): void {
    const watchers = [...(this.dialogWatchers.get(tabId) ?? [])].filter(w => w.tool !== "handle_dialog");
    const d: PendingDialog = {
      type: typeof p.type === "string" ? p.type : "alert",
      message: typeof p.message === "string" ? p.message : "",
      url: typeof p.url === "string" ? p.url : "",
      ...(typeof p.defaultPrompt === "string" && p.defaultPrompt !== "" ? { defaultPrompt: p.defaultPrompt } : {}),
      ...(watchers[0] ? { openedDuring: watchers[0].tool } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    this.dialogs.set(tabId, d);
    for (const w of watchers) w.reject(this.dialogError(tabId, d));
  }

  /** Answers the open dialog. Never called on the agent's behalf: accepting a beforeunload dialog discards the user's unsaved changes. */
  private async handleDialog(sig: AbortSignal, tabId: number, args: ToolArgs["handle_dialog"]): Promise<Content> {
    const d = this.dialogs.get(tabId);
    if (!d) throw new ToolError("bad_args", `No JavaScript dialog is open on tab ${tabId}.`);
    const params = { accept: args.accept, ...(args.promptText !== undefined && args.accept ? { promptText: args.promptText } : {}) };
    try {
      await this.cdp(sig, tabId, "Page.handleJavaScriptDialog", params, d.sessionId);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      this.dialogs.delete(tabId);
      throw new ToolError("bad_args", `No JavaScript dialog is open on tab ${tabId} any more (${(e as Error).message}).`);
    }
    if (this.dialogs.get(tabId) === d) this.dialogs.delete(tabId);
    const what = `${args.accept ? "Accepted" : "Dismissed"} the ${d.type} dialog "${clip(d.message)}".`;
    if (d.type !== "beforeunload") return text(what);
    return text(args.accept
      ? `${what} The page is leaving${d.openedDuring === "close_tab" ? " and the tab closes" : ""}; its unsaved changes are discarded.`
      : `${what} The page stays open with its changes${d.openedDuring ? `; ${d.openedDuring} did not happen` : ""}.`);
  }

  private async markControlled(tabId: number, session: UiSession): Promise<void> {
    if (this.state.paused) return;
    try { await this.ui.markControlled(tabId, session); } catch { /* visuals never fail a tool call */ }
  }

  /** Runs `fn` with the overlay hidden: agent captures and hit-testing must see the page, not our pill. Restores even when `fn` throws or the call is aborted. */
  private async hidden<T>(sig: AbortSignal, tabId: number, fn: () => Promise<T>, holdAfter = false): Promise<T> {
    this.cancelHold(tabId);
    try { await this.ui.suspend(tabId); } catch { /* best effort */ }
    // Single-use: an abort mid-call restores at once (the call result may arrive long after), and so does the normal exit.
    let restored = false;
    const restore = async (): Promise<void> => {
      if (restored) return;
      restored = true;
      try { await this.ui.restore(tabId); } catch { /* best effort */ }
    };
    const onAbort = (): void => { void restore(); };
    if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort, { once: true });
    try {
      return await fn();
    } finally {
      sig.removeEventListener("abort", onAbort);
      if (holdAfter && !sig.aborted) {
        restored = true; // the hold timer restores instead
        this.held.set(tabId, setTimeout(() => { this.held.delete(tabId); void this.restoreQuietly(tabId); }, this.hoverHold));
      } else {
        await restore();
      }
    }
  }

  private async restoreQuietly(tabId: number): Promise<void> {
    try { await this.ui.restore(tabId); } catch { /* best effort */ }
  }

  private cancelHold(tabId: number): boolean {
    const t = this.held.get(tabId);
    if (t === undefined) return false;
    clearTimeout(t);
    this.held.delete(tabId);
    return true;
  }

  /** Ends the post-hover hold early: the next non-hover call, Stop or the tab going away. */
  private async releaseHold(tabId: number): Promise<void> {
    if (this.cancelHold(tabId)) await this.restoreQuietly(tabId);
  }

  private async releaseAllHolds(): Promise<void> {
    await Promise.all([...this.held.keys()].map(id => this.releaseHold(id)));
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
    if (this.attached.has(tabId)) return this.awaitEnabled(tabId);
    const current = await this.api.tabs.get(tabId);
    if (current) this.assertDrivable(current); // last guard: no path may attach the debugger to a browser or extension page
    this.throwIfAborted(sig);
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
    const enabling = (async () => {
      for (const d of ["Page", "Runtime", "Log", "Network"]) await this.api.debugger.send(tabId, `${d}.enable`);
      // Agents work in the background and never activate a tab: focus emulation keeps a background tab rendering for CDP captures and input.
      try { await this.api.debugger.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch { /* best effort */ }
    })();
    enabling.catch(() => {});
    this.enabling.set(tabId, enabling);
    const settled = () => { if (this.enabling.get(tabId) === enabling) this.enabling.delete(tabId); };
    void enabling.then(settled, settled);
    await this.awaitEnabled(tabId);
  }

  /** Waits for the attach's enables. A page blocked by a dialog Chrome never reported answers none of them: fail fast instead of at the call timeout. */
  private async awaitEnabled(tabId: number): Promise<void> {
    const enabling = this.enabling.get(tabId);
    if (!enabling) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PageUnresponsive(tabId)), this.attachAnswer); });
    slow.catch(() => {});
    try { await Promise.race([enabling, slow]); } finally { clearTimeout(timer); }
  }

  /** `sessionId` sends the command to a cross-origin iframe of the tab instead of its top page. */
  private async cdp(sig: AbortSignal, tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    await this.ensureAttached(sig, tabId);
    this.throwIfAborted(sig);
    const result = await (sessionId === undefined ? this.api.debugger.send(tabId, method, params) : this.api.debugger.send(tabId, method, params, sessionId));
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
    this.autoAttached.delete(tabId);
    this.frameSessions.delete(tabId);
    this.dialogs.delete(tabId);
    this.enabling.delete(tabId);
  }

  private push<T>(map: Map<number, T[]>, tabId: number, item: T): void {
    const arr = map.get(tabId) ?? [];
    arr.push(item);
    if (arr.length > BUFFER_LIMIT) arr.shift();
    map.set(tabId, arr);
  }

  private onEvent(tabId: number, method: string, p: Record<string, unknown>, sessionId?: string): void {
    const ws = this.waiters.get(tabId);
    if (ws) for (const w of [...ws]) if (w.methods.includes(method) && (w.frames || sessionId === undefined)) { ws.delete(w); w.resolve({ params: p, ...(sessionId === undefined ? {} : { sessionId }) }); }
    if (method === "Target.attachedToTarget" && (p.targetInfo as { type?: string } | undefined)?.type === "iframe" && typeof p.sessionId === "string") {
      const set = this.frameSessions.get(tabId) ?? new Set();
      set.add(p.sessionId);
      this.frameSessions.set(tabId, set);
    } else if (method === "Target.detachedFromTarget" && typeof p.sessionId === "string") {
      this.frameSessions.get(tabId)?.delete(p.sessionId);
      this.autoAttached.get(tabId)?.delete(p.sessionId);
    }
    if (method === "Page.javascriptDialogOpening") this.onDialogOpening(tabId, p, sessionId);
    else if (method === "Page.javascriptDialogClosed" && this.dialogs.get(tabId)?.sessionId === sessionId) this.dialogs.delete(tabId);
    // Console, network and navigation state describe the top page only.
    if (sessionId !== undefined) return;
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

  /** Resolves with the first of `methods`, or undefined after `ms`. `frames` also accepts events from cross-origin iframes. */
  private waitForEvent(tabId: number, methods: string[], ms: number, frames = false): { promise: Promise<Waited | undefined>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const w: Waiter = { methods, frames, resolve: () => {} };
    const promise = new Promise<Waited | undefined>(resolve => {
      w.resolve = e => { if (timer) clearTimeout(timer); resolve(e); };
      timer = setTimeout(() => resolve(undefined), ms);
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
      await Promise.race([loaded.promise, new Promise<undefined>(r => sig.addEventListener("abort", () => r(undefined), { once: true }))]);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolError("tab_hidden", `Chrome did not render tab ${tabId} (minimised or hidden window). Ask the user to bring the window forward, then retry.`)), this.captureTimeout);
    });
    hung.catch(() => {});
    try {
      const r = (await Promise.race([this.cdp(sig, tabId, "Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY, clip: { x: v.x, y: v.y, width: v.w, height: v.h, scale } }), hung])) as { data: string };
      return r.data;
    } finally {
      clearTimeout(timer);
    }
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

  private async input(sig: AbortSignal, tabId: number, p: { x: number; y: number }, kind: ActionKind, sessionId: string): Promise<void> {
    this.lastPoint.set(tabId, { x: p.x, y: p.y });
    try { await this.ui.beforeAction(tabId, { x: p.x, y: p.y, kind, sessionId }, sig); } catch { /* visuals never fail a tool call */ }
    this.throwIfAborted(sig);
  }

  /** A trusted click at a page point, with the overlay out of the way. */
  private async press(sig: AbortSignal, tabId: number, p: { x: number; y: number }, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
    const base = { x: p.x, y: p.y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4 };
    await this.hidden(sig, tabId, async () => {
      await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount });
      await this.cdp(sig, tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount, buttons: 0 });
    });
  }

  // ---- upload ------------------------------------------------------------

  /**
   * Puts the files on a file input. The content comes with the call and the File objects are built in the page, so nothing
   * is read from the disk of this machine. A ref to a file input is filled directly; any other target is clicked and the
   * file chooser it opens is held back (no dialog appears) to learn which input asked for files.
   */
  private async uploadFile(sig: AbortSignal, tabId: number, args: ToolArgs["upload_file"], sessionId: string): Promise<Content> {
    let input: { backendNodeId: number; sessionId?: string } | undefined;
    if (args.ref) {
      const backendNodeId = this.refTable(tabId).byRef.get(args.ref);
      if (backendNodeId === undefined) throw new ToolError("bad_args", `Unknown ref ${args.ref}; call read_page or find first.`);
      if (await this.isFileInput(sig, tabId, backendNodeId)) input = { backendNodeId };
    }
    input ??= await this.openChooser(sig, tabId, args, sessionId);
    await this.setFiles(sig, tabId, input, args.files);
    return text(`Uploaded ${args.files.map(f => f.name).join(", ")}.`);
  }

  private async isFileInput(sig: AbortSignal, tabId: number, backendNodeId: number): Promise<boolean> {
    await this.ensureDom(sig, tabId);
    let node: { nodeName?: string; attributes?: string[] } | undefined;
    try {
      node = ((await this.cdp(sig, tabId, "DOM.describeNode", { backendNodeId })) as { node?: typeof node }).node;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError("bad_args", "The element is stale; call read_page again.");
    }
    const attrs = node?.attributes ?? [];
    const type = attrs.findIndex((name, i) => i % 2 === 0 && name.toLowerCase() === "type");
    return node?.nodeName?.toUpperCase() === "INPUT" && type >= 0 && attrs[type + 1]?.toLowerCase() === "file";
  }

  /** Clicks the target with file chooser interception on, in the page and in every cross-origin iframe, and returns the input that asked for files. */
  private async openChooser(sig: AbortSignal, tabId: number, target: { ref?: string; coordinate?: [number, number] }, actingSession: string): Promise<{ backendNodeId: number; sessionId?: string }> {
    const p = await this.target(sig, tabId, target);
    const armed = await this.interceptChoosers(sig, tabId);
    const opened = this.waitForEvent(tabId, ["Page.fileChooserOpened"], this.chooserWait, true);
    try {
      await this.input(sig, tabId, p, "click", actingSession);
      await this.press(sig, tabId, p);
      const chooser = await opened.promise;
      this.throwIfAborted(sig);
      if (!chooser) throw new ToolError("bad_args", "The click opened no file chooser. Give the file input, or the button that opens the file dialog.");
      const backendNodeId = chooser.params.backendNodeId;
      if (typeof backendNodeId !== "number") throw new ToolError("bad_args", "The page asked for files without a file input, which cannot be filled.");
      return { backendNodeId, ...(chooser.sessionId === undefined ? {} : { sessionId: chooser.sessionId }) };
    } finally {
      opened.cancel();
      // Interception is on for this call only: when the user uses the tab, their own file dialogs open as usual.
      // Sent directly: the call may already be aborted, and the dialogs must come back regardless.
      if (this.attached.has(tabId)) {
        await Promise.all(armed.map(async s => {
          try { await this.api.debugger.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }, s); } catch { /* frame or tab gone */ }
        }));
      }
    }
  }

  /** Turns file chooser interception on for the page and its cross-origin iframes; returns the sessions it is on for (undefined is the page). */
  private async interceptChoosers(sig: AbortSignal, tabId: number): Promise<Array<string | undefined>> {
    // A cross-origin iframe is its own target: its file chooser is only reported on its own session.
    const reached = this.autoAttached.get(tabId) ?? new Set();
    this.autoAttached.set(tabId, reached);
    const reach = async (sessionId?: string): Promise<void> => {
      if (reached.has(sessionId)) return;
      try { await this.cdp(sig, tabId, "Target.setAutoAttach", AUTO_ATTACH, sessionId); } catch (e) { if (e instanceof ToolError) throw e; /* no iframe support: the page itself still works */ }
      reached.add(sessionId);
    };
    await reach();
    await this.cdp(sig, tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
    const armed: Array<string | undefined> = [undefined];
    for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
      const fresh = [...(this.frameSessions.get(tabId) ?? [])].filter(s => !armed.includes(s));
      if (fresh.length === 0) break;
      for (const s of fresh) {
        armed.push(s);
        try {
          await reach(s);
          await this.cdp(sig, tabId, "Page.enable", undefined, s);
          await this.cdp(sig, tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, s);
        } catch (e) {
          if (e instanceof ToolError) throw e; // aborted; anything else means the iframe went away
        }
      }
    }
    return armed;
  }

  private async setFiles(sig: AbortSignal, tabId: number, input: { backendNodeId: number; sessionId?: string }, files: UploadFile[]): Promise<void> {
    const s = input.sessionId;
    let r: { exceptionDetails?: { exception?: { description?: string }; text?: string } };
    try {
      if (s === undefined) await this.ensureDom(sig, tabId);
      else {
        await this.cdp(sig, tabId, "DOM.enable", undefined, s);
        await this.cdp(sig, tabId, "DOM.getDocument", { depth: 0 }, s);
      }
      const node = (await this.cdp(sig, tabId, "DOM.resolveNode", { backendNodeId: input.backendNodeId }, s)) as { object?: { objectId?: string } };
      const objectId = node.object?.objectId;
      if (!objectId) throw new Error("no object");
      r = (await this.cdp(sig, tabId, "Runtime.callFunctionOn", { objectId, returnByValue: true, arguments: [{ value: files }], functionDeclaration: SET_FILES_FN }, s)) as typeof r;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError("bad_args", "The file input went away before the files were set; call read_page again.");
    }
    if (r.exceptionDetails) throw new ToolError("bad_args", (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "Cannot set the files").split("\n")[0]!.replace(/^Error: /, ""));
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

/** Runs in the page, on the file input. Builds the File objects from the content sent with the call. */
const SET_FILES_FN = `function (files) {
  const el = this;
  if (!(el instanceof HTMLInputElement) || el.type !== "file") throw new Error("The element is not a file input");
  if (el.disabled) throw new Error("The file input is disabled");
  if (files.length > 1 && !el.multiple) throw new Error("This file input takes one file");
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
  }
  el.files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.files.length;
}`;
