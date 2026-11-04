// End-to-end: real Chromium + the built extension + an in-process gateway.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run with:
//   bun run test:e2e            (from the repo root; needs Chromium)
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots), AIS_E2E_TMP (scratch dir for the browser profile).
//
// Two agent sessions (two identities of one pool) talk to the gateway through real `ais browser mcp` shim processes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallResult } from "../../../../src/browser/protocol.ts";
import { startGateway } from "../../../../src/gateway/serve.ts";
import type { RunningGateway } from "../../../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../../../src/gateway/store.ts";
import { jpegSize } from "../../src/background/executor.ts";
import { Cdp, type Session } from "./cdp.ts";

const ADMIN = "adm-e2e-value-0001-0123456789abcdef";
const extDir = join(import.meta.dir, "../../dist");
const repoRoot = join(import.meta.dir, "../../../..");
const chromium = process.env.AIS_E2E_CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;padding:48px;background:#f7f6f3;color:#222}h1{margin:0 0 24px}
button{font:inherit;padding:12px 22px;border-radius:10px;border:1px solid #bbb;background:#fff;margin:0 12px 12px 0}
#save{position:absolute;left:520px;top:300px}#go{position:absolute;left:120px;top:200px}#out{position:absolute;left:120px;top:120px}</style>${body}`;

let gateway: RunningGateway;
let site: ReturnType<typeof Bun.serve>;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let profile = "";
let cdp: Cdp;
let extId = "";
let sw: Session;
const gw = () => `http://127.0.0.1:${gateway.port}`;
const admin = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${gateway.adminPort}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function shot(name: string, s: Session, opts: Parameters<Session["screenshot"]>[0] = {}): Promise<void> {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, `${name}.png`), await s.screenshot(opts));
}

/** One MCP shim process (stdio JSON-RPC), as an agent CLI would run it. */
class Agent {
  private nextId = 1;
  private readonly waiting = new Map<number, (r: { result?: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } }) => void>();
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "ignore">;

  constructor(readonly identity: string, readonly sessionId: string, configDir: string, gatewayUrl: string) {
    const proc = Bun.spawn(["bun", join(repoRoot, "src/ais.ts"), "browser", "mcp", "--config-dir", configDir, "--identity", identity, "--gateway", gatewayUrl], {
      cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, CLAUDE_SESSION_ID: sessionId, AIS_GATEWAY_PROXY_URL: gatewayUrl },
    });
    this.proc = proc;
    void (async () => {
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += new TextDecoder().decode(chunk);
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = JSON.parse(line) as { id: number };
          this.waiting.get(m.id)?.(m as never);
        }
      }
    })();
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<{ result?: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } }> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.waiting.set(id, resolve);
      (this.proc.stdin as { write(s: string): number }).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async init(): Promise<void> { await this.rpc("initialize", { protocolVersion: "2025-06-18" }); }

  /** tools/call mapped back to the relay's CallResult shape. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const r = (await this.rpc("tools/call", { name: tool, arguments: args })).result!;
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

async function pageSession(match: (url: string) => boolean): Promise<Session> {
  const t = await until("page target", async () => (await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>("Target.getTargets")).targetInfos.find(x => x.type === "page" && match(x.url)));
  return cdp.attach(t.targetId);
}

const overlay = (s: Session, expr: string) => s.eval(`(() => { const r = document.getElementById("ais-browser-overlay")?.shadowRoot; return r ? (${expr}) : null; })()`);
const cursorRect = (s: Session) => overlay(s, `(() => { const { left, top } = r.querySelector(".cursor").getBoundingClientRect(); return { x: left, y: top }; })()`) as Promise<{ x: number; y: number } | null>;
const centreOf = (s: Session, id: string) => s.eval<{ x: number; y: number }>(`(() => { const { left, top, width, height } = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: left + width / 2, y: top + height / 2 }; })()`);

describe.skipIf(!chromium)("AIS Browser extension in real Chromium", () => {
  beforeAll(async () => {
    const built = Bun.spawnSync(["bun", "run", "build.ts"], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`extension build failed: ${built.stderr.toString()}`);

    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const body = u.pathname === "/second"
          ? `<h1>Second page</h1><p id="p">Landed.</p>`
          : `<h1>Fixture</h1><p id="out">idle</p><button id="go" onclick="out.textContent='go clicked'">Go</button><button id="save" onclick="out.textContent='save clicked'">Save</button>`;
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
    await until("gateway ready", () => gateway.ready());

    const base = process.env.AIS_E2E_TMP ?? tmpdir();
    await mkdir(base, { recursive: true });
    profile = await mkdtemp(join(base, "ais-e2e-profile-"));
    for (const [key, identity, sessionId] of [["a", "id1", "sess-a"], ["b", "id2", "sess-b"]] as const) {
      const r = await admin(`/browser/agents/${identity}/tokens`, { method: "POST", body: "{}" });
      const configDir = join(profile, `agent-${key}`);
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "ais-browser-token"), ((await r.json()) as { token: string }).token);
      agents[key] = new Agent(identity, sessionId, configDir, gw());
      await agents[key]!.init();
    }

    proc = Bun.spawn([
      chromium!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--load-extension=${extDir}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch", "--window-size=1280,800", "about:blank",
    ], { stdout: "ignore", stderr: "ignore" });
    const wsUrl = await until("DevToolsActivePort", async () => {
      const f = Bun.file(join(profile, "DevToolsActivePort"));
      if (!(await f.exists())) return undefined;
      const [port, path] = (await f.text()).trim().split("\n");
      return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
    });
    cdp = await Cdp.connect(wsUrl);
    // Unpacked extension id: first 32 hex digits of sha256(path), mapped onto a-p.
    extId = [...createHash("sha256").update(extDir).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
  }, 60_000);

  afterAll(async () => {
    for (const a of Object.values(agents)) a.stop();
    try { cdp?.close(); } catch { /* gone */ }
    if (proc) { proc.kill(); await proc.exited; }
    await gateway?.stop().catch(() => {});
    site?.stop(true);
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  test("pairs through the options page, then connects", async () => {
    const opts = await (async () => {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
      return cdp.attach(targetId);
    })();
    // The options page messages the worker, which starts it; only then does its target exist.
    const swTarget = await until("extension service worker", async () => (await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>("Target.getTargets")).targetInfos.find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)));
    sw = await cdp.attach(swTarget.targetId);
    await opts.eval(`(() => { document.getElementById("gateway").value = ${JSON.stringify(`ws://127.0.0.1:${gateway.port}`)}; document.getElementById("label").value = "E2E profile"; document.getElementById("signin").click(); })()`);
    const code = await until("pairing code", () => opts.eval<string>(`document.getElementById("code").textContent`));
    const approve = await admin(`/browser/pairings/${code}/approve`, { method: "POST", body: JSON.stringify({ target: { kind: "pool", pool: "main" } }) });
    expect(approve.status).toBe(200);
    await until("connected", async () => (await sw.eval<{ status?: string }>(`chrome.storage.local.get("status")`)).status === "connected", 20_000).catch(async e => {
      throw new Error(`${e.message}; error=${await opts.eval(`document.getElementById("error").textContent + "|" + document.getElementById("pairing").hidden`)}; storage=${JSON.stringify(await sw.eval(`chrome.storage.local.get(null)`)).replace(/"token":"[^"]*"/, '"token":"..."')}`);
    });
    await opts.eval(`document.getElementById("status").textContent`).then(t => expect(String(t)).toContain("pool main"));
    await cdp.send("Target.closeTarget", { targetId: opts.targetId });
  }, 60_000);

  let tabA = 0;
  let tabB = 0;
  let pageA: Session;
  let pageB: Session;

  test("tabs_create opens one tab group per session", async () => {
    const a = JSON.parse(textOf(await call(agents.a!, "tabs_create", { url: `http://127.0.0.1:${site.port}/?s=a` }))) as { tabId: number };
    const b = JSON.parse(textOf(await call(agents.b!, "tabs_create", { url: `http://127.0.0.1:${site.port}/?s=b` }))) as { tabId: number };
    tabA = a.tabId;
    tabB = b.tabId;
    pageA = await pageSession(u => u.endsWith("/?s=a"));
    pageB = await pageSession(u => u.endsWith("/?s=b"));
    const info = await sw.eval<{ ga: number; gb: number; groups: Array<{ id: number; title: string }> }>(`(async () => ({
      ga: (await chrome.tabs.get(${tabA})).groupId, gb: (await chrome.tabs.get(${tabB})).groupId,
      groups: (await chrome.tabGroups.query({})).map(g => ({ id: g.id, title: g.title })) }))()`);
    expect(info.ga).toBeGreaterThan(0);
    expect(info.gb).toBeGreaterThan(0);
    expect(info.ga).not.toBe(info.gb);
    expect(info.groups.find(g => g.id === info.ga)?.title).toBe("id1 / sess-a");
    expect(info.groups.find(g => g.id === info.gb)?.title).toBe("id2 / sess-b");
  }, 30_000);

  test("navigate and screenshot (JPEG, long edge <= 1568)", async () => {
    const nav = await call(agents.a!, "navigate", { tabId: tabA, url: `http://127.0.0.1:${site.port}/second` });
    expect(textOf(nav)).toContain("/second");
    expect(await pageA.eval<string>(`document.getElementById("p").textContent`)).toBe("Landed.");
    await call(agents.a!, "navigate", { tabId: tabA, url: `http://127.0.0.1:${site.port}/?s=a` });

    await call(agents.a!, "resize", { tabId: tabA, width: 2400, height: 1400 });
    const shotRes = await call(agents.a!, "screenshot", { tabId: tabA });
    expect(shotRes.ok).toBe(true);
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

  test("controlled tab shows the indicator pill and border", async () => {
    await call(agents.a!, "screenshot", { tabId: tabA });
    const pill = await until("pill", () => overlay(pageA, `r.querySelector(".pill.on")?.textContent ?? ""`) as Promise<string>);
    expect(pill).toContain("id1");
    expect(pill).toContain("is controlling this tab");
    expect(pill).toContain("Stop");
    expect(await overlay(pageA, `r.querySelector(".glow.on") !== null`)).toBe(true);
    await sleep(600);
    await shot("indicator-pill-and-border", pageA);
  }, 30_000);

  test("click moves the cursor element onto the target and the page sees a real click", async () => {
    const tree = textOf(await call(agents.a!, "read_page", { tabId: tabA }));
    const ref = (name: string) => new RegExp(`button "${name}" \\[(ref_\\d+)\\]`).exec(tree)?.[1];
    expect(ref("Go")).toBeDefined();
    const go = await centreOf(pageA, "go");
    const save = await centreOf(pageA, "save");

    // Agent tabs open in the background; a hidden page does not run animation frames, so bring this one forward like a user watching it.
    await cdp.send("Target.activateTarget", { targetId: pageA.targetId });
    await until("tab visible", () => pageA.eval<boolean>(`document.visibilityState === "visible"`));
    // Freeze the glide part-way through (in the page, no timing luck needed), capture, then let it finish.
    await pageA.eval(`void (window.__mid = new Promise(resolve => {
      const tick = () => {
        const r = document.getElementById("ais-browser-overlay")?.shadowRoot;
        const a = r?.getAnimations().find(x => x.effect?.target?.classList?.contains("cursor") && x.playState === "running" && Number(x.currentTime) >= 110);
        if (a) { a.pause(); resolve(true); } else requestAnimationFrame(tick);
      };
      tick();
    }))`);
    const first = call(agents.a!, "click", { tabId: tabA, ref: ref("Go") });
    await pageA.eval(`window.__mid`);
    await shot("cursor-mid-move", pageA);
    await pageA.eval(`document.getElementById("ais-browser-overlay").shadowRoot.getAnimations().filter(a => a.playState === "paused").forEach(a => a.play())`);
    expect((await first).ok).toBe(true);
    const at1 = (await cursorRect(pageA))!;
    expect(Math.abs(at1.x - go.x)).toBeLessThan(3);
    expect(Math.abs(at1.y - go.y)).toBeLessThan(3);
    expect(await pageA.eval<string>(`document.getElementById("out").textContent`)).toBe("go clicked");
    await shot("cursor-at-target", pageA);

    expect((await call(agents.a!, "click", { tabId: tabA, ref: ref("Save") })).ok).toBe(true);
    const at2 = (await cursorRect(pageA))!;
    expect(Math.abs(at2.x - save.x)).toBeLessThan(3);
    expect(Math.abs(at2.y - save.y)).toBeLessThan(3);
    expect(at2.x).not.toBe(at1.x);
    expect(await pageA.eval<string>(`document.getElementById("out").textContent`)).toBe("save clicked");
  }, 30_000);

  test("a session cannot touch another session's tab", async () => {
    const r = await call(agents.b!, "screenshot", { tabId: tabA });
    expect(r).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect(await call(agents.a!, "navigate", { tabId: tabB, url: "https://example.test/" })).toMatchObject({ ok: false, error: "forbidden_tab" });
    expect((await call(agents.b!, "screenshot", { tabId: tabB })).ok).toBe(true);
  }, 30_000);

  async function panel(): Promise<Session> {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
    const s = await cdp.attach(targetId);
    await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
    return s;
  }
  const panelHas = (s: Session, text: string) => until(`panel text "${text}"`, () => s.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`));

  test("side panel shows the connected state with both sessions", async () => {
    const p = await panel();
    await panelHas(p, "Agents can use this browser");
    await panelHas(p, "id2 / sess-b");
    expect(await p.eval<string>(`document.getElementById("chip").textContent`)).toBe("Connected");
    await sleep(300);
    await shot("sidepanel-connected", p);
    await cdp.send("Target.closeTarget", { targetId: p.targetId });
  }, 30_000);

  test("Stop in the pill returns stopped_by_user, blocks calls, and Resume brings them back", async () => {
    const waiting = call(agents.a!, "wait", { seconds: 30 });
    await sleep(300);
    await pageA.eval(`document.getElementById("ais-browser-overlay").shadowRoot.querySelector(".pill button").click()`);
    expect(await waiting).toMatchObject({ ok: false, error: "stopped_by_user" });
    await until("overlay cleared", async () => (await pageA.eval<boolean>(`document.getElementById("ais-browser-overlay") === null`)));
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
    await until("pill back", () => overlay(pageA, `r.querySelector(".pill") !== null`));
  }, 60_000);

  test("side panel signed-out state", async () => {
    const p = await panel();
    await sw.eval(`chrome.storage.local.remove(["token", "binding", "target"])`);
    await panelHas(p, "Not signed in");
    await sleep(300);
    await shot("sidepanel-signed-out", p);
    await cdp.send("Target.closeTarget", { targetId: p.targetId });
  }, 30_000);
});
