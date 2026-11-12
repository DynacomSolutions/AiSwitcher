// End-to-end: the built WebUI served by a real console daemon, driven in real Chromium over CDP at phone widths.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   (cd apps/web && pnpm install --frozen-lockfile && pnpm build) && bun run test:e2e:web
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots).
//
// Asserts, for every route of apps/web/src/App.tsx at 360x740 and 390x844:
//   document.documentElement.scrollWidth <= clientWidth (no horizontal page overflow);
// and that on a narrow screen the menu button opens the navigation, Escape closes it, and following a link closes it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, type Session } from "../../chrome-extension/test/e2e/cdp.ts";

const repoRoot = join(import.meta.dir, "../../..");
const distDir = process.env.AIS_WEB_DIST ?? join(repoRoot, "apps/web/dist");
const chromium = process.env.AIS_E2E_CHROMIUM
  ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;

const ROUTES = [
  "/", "/identities", "/local-models", "/local-models/example", "/limits", "/usage", "/usage/gateway", "/gateway", "/usage/models", "/usage/sources", "/usage/projects", "/usage/repos", "/usage/orgs", "/dashboard/herdr", "/dashboard/processes", "/breakdown", "/breakdown/consumers",
  "/sessions", "/auth", "/browsers", "/permissions", "/files", "/no-such-page",
];
const VIEWPORTS = [{ width: 360, height: 740 }, { width: 390, height: 844 }];
const LONG = "VeryLongUnbrokenTokenVeryLongUnbrokenTokenVeryLongUnbrokenTokenVeryLong";

let runDir = "";
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let cdp: Cdp | undefined;
let page: Session;
let base = "";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, fn: () => Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

async function post(path: string, body: unknown, method = "POST"): Promise<void> {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", "x-ais-console": "1" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
}

async function setViewport(width: number, height: number): Promise<void> {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
}

async function open(route: string): Promise<void> {
  await page.send("Page.navigate", { url: `${base}${route}` });
  await waitFor(`${route} to render`, 20_000, () => page.eval<boolean>("main_has_text()"));
  // Give data a bounded time to replace skeletons; a route that stays loading is still measured, in its loading state.
  await waitFor(`${route} data`, 8_000, () => page.eval<boolean>("main_ready()")).catch(() => undefined);
}

/** Overflow report: page scroll width, and the widest offenders when it overflows. */
const MEASURE = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; }
      }
      if (!clipped) offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 80) + ' right=' + Math.round(r.right) + ' "' + (el.textContent || '').trim().slice(0, 40) + '"');
    }
  }
  return { scrollWidth: de.scrollWidth, clientWidth: vw, bodyScrollWidth: document.body.scrollWidth, offenders: offenders.slice(0, 8) };
})()`;

beforeAll(async () => {
  if (!chromium) throw new Error("no Chromium found; set AIS_E2E_CHROMIUM");
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`apps/web is not built (${distDir}/index.html missing); run pnpm build in apps/web`);
  runDir = await mkdtemp(join(tmpdir(), "ais-web-e2e-"));
  const home = join(runDir, "home");
  await mkdir(home, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  daemon = Bun.spawn(["bun", join(repoRoot, "src/ais.ts"), "web", "--serve-internal", `--port=${port}`], {
    cwd: home,
    stdout: "ignore",
    stderr: Bun.file(join(runDir, "daemon.log")),
    env: {
      ...process.env,
      // No llama.cpp runner on any host, so /local-models always shows its long "Runner missing" badge (as on CI).
      PATH: (process.env.PATH ?? "")
        .split(":")
        .filter((dir) => dir && !existsSync(join(dir, "llama-cli")))
        .join(":"),
      AIS_LLAMA_BIN: "",
      HOME: home,
      AIS_WEB_STATE_DIR: join(runDir, "state"),
      AIS_WEB_DIST: distDir,
      AIS_SPEND_GUARD: "0",
      AIS_HERDR_BRIDGE: "0",
      AIS_AUTH_REFRESH_INTERVAL_MS: "0",
    },
  });
  await waitFor("console daemon", 60_000, async () => (await fetch(`${base}/api/status`)).ok);

  // Identities with long, unbreakable names, labels, descriptions and paths: the worst case for a narrow screen.
  const lower = LONG.toLowerCase();
  for (const tool of ["claude", "codex", "kimi"]) {
    for (const i of [1, 2]) {
      const name = `${tool}-name-${i}-${lower}`;
      await post(`/api/identities/${tool}`, { name, label: `Label ${LONG} ${LONG}`, description: `Description ${LONG} ${LONG}`, configDir: join(runDir, "cfg", `${LONG}-${LONG}`, `${tool}${i}`) });
      await post(`/api/identities/${tool}/${name}/aliases`, { alias: `alias-${i}-${lower}` });
    }
  }
  await writeFile(join(runDir, "profile-marker"), "");

  chrome = Bun.spawn([
    chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${join(runDir, "profile")}`, "--remote-debugging-port=0", "about:blank",
  ], { stdout: "ignore", stderr: Bun.file(join(runDir, "chromium.log")) });
  const wsUrl = await waitFor("DevToolsActivePort", 45_000, async () => {
    const f = Bun.file(join(runDir, "profile", "DevToolsActivePort"));
    if (!(await f.exists())) return undefined;
    const [p, path] = (await f.text()).trim().split("\n");
    return p && path ? `ws://127.0.0.1:${p}${path}` : undefined;
  });
  cdp = await Cdp.connect(wsUrl);
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const tab = targetInfos.find(t => t.type === "page");
  if (!tab) throw new Error("no page target");
  page = await cdp.attach(tab.targetId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  // Evaluated in every document: the SPA has rendered text / has no skeleton left.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.main_has_text = () => { const m = document.querySelector('main'); return !!m && m.innerText.trim().length > 0; };
      window.main_ready = () => !document.querySelector('main [data-slot=skeleton], main .animate-pulse');`,
  });
}, 150_000);

afterAll(async () => {
  try { cdp?.close(); } catch { /* gone */ }
  if (chrome) { chrome.kill(); await chrome.exited; }
  if (daemon) { daemon.kill(); await daemon.exited; }
  if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}, 60_000);

for (const vp of VIEWPORTS) {
  describe(`${vp.width}x${vp.height}`, () => {
    for (const route of ROUTES) {
      test(`${route} has no horizontal page overflow`, async () => {
        await setViewport(vp.width, vp.height);
        await open(route);
        await sleep(500); // charts and late data settle
        const m = await page.eval<{ scrollWidth: number; clientWidth: number; bodyScrollWidth: number; offenders: string[] }>(MEASURE);
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, `${vp.width}${route === "/" ? "-dashboard" : route.replaceAll("/", "-")}.png`), await page.screenshot());
        }
        const detail = `${route}: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}\n${m.offenders.join("\n")}`;
        expect(m.scrollWidth <= m.clientWidth, detail).toBe(true);
        expect(m.bodyScrollWidth <= m.clientWidth, detail).toBe(true);
      }, 40_000);
    }

    test("the New identity dialog fits the viewport", async () => {
      await setViewport(vp.width, vp.height);
      await open("/identities");
      await page.eval(`[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'New identity').click()`);
      await waitFor("dialog", 5_000, () => page.eval<boolean>(`!!document.querySelector('[role=dialog]')`));
      await sleep(400); // open animation
      const r = await page.eval<{ left: number; right: number; top: number; bottom: number; vw: number; vh: number; scrollWidth: number }>(
        `(() => { const { left, right, top, bottom } = document.querySelector('[role=dialog]').getBoundingClientRect(); return { left, right, top, bottom, vw: innerWidth, vh: innerHeight, scrollWidth: document.documentElement.scrollWidth }; })()`);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(r.vw);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.bottom).toBeLessThanOrEqual(r.vh);
      expect(r.scrollWidth).toBeLessThanOrEqual(r.vw);
      if (evidence) await writeFile(join(evidence, `${vp.width}-identity-dialog.png`), await page.screenshot());
    }, 40_000);

    test("the menu button opens the navigation; Escape and a link close it", async () => {
      await setViewport(vp.width, vp.height);
      await open("/");
      const q = (s: string) => `document.querySelector(${JSON.stringify(s)})`;
      // Sidebar is not reachable on a narrow screen, so the button is the only way in.
      expect(await page.eval<boolean>(`getComputedStyle(${q("aside")}).display === 'none'`)).toBe(true);
      const button = `[aria-label="Open navigation menu"]`;
      expect(await page.eval<boolean>(`!!${q(button)} && ${q(button)}.getBoundingClientRect().width > 0`)).toBe(true);

      await page.eval(`${q(button)}.click()`);
      await waitFor("nav dialog", 5_000, () => page.eval<boolean>(`!!${q('[role=dialog] nav[aria-label=Main]')}`));
      expect(await page.eval<number>(`document.querySelectorAll('[role=dialog] nav a').length`)).toBe(12);
      expect(await page.eval<string>(`${q(button)}.getAttribute('aria-expanded')`)).toBe("true");

      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await waitFor("nav closed by Escape", 5_000, () => page.eval<boolean>(`!${q("[role=dialog]")}`));
      expect(await page.eval<boolean>(`document.activeElement === ${q(button)}`)).toBe(true); // focus returns to the button

      await page.eval(`${q(button)}.click()`);
      await waitFor("nav reopened", 5_000, () => page.eval<boolean>(`!!${q('[role=dialog] nav[aria-label=Main]')}`));
      await page.eval(`[...document.querySelectorAll('[role=dialog] nav a')].find(a => a.textContent.trim() === 'Limits').click()`);
      await waitFor("nav closed by navigation", 5_000, () => page.eval<boolean>(`!${q("[role=dialog]")}`));
      expect(await page.eval<string>(`location.pathname`)).toBe("/limits");
      if (evidence) {
        await page.eval(`${q(button)}.click()`);
        await sleep(400);
        await writeFile(join(evidence, `${vp.width}-menu-open.png`), await page.screenshot());
      }
    }, 40_000);
  });
}
