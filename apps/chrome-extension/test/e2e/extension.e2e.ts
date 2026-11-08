// End-to-end: real Chromium + the built extension + an in-process gateway.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   bun run test:e2e            (needs Chromium; runs this file only)
// or directly: bun test ./apps/chrome-extension/test/e2e/extension.e2e.ts
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots), AIS_E2E_TMP (scratch dir; default the OS temp dir).
// Each run builds the extension into its own scratch directory (never the shared dist/), keeps Chromium and shim stderr in
// <scratch>/logs and prints their tails when a step fails.
//
// Two agent sessions (two identities of one pool) talk to the gateway through real `ais browser mcp` shim processes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallResult } from "../../../../src/browser/protocol.ts";
import { Hono } from "hono";
import { mountBrowserAuthorize } from "../../../../src/server/browser-authorize.ts";
import { startGateway } from "../../../../src/gateway/serve.ts";
import type { RunningGateway } from "../../../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../../../src/gateway/store.ts";
import { jpegSize } from "../../src/background/executor.ts";
import { Cdp, type Session } from "./cdp.ts";

const ADMIN = "adm-e2e-value-0001-0123456789abcdef";
const extRoot = join(import.meta.dir, "../..");
const repoRoot = join(import.meta.dir, "../../../..");
const chromium = process.env.AIS_E2E_CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:48px;background:#f7f6f3;color:#222}h1{margin:0 0 24px}
button{font:inherit;padding:12px 22px;border-radius:10px;border:1px solid #bbb;background:#fff;margin:0 12px 12px 0}
#save{position:absolute;left:520px;top:300px}#go{position:absolute;left:120px;top:200px}#out{position:absolute;left:120px;top:120px}
#bottom{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);margin:0}</style>${body}`;

let gateway: RunningGateway;
let site: ReturnType<typeof Bun.serve>;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let runDir = "";
let cdp: Cdp;
let extId = "";
let sw: Session;
let ctl: Session;
const gw = () => `http://127.0.0.1:${gateway.port}`;
const admin = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${gateway.adminPort}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });
const logFiles = (): string[] => (runDir ? ["chromium.log", "shim-a.log", "shim-b.log"].map(f => join(runDir, "logs", f)) : []);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Races a step against a labelled timeout, so a hang names the step instead of timing the whole test out. */
async function step<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`step "${label}" timed out after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function dumpTails(): Promise<void> {
  for (const f of logFiles()) {
    const text = await readFile(f, "utf8").catch(() => "");
    if (text.trim()) console.error(`--- tail of ${f}\n${text.split("\n").slice(-25).join("\n")}`);
  }
}

/** A test that prints the Chromium and shim log tails when it fails. */
function it(name: string, fn: () => Promise<void>, ms = 30_000): void {
  test(name, async () => {
    try { await fn(); } catch (e) { await dumpTails(); throw e; }
  }, ms);
}

async function save(name: string, bytes: Buffer): Promise<void> {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, name), bytes);
}
const shot = async (name: string, s: Session, opts: Parameters<Session["screenshot"]>[0] = {}): Promise<void> => save(`${name}.png`, await s.screenshot(opts));

type Rpc = { result?: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } };

/** One MCP shim process (stdio JSON-RPC), as an agent CLI would run it. */
class Agent {
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Rpc) => void>();
  private readonly proc: Bun.Subprocess<"pipe", "pipe", Bun.BunFile>;

  constructor(readonly identity: string, readonly sessionId: string, configDir: string, gatewayUrl: string, logFile: string) {
    const proc = Bun.spawn(["bun", join(repoRoot, "src/ais.ts"), "browser", "mcp", "--config-dir", configDir, "--identity", identity, "--gateway", gatewayUrl], {
      cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: Bun.file(logFile), env: { ...process.env, CLAUDE_SESSION_ID: sessionId, AIS_GATEWAY_PROXY_URL: gatewayUrl },
    });
    this.proc = proc;
    void (async () => {
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("{")) continue; // anything that is not a JSON-RPC line (log noise) is skipped
          try {
            const m = JSON.parse(line) as { id?: unknown };
            if (typeof m.id === "number") this.waiting.get(m.id)?.(m as Rpc);
          } catch { /* partial or foreign line */ }
        }
      }
    })();
  }

  private rpc(label: string, ms: number, method: string, params: Record<string, unknown>): Promise<Rpc> {
    const id = this.nextId++;
    const p = new Promise<Rpc>(resolve => {
      this.waiting.set(id, resolve);
      (this.proc.stdin as { write(s: string): number }).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return step(`${this.identity} ${label}`, ms, p).finally(() => this.waiting.delete(id));
  }

  async init(): Promise<void> { await this.rpc("shim initialize", 20_000, "initialize", { protocolVersion: "2025-06-18" }); }

  /** tools/call mapped back to the relay's CallResult shape. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const r = (await this.rpc(`tools/call ${tool}`, tool === "wait" ? 130_000 : 60_000, "tools/call", { name: tool, arguments: args })).result!;
    if (r.isError) {
      const t = r.content[0]?.text ?? "";
      const i = t.indexOf(": ");
      return { id: "", ok: false, error: t.slice(0, i) as never, message: t.slice(i + 2) };
    }
    return { id: "", ok: true, content: r.content.map(c => (c.type === "image" ? { type: "image" as const, mimeType: c.mimeType as "image/jpeg", data: c.data! } : { type: "text" as const, text: c.text! })) };
  }

  stop(): void { this.proc.kill(); }
}
const agents: Record<string, Agent> = {};
const call = (a: Agent, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> => a.call(tool, args);
const textOf = (r: CallResult): string => (r.ok && r.content[0]?.type === "text" ? r.content[0].text : "");

async function targets(): Promise<Array<{ type: string; url: string; targetId: string }>> {
  return (await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>("Target.getTargets")).targetInfos;
}

async function pageSession(match: (url: string) => boolean): Promise<Session> {
  const t = await until("page target", async () => (await targets()).find(x => x.type === "page" && match(x.url)));
  return cdp.attach(t.targetId);
}

async function extensionPage(path: string): Promise<Session> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${extId}/${path}` });
  return cdp.attach(targetId);
}

/**
 * Calls a method of the in-page overlay. It lives in the extension's isolated world (closed shadow root, no page-visible
 * globals), reachable only through chrome.scripting from the service worker.
 */
const ov = <T = unknown>(tabId: number, method: string, arg: unknown = null): Promise<T> =>
  sw.eval<T>(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (m, a) => globalThis.__aisOverlay?.[m]?.(a), args: [${JSON.stringify(method)}, ${JSON.stringify(arg)}] }).then(r => r[0]?.result)`);

interface Rect { x: number; y: number; w: number; h: number }
interface Snapshot { suspended: boolean; hostVisibility: string; pill: string; pillOn: boolean; glowOn: boolean; cursor: Rect | null; stop: Rect | null }
const snapshot = (tabId: number): Promise<Snapshot | null> => ov<Snapshot | null>(tabId, "snapshot");
const centreOf = (s: Session, id: string) => s.eval<{ x: number; y: number }>(`(() => { const { left, top, width, height } = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: left + width / 2, y: top + height / 2 }; })()`);

/** Status as the side panel sees it, asked from a live extension page (the service worker cannot message itself). */
const status = () => ctl.eval<{ paused: boolean; inflight: number; status: string }>(`chrome.runtime.sendMessage({ type: "ais-status" })`);

async function trustedClick(s: Session, x: number, y: number): Promise<void> {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

describe.skipIf(!chromium)("AIS Browser extension in real Chromium", () => {
  beforeAll(async () => {
    try {
      const base = process.env.AIS_E2E_TMP ?? tmpdir();
      await mkdir(base, { recursive: true });
      runDir = await mkdtemp(join(base, "ais-e2e-"));
      await mkdir(join(runDir, "logs"), { recursive: true });
      await mkdir(join(runDir, "ext"));
      const extDir = realpathSync(join(runDir, "ext"));
      const built = Bun.spawnSync(["bun", "run", "build.ts", extDir], { cwd: extRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, AIS_E2E: "1" } }); // AIS_E2E keeps the overlay inspection hooks in this build only
      if (built.exitCode !== 0) throw new Error(`extension build failed: ${built.stderr.toString()}`);

      site = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          const body = u.pathname === "/second"
            ? `<h1>Second page</h1><p id="p">Landed.</p>`
            : `<h1>Fixture</h1><p id="out">idle</p><button id="go" onclick="out.textContent='go clicked'">Go</button><button id="save" onclick="out.textContent='save clicked'">Save</button><button id="bottom" onclick="out.textContent='bottom clicked'" onmouseenter="window.enters=(window.enters||0)+1" onmouseleave="window.leaves=(window.leaves||0)+1">Bottom</button>`;
          return new Response(page(u.pathname === "/second" ? "Second" : "Fixture", body), { headers: { "content-type": "text/html" } });
        },
      });

      const store = new MemoryGatewayStore();
      const members = ["id1", "id2"];
      gateway = await startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: ADMIN }, {
        host: "127.0.0.1",
        migrate: async () => {},
        openStore: () => store,
        browserPoolMembers: async p => (p === "main" ? members : undefined),
        browserIdentityExists: async i => (members.includes(i) ? i : undefined),
        poolMembers: async () => members,
        usageFor: async () => undefined,
        notify: () => {},
        refreshIntervalMs: 3_600_000,
        ledger: { max: 1000, flushMs: 3_600_000 },
        exit: () => {},
      });
      await step("gateway ready", 15_000, until("gateway ready", () => gateway.ready()));

      for (const [key, identity, sessionId] of [["a", "id1", "sess-a"], ["b", "id2", "sess-b"]] as const) {
        const r = await admin(`/browser/agents/${identity}/tokens`, { method: "POST", body: "{}" });
        const configDir = join(runDir, `agent-${key}`);
        await mkdir(configDir, { recursive: true });
        await writeFile(join(configDir, "ais-browser-token"), ((await r.json()) as { token: string }).token);
        agents[key] = new Agent(identity, sessionId, configDir, gw(), join(runDir, "logs", `shim-${key}.log`));
        await agents[key]!.init();
      }

      proc = Bun.spawn([
        chromium!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${join(runDir, "profile")}`, "--remote-debugging-port=0", `--load-extension=${extDir}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch", "--window-size=1280,800", "about:blank",
      ], { stdout: "ignore", stderr: Bun.file(join(runDir, "logs", "chromium.log")) });
      const wsUrl = await step("chromium start (DevToolsActivePort)", 45_000, until("DevToolsActivePort", async () => {
        const f = Bun.file(join(runDir, "profile", "DevToolsActivePort"));
        if (!(await f.exists())) return undefined;
        const [port, path] = (await f.text()).trim().split("\n");
        return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
      }, 45_000));
      cdp = await step("CDP connect", 20_000, Cdp.connect(wsUrl));
      // Unpacked extension id: first 32 hex digits of sha256(path), mapped onto a-p.
      extId = [...createHash("sha256").update(extDir).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
    } catch (e) {
      await dumpTails();
      throw e;
    }
  }, 120_000);

  afterAll(async () => {
    for (const a of Object.values(agents)) a.stop();
    try { cdp?.close(); } catch { /* gone */ }
    if (proc) { proc.kill(); await proc.exited; }
    await gateway?.stop().catch(() => {});
    site?.stop(true);
    if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Chromium helper processes may still be writing for a moment
  });

  it("signs in through the console page, then connects", async () => {
    // The console sign-in page runs in-process against the real gateway (public pair + admin approve + poll).
    const app = new Hono();
    mountBrowserAuthorize(app, { proxyUrl: gw(), adminUrl: `http://127.0.0.1:${gateway.adminPort}`, adminToken: ADMIN, relayUrl: `ws://127.0.0.1:${gateway.port}`, extensionIds: [extId], targets: async () => ({ pools: ["main"], identities: [] }) });
    const consoleSrv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      const redirect = `https://${extId}.chromiumapp.org/cb`;
      const page = await fetch(`http://127.0.0.1:${consoleSrv.port}/browser/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=e2e1&label=${encodeURIComponent("E2E profile")}`);
      const html = await page.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
      const done = await fetch(`http://127.0.0.1:${consoleSrv.port}/browser/authorize`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, redirect_uri: redirect, state: "e2e1", label: "E2E profile", target: "pool:main", action: "approve" }).toString() });
      expect(done.status).toBe(302);
      const frag = new URLSearchParams(new URL(done.headers.get("location")!).hash.slice(1));
      expect(frag.get("state")).toBe("e2e1");
      // Hand the redirect to the extension's own sign-in code, through a real extension page.
      const panel = await extensionPage("sidepanel.html");
      await until("side panel loaded", () => panel.eval<boolean>(`document.getElementById("ais-connect") !== null`));
      const swTarget = await until("extension service worker", async () => (await targets()).find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)));
      sw = await cdp.attach(swTarget.targetId);
      await sw.eval(`chrome.storage.local.set({ gatewayUrl: ${JSON.stringify(frag.get("gateway"))}, token: ${JSON.stringify(frag.get("token"))}, binding: ${JSON.stringify(frag.get("binding"))}, target: { kind: "pool", pool: ${JSON.stringify(frag.get("target_name"))} }, profileLabel: "E2E profile" })`);
      await until("connected", async () => (await sw.eval<{ status?: string }>(`chrome.storage.local.get("status")`)).status === "connected", 20_000);
      await until("panel shows Connected", () => panel.eval<boolean>(`document.getElementById("chip").textContent === "Connected"`));
      ctl = panel; // stays open: the control page messages the worker for status
    } finally {
      consoleSrv.stop(true);
    }
  }, 60_000);

  let tabA = 0;
  let tabB = 0;
  let pageA: Session;

  it("tabs_create opens one tab group per session", async () => {
    const a = JSON.parse(textOf(await call(agents.a!, "tabs_create", { url: `http://127.0.0.1:${site.port}/?s=a` }))) as { tabId: number };
    const b = JSON.parse(textOf(await call(agents.b!, "tabs_create", { url: `http://127.0.0.1:${site.port}/?s=b` }))) as { tabId: number };
    tabA = a.tabId;
    tabB = b.tabId;
    pageA = await pageSession(u => u.endsWith("/?s=a"));
    const info = await sw.eval<{ ga: number; gb: number; groups: Array<{ id: number; title: string }> }>(`(async () => ({
      ga: (await chrome.tabs.get(${tabA})).groupId, gb: (await chrome.tabs.get(${tabB})).groupId,
      groups: (await chrome.tabGroups.query({})).map(g => ({ id: g.id, title: g.title })) }))()`);
    expect(info.ga).toBeGreaterThan(0);
    expect(info.gb).toBeGreaterThan(0);
    expect(info.ga).not.toBe(info.gb);
    expect(info.groups.find(g => g.id === info.ga)?.title).toBe("main / sess-a");
    expect(info.groups.find(g => g.id === info.gb)?.title).toBe("main / sess-b");
  });

  it("agents work in the background: a capture of a background tab never changes the active tab", async () => {
    const tabInfo = (id: number) => sw.eval<{ active: boolean; groupId: number }>(`chrome.tabs.get(${id}).then(t => ({ active: t.active, groupId: t.groupId }))`);
    expect((await tabInfo(tabB)).groupId).toBeGreaterThan(0);
    // Make B the owner's tab (a user action, not an agent action), leave A in the background and capture A.
    await sw.eval(`chrome.tabs.update(${tabB}, { active: true })`);
    expect((await tabInfo(tabA)).active).toBe(false);
    const res = await call(agents.a!, "screenshot", { tabId: tabA });
    expect(res.ok ? "ok" : JSON.stringify(res)).toBe("ok");
    expect((await tabInfo(tabA)).active).toBe(false);
    expect((await tabInfo(tabB)).active).toBe(true);
    // The whole browser still answers: nothing was left wedged.
    const t0 = Date.now();
    await step("Browser.getVersion", 2000, cdp.send("Browser.getVersion"));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("navigate and screenshot (JPEG, long edge <= 1568)", async () => {
    const nav = await call(agents.a!, "navigate", { tabId: tabA, url: `http://127.0.0.1:${site.port}/second` });
    expect(textOf(nav)).toContain("/second");
    expect(await pageA.eval<string>(`document.getElementById("p").textContent`)).toBe("Landed.");
    await call(agents.a!, "navigate", { tabId: tabA, url: `http://127.0.0.1:${site.port}/?s=a` });

    await call(agents.a!, "resize", { tabId: tabA, width: 2400, height: 1400 });
    await sleep(500); // let the window settle (the headless screen may clamp the size)
    const shotRes = await call(agents.a!, "screenshot", { tabId: tabA });
    expect(shotRes.ok ? "ok" : JSON.stringify(shotRes)).toBe("ok");
    const img = shotRes.ok ? shotRes.content[0] : undefined;
    expect(img?.type).toBe("image");
    if (img?.type !== "image") throw new Error("no image");
    expect(img.mimeType).toBe("image/jpeg");
    const size = jpegSize(img.data)!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1568);
    expect(Math.max(size.width, size.height)).toBeGreaterThan(1000);
    await call(agents.a!, "resize", { tabId: tabA, width: 1280, height: 800 });
    await until("window back to 1280 wide", async () => (await pageA.eval<number>(`innerWidth`)) <= 1300);
  }, 60_000);

  it("controlled tab shows the indicator pill and border, closed off from the page", async () => {
    const agentShot = await call(agents.a!, "screenshot", { tabId: tabA });
    const img = agentShot.ok ? agentShot.content[0] : undefined;
    if (img?.type !== "image") throw new Error("no image");
    await save("agent-capture.jpg", Buffer.from(img.data, "base64"));
    // The tool result carries no overlay, but the user still sees it afterwards.
    const snap = await until("pill", async () => { const s = await snapshot(tabA); return s?.pillOn ? s : undefined; });
    expect(snap.pill).toContain("main");
    expect(snap.pill).toContain("is controlling this tab");
    expect(snap.pill).toContain("Stop");
    expect(snap.glowOn).toBe(true);
    expect(snap.suspended).toBe(false);
    expect(snap.hostVisibility).toBe("visible");
    // Page scripts see a closed, label-free host.
    const pageView = await pageA.eval<{ root: boolean; ariaHidden: string | null; html: string }>(`(() => { const h = document.getElementById("ais-browser-overlay"); return { root: h.shadowRoot !== null, ariaHidden: h.getAttribute("aria-hidden"), html: h.outerHTML }; })()`);
    expect(pageView.root).toBe(false);
    expect(pageView.ariaHidden).toBe("true");
    expect(pageView.html).not.toContain("id1");
    expect(pageView.html).not.toContain("sess-a");
    await sleep(600);
    await shot("indicator-pill-and-border", pageA);
  });

  it("click moves the cursor element onto the target and the page sees a real click", async () => {
    const tree = textOf(await call(agents.a!, "read_page", { tabId: tabA }));
    expect(tree).not.toContain("controlling this tab");
    expect(tree).not.toContain("Stop");
    const ref = (name: string) => new RegExp(`button "${name}" \\[(ref_\\d+)\\]`).exec(tree)?.[1];
    expect(ref("Go")).toBeDefined();
    const go = await centreOf(pageA, "go");
    const save = await centreOf(pageA, "save");
    const near = async (target: { x: number; y: number }) => until("cursor at target", async () => {
      const c = (await snapshot(tabA))?.cursor;
      return c && Math.abs(c.x - target.x) < 3 && Math.abs(c.y - target.y) < 3 ? c : undefined;
    }, 5000);

    const mid = ov<boolean>(tabA, "pauseCursorAt", 110);
    mid.catch(() => {});
    const first = call(agents.a!, "click", { tabId: tabA, ref: ref("Go") });
    expect(await mid).toBe(true);
    await shot("cursor-mid-move", pageA);
    await ov(tabA, "resumeAnimations");
    expect((await first).ok).toBe(true);
    const at1 = await near(go);
    expect(await pageA.eval<string>(`document.getElementById("out").textContent`)).toBe("go clicked");
    await sleep(120);
    await shot("cursor-at-target", pageA);

    expect((await call(agents.a!, "click", { tabId: tabA, ref: ref("Save") })).ok).toBe(true);
    const at2 = await near(save);
    expect(at2.x).not.toBe(at1.x);
    expect(await pageA.eval<string>(`document.getElementById("out").textContent`)).toBe("save clicked");
  });

  it("a button under the pill is clicked through the overlay, and the profile stays unpaused", async () => {
    const tree = textOf(await call(agents.a!, "read_page", { tabId: tabA }));
    const bottom = /button "Bottom" \[(ref_\d+)\]/.exec(tree)?.[1];
    expect(bottom).toBeDefined();
    // The fixture button sits where the pill is drawn: confirm that, so the test means something.
    const stop = (await snapshot(tabA))!.stop!;
    const b = await centreOf(pageA, "bottom");
    expect(Math.abs(stop.y + stop.h / 2 - b.y)).toBeLessThan(40);
    expect((await call(agents.a!, "click", { tabId: tabA, ref: bottom })).ok).toBe(true);
    expect(await pageA.eval<string>(`document.getElementById("out").textContent`)).toBe("bottom clicked");
    expect((await status()).paused).toBe(false);
    // The overlay comes back after the click.
    await until("overlay restored", async () => (await snapshot(tabA))?.hostVisibility === "visible");
  });

  it("hover keeps the overlay out of the way: the pointer is not stolen by the pill until the hold ends", async () => {
    const tree = textOf(await call(agents.a!, "read_page", { tabId: tabA }));
    const bottom = /button "Bottom" \[(ref_\d+)\]/.exec(tree)?.[1];
    expect(bottom).toBeDefined();
    await sleep(700); // pointer events caused by the previous test's overlay restore settle first
    await pageA.eval(`window.enters = 0; window.leaves = 0`);
    expect((await call(agents.a!, "hover", { tabId: tabA, ref: bottom })).ok).toBe(true);
    await sleep(600);
    expect(await pageA.eval<number>(`window.enters`)).toBe(1);
    expect(await pageA.eval<number>(`window.leaves`)).toBe(0); // the pill did not take the pointer from the page element
    expect((await snapshot(tabA))?.hostVisibility).toBe("hidden");
    await until("overlay back after the hold", async () => (await snapshot(tabA))?.hostVisibility === "visible", 4000);
  });

  it("a session cannot touch another session's tab", async () => {
    expect(await call(agents.b!, "screenshot", { tabId: tabA })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await call(agents.a!, "navigate", { tabId: tabB, url: "https://example.test/" })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect((await call(agents.b!, "screenshot", { tabId: tabB })).ok).toBe(true);
  });

  async function panel(): Promise<Session> {
    const s = await extensionPage("sidepanel.html");
    await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
    return s;
  }
  const panelHas = (s: Session, text: string) => until(`panel text "${text}"`, () => s.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`));

  it("side panel shows the connected state and the This tab section", async () => {
    const p = await panel();
    await panelHas(p, "Agents can use this browser");
    await panelHas(p, "This tab");
    expect(await p.eval<string>(`document.getElementById("chip").textContent`)).toBe("Connected");
    await sleep(300);
    await shot("sidepanel-connected", p);
    await cdp.send("Target.closeTarget", { targetId: p.targetId });
  });

  it("page scripts cannot press Stop; a trusted click on the pill does, then Resume works", async () => {
    await call(agents.a!, "screenshot", { tabId: tabA }); // brings the tab forward and makes sure the pill is up
    await until("pill", async () => (await snapshot(tabA))?.pillOn);

    const waiting = call(agents.a!, "wait", { seconds: 30 });
    await until("wait call running in the extension", async () => (await status()).inflight >= 1, 15_000);

    // Page-world attempts: the host is all the page can reach, and synthetic events never count.
    await pageA.eval(`(() => { const h = document.getElementById("ais-browser-overlay"); HTMLElement.prototype.click.call(h); h.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); })()`);
    await ov(tabA, "untrustedStopClick"); // even a synthetic click that does reach the button is ignored
    await sleep(500);
    const st = await status();
    expect(st.inflight).toBe(1);
    expect(st.paused).toBe(false);

    const stop = (await snapshot(tabA))!.stop!;
    await trustedClick(pageA, stop.x + stop.w / 2, stop.y + stop.h / 2);
    expect(await waiting).toMatchObject({ ok: false, error: "stopped_by_user" });
    await until("overlay cleared", async () => (await snapshot(tabA)) === null);
    expect(await pageA.eval<boolean>(`document.getElementById("ais-browser-overlay") === null`)).toBe(true);
    expect(await call(agents.a!, "tabs_context")).toMatchObject({ ok: false, error: "paused_by_user" });
    expect(await call(agents.b!, "tabs_context")).toMatchObject({ ok: false, error: "paused_by_user" });

    const p = await panel();
    await panelHas(p, "Paused");
    expect(await p.eval<string>(`document.getElementById("chip").textContent`)).toBe("Paused");
    await sleep(300);
    await shot("sidepanel-paused", p);
    await p.eval(`[...document.querySelectorAll("button")].find(b => b.textContent === "Resume").click()`);
    await panelHas(p, "Agents can use this browser");
    await cdp.send("Target.closeTarget", { targetId: p.targetId });

    const again = await until("calls work after Resume", async () => { const r = await call(agents.a!, "tabs_context"); return r.ok ? r : undefined; });
    expect(textOf(again)).toContain("sessionTabs");
    // The overlay returns with the next tab-scoped call.
    expect((await call(agents.a!, "screenshot", { tabId: tabA })).ok).toBe(true);
    await until("pill back", async () => (await snapshot(tabA))?.pillOn);
  }, 90_000);

  it("side panel signed-out state", async () => {
    const p = await panel();
    await sw.eval(`chrome.storage.local.remove(["token", "binding", "target"])`);
    await panelHas(p, "Connect this browser");
    await sleep(300);
    await shot("sidepanel-signed-out", p);
    await cdp.send("Target.closeTarget", { targetId: p.targetId });
  });
});
