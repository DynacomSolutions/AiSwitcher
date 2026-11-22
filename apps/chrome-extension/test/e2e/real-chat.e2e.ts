// Opt-in proof: the side-panel chat against a real gateway and real agent pods, with real Chromium.
//
// Never run in CI and never part of `bun run test:e2e`. It is skipped unless every variable below is set. All values come from the
// operator's environment; nothing in this file names a host, an account or an identity.
//
//   AIS_E2E_REAL_GATEWAY_URL   base URL of the gateway public routes (pairing and the extension socket), as the browser reaches it
//   AIS_E2E_REAL_ADMIN_URL     base URL of the gateway admin routes
//   AIS_E2E_REAL_ADMIN_TOKEN   admin bearer token
//   AIS_E2E_REAL_TARGET        browser binding target: `identity:<name>` or `pool:<name>`
//   AIS_E2E_REAL_IDENTITY      identity for the chat pods (must be in the gateway's chat catalogue for each provider)
// Optional:
//   AIS_E2E_REAL_RELAY_URL     wss:// base URL the extension connects to (the extension accepts only wss://, or ws:// on localhost).
//                              Default: AIS_E2E_REAL_GATEWAY_URL with http turned into ws, which works only for a localhost gateway.
//   AIS_E2E_REAL_IDENTITY_<PROVIDER>  identity for one provider (for example ..._CLAUDE), instead of AIS_E2E_REAL_IDENTITY
//   AIS_E2E_REAL_PROVIDERS     comma list, default `claude,codex`
//   AIS_E2E_REAL_HOOK          shell command run at named phases with HOOK_PHASE, HOOK_PROVIDER and HOOK_CHAT in its environment.
//                              Phases: chat-ready, turn-running, before-close, after-close, two-chats.
//                              The operator uses it for cluster side checks (and to delete one gateway pod in `turn-running`).
//   AIS_E2E_REAL_CASES         comma list of cases to run after pairing: `provider` (one chat per provider), `two` (two chats on one tab),
//                              `restart` (a long turn, the hook at `turn-running`, then the next prompt must answer). Default: `provider,two`
//   AIS_E2E_CHROMIUM, AIS_E2E_EVIDENCE, AIS_E2E_TMP as for the other e2e files.
//
// Run from the repo root:  bun test ./apps/chrome-extension/test/e2e/real-chat.e2e.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Cdp, Session } from "./cdp.ts";
import * as H from "./harness.ts";
import { chromium, dumpLogs, save, sleep, until } from "./harness.ts";

const env = process.env;
const GATEWAY = env.AIS_E2E_REAL_GATEWAY_URL;
const ADMIN_URL = env.AIS_E2E_REAL_ADMIN_URL;
const ADMIN_TOKEN = env.AIS_E2E_REAL_ADMIN_TOKEN;
const TARGET = env.AIS_E2E_REAL_TARGET;
const IDENTITY = env.AIS_E2E_REAL_IDENTITY;
const HOOK = env.AIS_E2E_REAL_HOOK;
const CASES = (env.AIS_E2E_REAL_CASES ?? "provider,two").split(",").map(s => s.trim());
const PROVIDERS = (env.AIS_E2E_REAL_PROVIDERS ?? "claude,codex").split(",").map(s => s.trim()).filter(Boolean);
const ready = Boolean(chromium && GATEWAY && ADMIN_URL && ADMIN_TOKEN && TARGET && IDENTITY);

const TITLE = "Real Chat Proof Page";
const PROMPT = "Read the title of the linked page and tell me it";
const MINUTE = 60_000;

let site: ReturnType<typeof Bun.serve>;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let runDir = "";
let cdp: Cdp;
let extId = "";
let sw: Session;
let P: Session;
let binding = "";
let tabA = 0;
let tabB = 0;
let windowId = 0;
const opened: string[] = [];

const siteUrl = (path: string) => `http://127.0.0.1:${site.port}${path}`;
const trim = (u: string) => u.replace(/\/+$/, "");

interface HubItem { seq: number; body: { k: string; text?: string; title?: string; status?: string; result?: string; code?: string; message?: string; args?: string; requestId?: string; options?: Array<{ id: string; kind: string }>; resolved?: unknown; stopReason?: string } }
interface HubChat { summary: { chatId: string; name: string; state: string; tabIds: number[]; selection: { provider: string } }; items: HubItem[] }
const hub = async (): Promise<HubChat[]> => {
  const r = await sw.eval<{ chatHub?: { chats: Array<{ view: HubChat }> } }>(`chrome.storage.session.get("chatHub")`);
  return (r.chatHub?.chats ?? []).map(c => c.view);
};
const chatById = async (id: string): Promise<HubChat | undefined> => (await hub()).find(c => c.summary.chatId === id);
const send = (msg: Record<string, unknown>) => P.eval<{ ok: boolean; error?: string }>(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

/** Runs the operator hook, when set. Its output goes to the test log and to the evidence folder. */
async function hook(phase: string, provider: string, chat: string): Promise<void> {
  if (!HOOK) return;
  const p = Bun.spawn(["sh", "-c", HOOK], { env: { ...env, HOOK_PHASE: phase, HOOK_PROVIDER: provider, HOOK_CHAT: chat }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const text = `# hook ${phase} ${provider}\n${out}${err ? `\n[stderr]\n${err}` : ""}\n`;
  console.log(text);
  await save(`hook-${provider}-${phase}-${Date.now()}.txt`, Buffer.from(text));
}

/** Answers every permission ask of the chat with its first allow option, as the user would in the panel. */
async function allowAsks(chatId: string): Promise<void> {
  const c = await chatById(chatId);
  for (const i of c?.items ?? []) {
    const b = i.body;
    if (b.k !== "permission" || b.resolved || !b.requestId) continue;
    const allow = b.options?.find(o => o.kind.startsWith("allow"));
    if (allow) await send({ type: "ais-chat-permission", chatId, requestId: b.requestId, optionId: allow.id });
  }
}

const userCount = (c: HubChat | undefined) => c?.items.filter(i => i.body.k === "user").length ?? 0;
const lastTurn = (c: HubChat | undefined): HubItem[] => {
  const items = c?.items ?? [];
  return items.slice(items.map(i => i.body.k).lastIndexOf("user") + 1);
};
const replyOf = (c: HubChat | undefined): string => lastTurn(c).filter(i => i.body.k === "text").map(i => i.body.text).join("");
const isIdle = (c: HubChat | undefined, prompts: number): boolean => c !== undefined && userCount(c) === prompts && c.summary.state === "idle" && c.items.at(-1)?.body.k === "turn_end";

/** Waits for the turn of the `prompts`-th prompt to end, answering permission asks on the way. Polls cursors when asked. */
async function turnDone(chatId: string, prompts: number, ms: number, onTick?: () => Promise<void>): Promise<HubChat> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await allowAsks(chatId);
    await onTick?.();
    const c = await chatById(chatId);
    // A turn that ends with an error item has no turn_end: that error item is the end, and the wait fails at once.
    if (lastTurn(c).some(i => i.body.k === "error")) throw new Error(`the turn ended with an error:\n${describeChat(c)}`);
    if (c?.summary.state === "failed") throw new Error(`chat failed:\n${describeChat(c)}`); // fail at once: no retry inside a wait helper
    if (isIdle(c, prompts)) return c!;
    await sleep(500);
  }
  throw new Error(`turn ${prompts} of ${chatId} did not end in ${ms} ms`);
}

async function prompt(chatId: string, text: string): Promise<void> {
  const r = await send({ type: "ais-chat-prompt", chatId, text });
  if (!r.ok) throw new Error(`prompt refused: ${r.error}`);
}

async function createChat(provider: string, tabIds: number[]): Promise<string> {
  const before = new Set((await hub()).map(c => c.summary.chatId));
  const r = await send({ type: "ais-chat-create", windowId, selection: { provider, identity: env[`AIS_E2E_REAL_IDENTITY_${provider.toUpperCase()}`] ?? IDENTITY }, tabIds });
  if (!r.ok) throw new Error(`create refused: ${r.error}`);
  const c = await until(`${provider} chat in the worker`, async () => (await hub()).find(x => !before.has(x.summary.chatId) && x.summary.selection.provider === provider));
  opened.push(c.summary.chatId);
  return c.summary.chatId;
}

async function closeChat(chatId: string): Promise<void> {
  const r = await send({ type: "ais-chat-close", chatId });
  expect(r.ok).toBe(true);
  const i = opened.indexOf(chatId);
  if (i >= 0) opened.splice(i, 1);
}

interface Snap { cursors: Array<{ sessionId: string; tag: string; colour: string }> }
const snapshot = (tabId: number) => sw.eval<Snap | null>(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => globalThis.__aisOverlay?.snapshot?.() }).then(r => r[0]?.result ?? null)`);

/** Opens the chat in the panel (list, then the row) so the feed renders. */
async function showChat(name: string): Promise<void> {
  await P.send("Page.bringToFront");
  await until(`open ${name}`, () => P.eval<boolean>(`(() => {
    const d = document.querySelector(".chat-detail");
    if (!d.hidden) { if (d.querySelector(".chat-name").textContent === ${JSON.stringify(name)}) return true; [...d.querySelectorAll("button")].find(b => b.textContent === "Back").click(); }
    const row = [...document.querySelectorAll(".chat-row .row-open")].find(b => b.querySelector(".title").textContent === ${JSON.stringify(name)});
    if (!row) return false; row["click"](); return true; })()`), 60_000);
  await sleep(600);
}
const shot = async (name: string): Promise<void> => { await P.send("Page.bringToFront"); await sleep(400); await save(`${name}.png`, await P.screenshot()); };
const feedText = (): Promise<string> => P.eval<string>(`document.querySelector(".chat-detail:not([hidden]) .feed")?.innerText ?? document.querySelector(".chat-detail:not([hidden])")?.innerText ?? ""`);
const saveFeed = async (name: string): Promise<void> => { await save(`${name}.txt`, Buffer.from(`${await feedText()}\n`)); };

/** The raw feed items of a chat as a short text, for evidence and failure output. */
const describeChat = (c: HubChat | undefined): string => (c?.items ?? []).map(i => {
  const b = i.body;
  return b.k === "error" ? `error ${b.code}: ${b.message}` : b.k === "tool" ? `tool ${b.title} [${b.status}] ${(b.result ?? "").slice(0, 160)}` : `${b.k}${b.text ? `: ${b.text.slice(0, 300)}` : ""}${b.stopReason ? ` (${b.stopReason})` : ""}`;
}).join("\n");

/** The state of every chat, printed when a test fails. */
async function dumpChats(): Promise<void> {
  try { for (const c of await hub()) console.error(`chat ${c.summary.name} [${c.summary.selection.provider}] id=${c.summary.chatId} state=${c.summary.state} updatedAt=${(c.summary as { updatedAt?: number }).updatedAt}\n${describeChat(c)}`); } catch { /* worker gone */ }
}

function it(name: string, fn: () => Promise<void>, ms = 20 * MINUTE): void {
  test(name, async () => {
    try { await fn(); } catch (e) { await dumpLogs(runDir ? [join(runDir, "logs", "chromium.log")] : []); await dumpChats(); throw e; }
  }, ms);
}

describe.skipIf(!ready)("Side-panel chat against a real gateway and real pods", () => {
  beforeAll(async () => {
    runDir = await H.makeRunDir();
    const extDir = await H.buildExtension(runDir);
    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const page = (title: string, h1: string) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:18px system-ui;padding:48px"><h1>${h1}</h1><p>Fixture page for the real chat proof.</p><button id="go">Go</button></body>`, { headers: { "content-type": "text/html" } });
        return u.pathname === "/b" ? page("Unlinked Page", "Unlinked") : page(TITLE, "Linked page");
      },
    });
    const b = await H.launchChromium(runDir, extDir);
    proc = b.proc;
    cdp = b.cdp;
    extId = b.extId;
  }, 10 * MINUTE);

  afterAll(async () => {
    // Close what is left of the chats, then revoke the temporary binding, whatever happened.
    for (const id of [...opened]) { try { await send({ type: "ais-chat-close", chatId: id }); } catch { /* already gone */ } }
    if (ADMIN_URL && ADMIN_TOKEN && binding) {
      const r = await fetch(`${trim(ADMIN_URL)}/browser/bindings/${encodeURIComponent(binding)}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }).catch(() => undefined);
      console.log(`binding revoked: HTTP ${r?.status ?? "none"}`);
    }
    try { cdp?.close(); } catch { /* gone */ }
    if (proc) { proc.kill(); await proc.exited; }
    site?.stop(true);
    if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, 5 * MINUTE);

  it("pairs a temporary binding through the public and admin routes and signs the extension in", async () => {
    const kind = TARGET!.startsWith("pool:") ? "pool" : "identity";
    const name = TARGET!.slice(TARGET!.indexOf(":") + 1);
    const json = { "content-type": "application/json" };
    const start = await fetch(`${trim(GATEWAY!)}/browser/pair`, { method: "POST", headers: json, body: JSON.stringify({ profileLabel: "Real chat proof" }) });
    expect(start.status).toBe(200);
    const { code, pollSecret } = (await start.json()) as { code: string; pollSecret: string };
    const approve = await fetch(`${trim(ADMIN_URL!)}/browser/pairings/${encodeURIComponent(code)}/approve`, { method: "POST", headers: { ...json, authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ target: kind === "pool" ? { kind, pool: name } : { kind, identity: name } }) });
    expect(approve.status).toBe(200);
    const poll = await fetch(`${trim(GATEWAY!)}/browser/pair/poll`, { method: "POST", headers: json, body: JSON.stringify({ code, pollSecret }) });
    const got = (await poll.json()) as { token: string; binding: string; target: { kind: string; pool?: string; identity?: string } };
    expect(poll.status).toBe(200);
    binding = got.binding; // revoked in afterAll
    const relay = trim(env.AIS_E2E_REAL_RELAY_URL ?? GATEWAY!.replace(/^http/, "ws"));
    const panel = await H.extensionPage(cdp, extId, "sidepanel.html");
    await until("side panel loaded", () => panel.eval<boolean>(`document.getElementById("ais-connect") !== null`), 3 * MINUTE);
    const swTarget = await until("extension service worker", async () => (await H.targets(cdp)).find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)), MINUTE);
    sw = await cdp.attach(swTarget.targetId);
    const t = got.target;
    await sw.eval(`chrome.storage.local.set({ gatewayUrl: ${JSON.stringify(relay)}, token: ${JSON.stringify(got.token)}, binding: ${JSON.stringify(got.binding)}, target: ${JSON.stringify(t.kind === "pool" ? { kind: "pool", pool: t.pool } : { kind: "identity", identity: t.identity })}, profileLabel: "Real chat proof" })`);
    try {
      await until("connected", async () => (await sw.eval<{ status?: string }>(`chrome.storage.local.get("status")`)).status === "connected", 3 * MINUTE);
    } catch (e) {
      const st = await sw.eval<Record<string, unknown>>(`chrome.storage.local.get(null)`);
      delete st.token; // never print the token
      console.error("extension storage at the failure:", JSON.stringify(st));
      throw e;
    }
    const a = await sw.eval<number>(`chrome.tabs.create({ url: ${JSON.stringify(siteUrl("/a"))}, active: false }).then(t => t.id)`);
    const b = await sw.eval<number>(`chrome.tabs.create({ url: ${JSON.stringify(siteUrl("/b"))}, active: false }).then(t => t.id)`);
    tabA = a; tabB = b;
    windowId = await sw.eval<number>(`chrome.windows.getCurrent().then(w => w.id)`);
    await sw.eval(`chrome.tabs.update(${tabA}, { active: true })`);
    P = await H.extensionPage(cdp, extId, "sidepanel.html");
    await P.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
    await P.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await until("chat list", () => P.eval<boolean>(`document.querySelector("#chat .chat-list") !== null`), 3 * MINUTE);
  });

  for (const provider of CASES.includes("provider") ? PROVIDERS : []) {
    it(`${provider}: names the page title, shows a browser tool card and a cursor, refuses an unlinked tab, then closes clean`, async () => {
      const id = await createChat(provider, [tabA]);
      const name = (await chatById(id))!.summary.name;
      await showChat(name);
      await prompt(id, PROMPT);
      await hook("chat-ready", provider, id);
      const c = await turnDone(id, 1, 15 * MINUTE);
      await shot(`${provider}-feed-title`);
      await saveFeed(`${provider}-feed-title`);
      await save(`${provider}-items-title.txt`, Buffer.from(`${describeChat(c)}\n`));
      expect(replyOf(c)).toContain(TITLE);
      const tool = lastTurn(c).find(i => i.body.k === "tool" && /read_page|tabs_context/.test(`${i.body.title ?? ""} ${i.body.args ?? ""}`));
      expect(tool).toBeDefined();
      expect(await P.eval<boolean>(`document.querySelector(".chat-detail:not([hidden]) .msg.tool") !== null`)).toBe(true);

      // The cursor shows when the agent points at the page, so this turn asks for a click on the Go button.
      let cursor: { tag: string; sessionId: string } | undefined;
      await prompt(id, "Click the button labelled Go on the linked page, then say clicked.");
      const cc = await turnDone(id, 2, 15 * MINUTE, async () => {
        const s = await snapshot(tabA).catch(() => null);
        cursor ??= s?.cursors.find(x => x.sessionId === `chat:${id}`);
      });
      await shot(`${provider}-feed-click`);
      await saveFeed(`${provider}-feed-click`);
      await save(`${provider}-items-click.txt`, Buffer.from(`${describeChat(cc)}\n`));
      expect(cursor, "the cursor of this chat was never seen on the linked tab").toBeDefined();
      await save(`${provider}-cursor.txt`, Buffer.from(`${JSON.stringify(cursor)}\n`));

      // A tab that the chat does not link: the browser call must fail.
      await prompt(id, `Call the browser tool read_page on tab id ${tabB} and report its exact result or error. Do not use any other tool.`);
      const c2 = await turnDone(id, 3, 15 * MINUTE);
      await shot(`${provider}-feed-unlinked`);
      await saveFeed(`${provider}-feed-unlinked`);
      await save(`${provider}-items-unlinked.txt`, Buffer.from(`${describeChat(c2)}\n`));
      const failed = lastTurn(c2).filter(i => i.body.k === "tool" && new RegExp(String(tabB)).test(i.body.args ?? "")).some(i => i.body.status === "failed" || /not linked|not_linked|not allowed|no access|denied/i.test(i.body.result ?? ""));
      expect(failed, "the call on the unlinked tab did not fail").toBe(true);
      expect(replyOf(c2)).not.toContain("Unlinked Page");

      await hook("before-close", provider, id);
      await closeChat(id);
      await sleep(5_000);
      await hook("after-close", provider, id);
    });
  }

  if (CASES.includes("two")) {
    it("two chats on one tab show two cursors", async () => {
      const [one, two] = [PROVIDERS[0]!, PROVIDERS[1] ?? PROVIDERS[0]!];
      const a = await createChat(one, [tabA]);
      const b = await createChat(two, [tabA]);
      const wait = "Click the button labelled Go on the linked page six times, one after the other, then say done.";
      await prompt(a, wait);
      await prompt(b, wait);
      const seen = new Map<string, string>();
      let both = false;
      const tick = async (): Promise<void> => {
        const s = await snapshot(tabA).catch(() => null);
        for (const c of s?.cursors ?? []) seen.set(c.sessionId, c.colour);
        if (s?.cursors.some(c => c.sessionId === `chat:${a}`) && s.cursors.some(c => c.sessionId === `chat:${b}`)) both = true; // both in one snapshot
      };
      await Promise.all([turnDone(a, 1, 20 * MINUTE, tick), turnDone(b, 1, 20 * MINUTE, tick)]);
      await hook("two-chats", `${one}+${two}`, a);
      await save("two-cursors.txt", Buffer.from(`${JSON.stringify([...seen])}\nboth seen together: ${both}\n`));
      await showChat((await chatById(a))!.summary.name);
      await shot("two-chats-first");
      expect(seen.has(`chat:${a}`) && seen.has(`chat:${b}`), "a cursor of one chat was never seen").toBe(true);
      expect(new Set(seen.values()).size).toBe(2);
      await closeChat(a);
      await closeChat(b);
    });
  }

  if (CASES.includes("restart")) {
    it("a gateway pod removed during a turn: the turn ends or the feed shows the restart notice, and the next prompt answers", async () => {
      const provider = PROVIDERS[0]!;
      const id = await createChat(provider, [tabA]);
      await showChat((await chatById(id))!.summary.name);
      await prompt(id, "Click the button labelled Go on the linked page ten times, one after the other, then say finished.");
      await until("turn running", async () => (await chatById(id))?.summary.state === "thinking" || lastTurn(await chatById(id)).some(i => i.body.k === "tool"), 10 * MINUTE);
      await hook("turn-running", provider, id);
      await sleep(5_000);
      await shot(`${provider}-restart-during`);
      const mid = await until("the turn to end after the pod went", async () => { await allowAsks(id); const c = await chatById(id); return isIdle(c, 1) ? c : undefined; }, 15 * MINUTE);
      await saveFeed(`${provider}-restart-feed-1`);
      await save(`${provider}-restart-items-1.txt`, Buffer.from(`${describeChat(mid)}\n`));
      await prompt(id, "Reply with the single word pong.");
      const end = await turnDone(id, 2, 15 * MINUTE);
      await saveFeed(`${provider}-restart-feed-2`);
      await save(`${provider}-restart-items-2.txt`, Buffer.from(`${describeChat(end)}\n`));
      await shot(`${provider}-restart-after`);
      expect(replyOf(end).toLowerCase()).toContain("pong");
      await closeChat(id);
    });
  }
});
