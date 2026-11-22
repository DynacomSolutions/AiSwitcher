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
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CallResult } from "../../../../src/browser/protocol.ts";
import { startGateway } from "../../../../src/gateway/serve.ts";
import type { RunningGateway } from "../../../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../../../src/gateway/store.ts";
import { jpegSize } from "../../src/background/executor.ts";
import type { Cdp, Session } from "./cdp.ts";
import * as H from "./harness.ts";
import { ADMIN, Agent, chromium, dumpLogs, save, sleep, step, trustedClick, until } from "./harness.ts";

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

const dumpTails = (): Promise<void> => dumpLogs(logFiles());

/** A test that prints the Chromium and shim log tails when it fails. */
function it(name: string, fn: () => Promise<void>, ms = 30_000): void {
  test(name, async () => {
    try { await fn(); } catch (e) { await dumpTails(); throw e; }
  }, ms);
}

const shot = async (name: string, s: Session, opts: Parameters<Session["screenshot"]>[0] = {}): Promise<void> => save(`${name}.png`, await s.screenshot(opts));

const agents: Record<string, Agent> = {};
const call = (a: Agent, tool: string, args: Record<string, unknown> = {}): Promise<CallResult> => a.call(tool, args);
const textOf = (r: CallResult): string => (r.ok && r.content[0]?.type === "text" ? r.content[0].text : "");

const targets = () => H.targets(cdp);
const pageSession = (match: (url: string) => boolean): Promise<Session> => H.pageSession(cdp, match);
const extensionPage = (path: string): Promise<Session> => H.extensionPage(cdp, extId, path);

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

describe.skipIf(!chromium)("AIS Browser extension in real Chromium", () => {
  beforeAll(async () => {
    try {
      runDir = await H.makeRunDir();
      const extDir = await H.buildExtension(runDir);

      site = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          // Reports every file a file input receives: name, type, size and SHA-256, so the test can prove the content arrived intact.
          const reporter = `<script>
            async function report(input) {
              const files = [];
              for (const f of input.files) {
                const h = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
                files.push([f.name, f.type, f.size, [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("")].join("|"));
              }
              (window.uploads ||= []).push({ id: input.id || "fresh", files });
            }
            document.addEventListener("change", e => report(e.target));
            function freshInput() { const made = document.createElement("input"); made.setAttribute("type", "file"); made.addEventListener("change", () => report(made)); (made).click(); }
          </script>`;
          const body = u.pathname === "/upload"
            ? `<h1 id="title">Upload</h1><input type="file" id="direct" multiple><input type="file" id="hiddenInput" style="display:none">
               <button id="pick" onclick="document.getElementById('hiddenInput').click()">Choose logo</button><button id="fresh" onclick="freshInput()">Choose cover</button>
               <iframe id="frame" src="http://localhost:${site.port}/upload-frame" style="position:absolute;left:120px;top:360px;width:520px;height:200px;border:1px solid #999"></iframe>${reporter}`
            : u.pathname === "/upload-frame"
            ? `<input type="file" id="frameInput" style="display:none"><button id="framePick" onclick="document.getElementById('frameInput').click()">Upload in frame</button>${reporter}`
            : u.pathname === "/second"
            ? `<h1>Second page</h1><p id="p">Landed.</p>`
            : u.pathname === "/dialogs"
            ? `<h1>Dialogs</h1>
               <button id="alert" onclick="alert('Saved to drafts'); result.textContent='alert closed'">Alert</button>
               <button id="prompt" onclick="result.textContent='prompt ' + prompt('Your name?', 'Ada')">Prompt</button>
               <input id="draft" aria-label="Draft" oninput="window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }">
               <p id="result">idle</p>
               <script>if (location.search.includes("onload")) setTimeout(() => alert("Opened on load"), 0);</script>`
            : u.pathname === "/opener"
            ? `<h1>Opener</h1><a id="open" href="/second" target="_blank">Open in new tab</a>`
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

      const b = await H.launchChromium(runDir, extDir);
      proc = b.proc;
      cdp = b.cdp;
      extId = b.extId;
    } catch (e) {
      await dumpTails();
      throw e;
    }
  }, 300_000);

  afterAll(async () => {
    for (const a of Object.values(agents)) a.stop();
    try { cdp?.close(); } catch { /* gone */ }
    if (proc) { proc.kill(); await proc.exited; }
    await gateway?.stop().catch(() => {});
    site?.stop(true);
    if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // Chromium helper processes may still be writing for a moment
  }, 120_000);

  it("signs in through the console page, then connects", async () => {
    const signed = await H.signIn({ cdp, extId, gatewayPort: gateway.port, adminPort: gateway.adminPort });
    sw = signed.sw;
    ctl = signed.panel; // stays open: the control page messages the worker for status
  }, 240_000);

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
    // The group carries the session's name (here the name the shim got from AIS_SESSION_NAME), never the identity.
    expect(info.groups.find(g => g.id === info.ga)?.title).toBe("Agent A");
    expect(info.groups.find(g => g.id === info.gb)?.title).toBe("Agent B");
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
    expect(await pageA.eval<number[]>(`[innerWidth, innerHeight]`)).toEqual([2400, 1400]);
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
    expect(await pageA.eval<number[]>(`[innerWidth, innerHeight]`)).toEqual([1280, 800]);
  }, 60_000);

  it("controlled tab shows the indicator pill and border, closed off from the page", async () => {
    const agentShot = await call(agents.a!, "screenshot", { tabId: tabA });
    const img = agentShot.ok ? agentShot.content[0] : undefined;
    if (img?.type !== "image") throw new Error("no image");
    await save("agent-capture.jpg", Buffer.from(img.data, "base64"));
    // The tool result carries no overlay, but the user still sees it afterwards.
    const snap = await until("pill", async () => { const s = await snapshot(tabA); return s?.pillOn ? s : undefined; });
    expect(snap.pill).toContain("Agent A"); // the pill shows the session's name
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

  it("upload_file puts files from the agent's machine on file inputs: direct, behind a button, created on the fly and inside a cross-origin iframe", async () => {
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const write = async (name: string, bytes: Uint8Array): Promise<string> => { const f = join(runDir, name); await writeFile(f, bytes); return f; };
    const random = (n: number): Uint8Array => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
    const logoBytes = random(4321);
    const coverBytes = random(9 * 1024 * 1024); // close to the 10 MiB limit: the call is far larger than a socket buffer
    const logo = await write("logo.png", logoBytes);
    const cover = await write("cover.jpg", coverBytes);
    const note = await write("note.txt", new TextEncoder().encode("hello upload\n"));
    const row = (name: string, type: string, bytes: Uint8Array) => [name, type, bytes.length, sha(bytes)].join("|");

    const { tabId } = JSON.parse(textOf(await call(agents.a!, "tabs_create", { url: `http://127.0.0.1:${site.port}/upload` }))) as { tabId: number };
    const top = await pageSession(u => u.endsWith("/upload"));
    // The iframe is another site, so Chromium runs it as its own target: the case that needs a child debugger session.
    const frameTarget = await until("cross-origin iframe target", async () => (await targets()).find(t => t.type === "iframe" && t.url.endsWith("/upload-frame")));
    const frame = await cdp.attach(frameTarget.targetId);
    const uploads = (s: Session) => s.eval<Array<{ id: string; files: string[] }>>(`window.uploads || []`);
    const upload = async (args: Record<string, unknown>) => { const r = await call(agents.a!, "upload_file", { tabId, ...args }); return r.ok ? textOf(r) : `${r.error}: ${r.message}`; };

    const tree = textOf(await call(agents.a!, "read_page", { tabId }));
    const ref = (re: RegExp) => { const m = re.exec(tree)?.[1]; if (!m) throw new Error(`no match for ${re} in:\n${tree}`); return m; };
    const direct = ref(/button "Choose files"[^[]*\[(ref_\d+)\]/i);

    // 1. A ref to the file input itself: two files at once.
    expect(await upload({ ref: direct, paths: [logo, note] })).toBe("Uploaded logo.png, note.txt.");
    expect((await until("direct upload", async () => (await uploads(top)).find(u => u.id === "direct"))).files).toEqual([row("logo.png", "image/png", logoBytes), row("note.txt", "text/plain", new TextEncoder().encode("hello upload\n"))]);

    // 2. A button that opens the chooser of a hidden input. 9 MiB travels shim -> gateway -> extension -> page.
    expect(await upload({ ref: ref(/button "Choose logo" \[(ref_\d+)\]/), paths: [cover] })).toBe("Uploaded cover.jpg.");
    expect((await until("hidden input upload", async () => (await uploads(top)).find(u => u.id === "hiddenInput"))).files).toEqual([row("cover.jpg", "image/jpeg", coverBytes)]);

    // 3. A button that makes a file input on the fly, never in the document.
    expect(await upload({ ref: ref(/button "Choose cover" \[(ref_\d+)\]/), paths: [logo] })).toBe("Uploaded logo.png.");
    expect((await until("on-the-fly input upload", async () => (await uploads(top)).find(u => u.id === "fresh"))).files).toEqual([row("logo.png", "image/png", logoBytes)]);

    // 4. Inside the cross-origin iframe, by screenshot coordinate.
    const shotRes = await call(agents.a!, "screenshot", { tabId });
    if (!shotRes.ok || shotRes.content[0]?.type !== "image") throw new Error("no screenshot");
    const scale = jpegSize(shotRes.content[0].data)!.width / (await top.eval<number>(`innerWidth`));
    const box = await top.eval<{ x: number; y: number }>(`(() => { const el = document.getElementById("frame"); const rect = el.getBoundingClientRect(); return { x: rect["left"] + el["clientLeft"], y: rect["top"] + el["clientTop"] }; })()`);
    const inFrame = await centreOf(frame, "framePick");
    expect(await upload({ coordinate: [(box.x + inFrame.x) * scale, (box.y + inFrame.y) * scale], paths: [logo] })).toBe("Uploaded logo.png.");
    expect((await until("iframe upload", async () => (await uploads(frame)).find(u => u.id === "frameInput"))).files).toEqual([row("logo.png", "image/png", logoBytes)]);

    // Refusals: each one names the cause and uploads nothing.
    const before = (await uploads(top)).length;
    expect(await upload({ ref: ref(/button "Choose logo" \[(ref_\d+)\]/), paths: [logo, note] })).toBe("bad_args: This file input takes one file");
    const title = await centreOf(top, "title");
    expect(await upload({ coordinate: [title.x * scale, title.y * scale], paths: [logo] })).toContain("opened no file chooser");
    expect(await upload({ ref: direct, paths: [join(runDir, "missing.png")] })).toContain("is not a file on this machine");
    expect(await upload({ ref: direct, paths: [await write("big.bin", random(10 * 1024 * 1024 + 1))] })).toContain("the limit is 10485760 bytes");
    expect((await uploads(top)).length).toBe(before);

    // The gateway takes content only. A path on the machine that runs Chrome is refused before any browser sees it.
    const token = (await readFile(join(runDir, "agent-a", "ais-browser-token"), "utf8")).trim();
    const post = (args: Record<string, unknown>) => fetch(`${gw()}/browser/call`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ session: { id: "sess-a" }, tool: "upload_file", args: { tabId, ref: direct, ...args } }) });
    const refused = await post({ paths: ["/etc/passwd"] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("files is required");
    expect((await post({ files: [{ name: "/etc/passwd", mimeType: "text/plain", data: "" }] })).status).toBe(400);
    expect((await uploads(top)).length).toBe(before);
    expect((await call(agents.a!, "close_tab", { tabId })).ok).toBe(true);
  }, 120_000);

  it("a target=_blank link the agent clicks opens behind the owner's tab and joins the agent's group", async () => {
    const tabInfo = (id: number) => sw.eval<{ active: boolean; groupId: number }>(`chrome.tabs.get(${id}).then(t => ({ active: t.active, groupId: t.groupId }))`);
    const made = JSON.parse(textOf(await call(agents.a!, "tabs_create", { url: `http://127.0.0.1:${site.port}/opener` }))) as { tabId: number };
    await sw.eval(`chrome.tabs.update(${tabB}, { active: true })`); // the owner's tab
    const tree = textOf(await call(agents.a!, "read_page", { tabId: made.tabId }));
    const link = /link "Open in new tab" \[(ref_\d+)\]/.exec(tree)?.[1];
    expect(link).toBeDefined();
    const before = new Set(await sw.eval<number[]>(`chrome.tabs.query({}).then(ts => ts.map(t => t.id))`));
    expect((await call(agents.a!, "click", { tabId: made.tabId, ref: link })).ok).toBe(true);
    const opened = await until("tab opened by the page", async () => (await sw.eval<number[]>(`chrome.tabs.query({}).then(ts => ts.filter(t => (t.url || t.pendingUrl || "").endsWith("/second")).map(t => t.id))`)).find(id => !before.has(id)));
    await until("owner's tab active again", async () => (await tabInfo(tabB)).active);
    await sleep(300); // nothing flips it back
    expect((await tabInfo(tabB)).active).toBe(true);
    expect((await tabInfo(opened)).active).toBe(false);
    expect((await tabInfo(opened)).groupId).toBe((await tabInfo(made.tabId)).groupId);
    const ctx = JSON.parse(textOf(await call(agents.a!, "tabs_context"))) as { sessionTabs: Array<{ tabId: number }> };
    expect(ctx.sessionTabs.map(t => t.tabId)).toContain(opened);
    for (const id of [opened, made.tabId]) expect((await call(agents.a!, "close_tab", { tabId: id })).ok).toBe(true);
  });

  it("JavaScript dialogs end calls at once, show in tabs_context and are answered only by handle_dialog", async () => {
    const a = agents.a!;
    const url = `http://127.0.0.1:${site.port}/dialogs`;
    const { tabId } = JSON.parse(textOf(await call(a, "tabs_create", { url }))) as { tabId: number };
    const page = await pageSession(u => u === url);
    const out = () => page.eval<string>(`document.getElementById("result").textContent`);
    const tree = textOf(await call(a, "read_page", { tabId }));
    const ref = (label: RegExp) => { const m = label.exec(tree)?.[1]; expect(m).toBeDefined(); return m!; };
    const timed = async (tool: string, args: Record<string, unknown>) => { const t0 = Date.now(); const r = await call(a, tool, args); return { r, ms: Date.now() - t0 }; };
    const tabOpen = (id: number) => sw.eval<boolean>(`chrome.tabs.get(${id}).then(() => true, () => false)`);
    const dialogOf = async (id: number) => (JSON.parse(textOf(await call(a, "tabs_context"))) as { sessionTabs: Array<{ tabId: number; dialog?: { type: string; message: string } }> }).sessionTabs.find(t => t.tabId === id)?.dialog;

    // An alert raised by a click: the click returns at once with the dialog, and every other call on the tab says so too.
    let { r, ms } = await timed("click", { tabId, ref: ref(/button "Alert" \[(ref_\d+)\]/) });
    expect(r).toMatchObject({ ok: false, error: "dialog_open" });
    expect(ms).toBeLessThan(10_000);
    expect(r.ok ? "" : r.message).toContain(`alert dialog is open on tab ${tabId}`);
    expect(r.ok ? "" : r.message).toContain("Saved to drafts");
    expect(await dialogOf(tabId)).toMatchObject({ type: "alert", message: "Saved to drafts" });
    ({ r, ms } = await timed("screenshot", { tabId }));
    expect(r).toMatchObject({ ok: false, error: "dialog_open" });
    expect(ms).toBeLessThan(5_000);
    expect(textOf(await call(a, "handle_dialog", { tabId, accept: true }))).toContain('Accepted the alert dialog "Saved to drafts"');
    await until("alert answered", async () => (await out()) === "alert closed");
    expect(await dialogOf(tabId)).toBeUndefined();
    expect(await call(a, "handle_dialog", { tabId, accept: true })).toMatchObject({ ok: false, error: "bad_args" });

    // A prompt, answered with text.
    ({ r } = await timed("click", { tabId, ref: ref(/button "Prompt" \[(ref_\d+)\]/) }));
    expect(r.ok ? "" : r.message).toContain('Default prompt text: "Ada"');
    expect(await dialogOf(tabId)).toMatchObject({ type: "prompt", message: "Your name?", defaultPrompt: "Ada" });
    expect((await call(a, "handle_dialog", { tabId, accept: true, promptText: "Grace" })).ok).toBe(true);
    await until("prompt answered", async () => (await out()) === "prompt Grace");

    // A dialog from the javascript tool.
    ({ r, ms } = await timed("javascript", { tabId, code: "confirm('Really?')" }));
    expect(r).toMatchObject({ ok: false, error: "dialog_open" });
    expect(ms).toBeLessThan(10_000);
    expect(r.ok ? "" : r.message).toContain("confirm dialog");
    expect((await call(a, "handle_dialog", { tabId, accept: false })).ok).toBe(true);

    // Unsaved changes: close_tab and navigate get "Leave site?" back, and the tab stays until the agent accepts.
    expect((await call(a, "type", { tabId, ref: ref(/textbox "Draft" \[(ref_\d+)\]/), text: "unsent words" })).ok).toBe(true);
    ({ r, ms } = await timed("close_tab", { tabId }));
    expect(r).toMatchObject({ ok: false, error: "dialog_open" });
    expect(ms).toBeLessThan(10_000);
    expect(r.ok ? "" : r.message).toContain("beforeunload dialog");
    expect(r.ok ? "" : r.message).toContain("discards the user's unsaved changes");
    expect(await dialogOf(tabId)).toMatchObject({ type: "beforeunload" });
    expect(textOf(await call(a, "handle_dialog", { tabId, accept: false }))).toContain("close_tab did not happen");
    await sleep(500);
    expect(await tabOpen(tabId)).toBe(true);
    expect(await page.eval<string>(`document.getElementById("draft").value`)).toBe("unsent words");
    ({ r, ms } = await timed("navigate", { tabId, url: `http://127.0.0.1:${site.port}/second` }));
    expect(r).toMatchObject({ ok: false, error: "dialog_open" });
    expect(ms).toBeLessThan(10_000);
    expect((await call(a, "handle_dialog", { tabId, accept: false })).ok).toBe(true);
    expect(await page.eval<string>(`location.pathname`)).toBe("/dialogs");
    expect((await call(a, "close_tab", { tabId })).ok).toBe(false);
    expect(textOf(await call(a, "handle_dialog", { tabId, accept: true }))).toContain("the tab closes");
    await until("tab closed after accept", async () => !(await tabOpen(tabId)));
    expect((JSON.parse(textOf(await call(a, "tabs_context"))) as { sessionTabs: Array<{ tabId: number }> }).sessionTabs.map(t => t.tabId)).not.toContain(tabId);

    // A dialog that opened before the extension attached: Chrome never reports it (and suppresses dialogs in a background tab
    // no debugger watches), so it happens in the owner's foreground tab. Calls fail fast and name the likely dialog.
    await sw.eval(`chrome.tabs.create({ url: ${JSON.stringify(`${url}?onload`)}, active: true })`);
    const early = await until("owner's tab", async () => (await sw.eval<number[]>(`chrome.tabs.query({}).then(ts => ts.filter(t => (t.url || t.pendingUrl || "").endsWith("?onload")).map(t => t.id))`))[0]);
    await sleep(1000);
    ({ r, ms } = await timed("adopt_tab", { tabId: early }));
    expect(textOf(r)).toContain(`Adopted tab ${early}`);
    expect(textOf(r)).toContain("opened before AIS attached");
    expect(ms).toBeLessThan(10_000);
    for (const [tool, args] of [["screenshot", {}], ["handle_dialog", { accept: false }]] as const) {
      ({ r, ms } = await timed(tool, { tabId: early, ...args }));
      expect(r).toMatchObject({ ok: false, error: "timeout" });
      expect(r.ok ? "" : r.message).toContain("Ask the user to answer it in Chrome");
      expect(ms).toBeLessThan(10_000);
    }
    await sw.eval(`chrome.tabs.remove(${early})`); // the owner closes it
    await until("owner's tab closed", async () => !(await tabOpen(early)));
  }, 120_000);

  async function panel(): Promise<Session> {
    const s = await extensionPage("sidepanel.html");
    await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false });
    // The panel opens on the Chat tab when signed in. These tests look at the Status tab.
    await until("tab strip", () => s.eval<boolean>(`document.getElementById("tab-status") !== null && document.getElementById("panel-loading").hidden`));
    await s.eval(`document.getElementById("tab-status").click()`);
    return s;
  }
  const panelHas = (s: Session, text: string) => until(`panel text "${text}"`, () => s.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`));

  it("side panel shows the connected state and the This tab section", async () => {
    const p = await panel();
    await panelHas(p, "Agents can use this browser");
    await until("This tab card", () => p.eval<boolean>(`document.querySelector("#this-tab h2")?.textContent?.startsWith("This tab") === true`)); // headings are upper case on screen, so innerText cannot be used
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
