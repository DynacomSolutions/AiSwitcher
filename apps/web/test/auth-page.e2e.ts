// End-to-end: the Auth page in the built WebUI, served by a real console daemon and driven in real Chromium over CDP.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   (cd apps/web && pnpm install --frozen-lockfile && pnpm build) && bun run test:e2e:web
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots).
//
// The auth and renewal answers are synthetic. The page must show ONE list with one row per identity and tool, keep its
// filter and sort in the URL (history replace), stay inside the page width at 360 px, show a table from a laptop width with
// nothing spilling into a neighbour cell, keep a tool that only the renewal report knows while that report is slow, and be
// reachable by keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Cdp, type Session } from "../../chrome-extension/test/e2e/cdp.ts";
import type { AuthRefreshResponse, AuthResponse, RenewalRow } from "../src/types/api.ts";

const repoRoot = join(import.meta.dir, "../../..");
const distDir = process.env.AIS_WEB_DIST ?? join(repoRoot, "apps/web/dist");
const chromium = process.env.AIS_E2E_CHROMIUM
  ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;
const scratchRoot = process.env.AIS_WEB_E2E_SCRATCH ?? tmpdir();

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;
const LONG_ERROR = "the provider answered a dead-grant code; only a new login helps VeryLongUnbrokenTokenVeryLongUnbrokenTokenVeryLongUnbrokenToken";

const gw = (tool: string, identity: string, over: Partial<NonNullable<RenewalRow["gateway"]>> = {}): RenewalRow => ({
  tool, identity, renewer: "gateway", note: "", host: null,
  gateway: { provider: tool, identity, lastRefreshAt: iso(-2 * H), lastRefreshReplica: "pod-1", lastError: null, expiresAt: iso(6 * H), nextRefreshAt: iso(2 * H), revoked: false, ...over },
});
const RENEWALS: RenewalRow[] = [
  gw("claude", "SYNTHETIC_FIXTURE-claude-healthy"),
  gw("codex", "SYNTHETIC_FIXTURE-codex-healthy"),
  gw("codex", "SYNTHETIC_FIXTURE-codex-revoked-with-a-very-long-identity-name", { revoked: true, expiresAt: null, nextRefreshAt: null, lastError: { at: iso(-6 * H), code: "refresh_token_invalidated", detail: LONG_ERROR } }),
  { tool: "kimi", identity: "SYNTHETIC_FIXTURE-kimi-host", renewer: "host", gateway: null, note: "", host: { lastAttemptAt: iso(-H), lastSuccessAt: iso(-H), lastError: null, lastDetail: null, revoked: false, consecutiveFailures: 0, running: false } },
  { tool: "claude", identity: "SYNTHETIC_FIXTURE-pool", renewer: "pool", gateway: null, note: "", host: null },
];
const AUTH: AuthResponse = {
  entries: [
    { toolName: "claude", identity: "SYNTHETIC_FIXTURE-claude-healthy", kind: "oauth", state: "ok", detail: "via gateway: renewed", fixable: ["login"], expiresAt: iso(6 * H), account: { source: "gateway-member", email: "SYNTHETIC_FIXTURE@example.invalid" } },
    { toolName: "codex", identity: "SYNTHETIC_FIXTURE-codex-healthy", kind: "oauth", state: "ok", detail: "via gateway: renewed", fixable: ["login"], expiresAt: iso(6 * H) },
    { toolName: "codex", identity: "SYNTHETIC_FIXTURE-codex-revoked-with-a-very-long-identity-name", kind: "oauth", state: "expired", detail: "refresh token revoked at the gateway: re-login required", fixable: ["login"] },
    { toolName: "kimi", identity: "SYNTHETIC_FIXTURE-kimi-host", kind: "oauth", state: "ok", detail: "token valid", fixable: ["refresh", "login"], expiresAt: iso(20 * H) },
    { toolName: "kimi", identity: "SYNTHETIC_FIXTURE-kimi-plain", kind: "oauth", state: "ok", detail: "token valid", fixable: ["refresh", "login"], expiresAt: iso(20 * H) },
    { toolName: "zai", identity: "SYNTHETIC_FIXTURE-zai-key", kind: "apikey", state: "ok", detail: "key present", fixable: ["zai-key"] },
    { toolName: "claude", identity: "SYNTHETIC_FIXTURE-pool", kind: "none", state: "gateway", detail: "pool", fixable: [] },
    { toolName: "codex", identity: "SYNTHETIC_FIXTURE-retired", kind: "oauth", state: "retired", detail: "retired", fixable: ["login"] },
  ],
};
const REFRESH: AuthRefreshResponse = { results: [], rows: RENEWALS, gateway: { state: "ok" } };
const ANSWERS: Record<string, unknown> = { "/api/auth": AUTH, "/api/auth/refresh": REFRESH };
/** Identity keys the list must show, one row each. */
const KEYS = AUTH.entries.map((e) => `${e.toolName}/${e.identity}`);

/** Runs in the page before each document: it answers the auth routes with the synthetic data. */
function authStub(answers: Record<string, unknown>): void {
  const real = window.fetch.bind(window);
  const stub = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    const answer = u.origin === location.origin && (init?.method ?? "GET") === "GET" && Object.hasOwn(answers, u.pathname) ? answers[u.pathname] : undefined;
    return answer === undefined
      ? real(input, init)
      : Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
  };
  window.fetch = Object.assign(stub, { preconnect: window.fetch.preconnect });
}

/** Runs in the page after authStub: it answers the renewal report late and with one more row that the auth probe does not list. */
function slowRenewalStub(report: unknown, delayMs: number): void {
  const inner = window.fetch.bind(window);
  const stub = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin || u.pathname !== "/api/auth/refresh" || (init?.method ?? "GET") !== "GET") return inner(input, init);
    return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(report), { status: 200, headers: { "content-type": "application/json" } })), delayMs));
  };
  window.fetch = Object.assign(stub, { preconnect: window.fetch.preconnect });
}

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

async function setViewport(width: number, height: number): Promise<void> {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
}

/** Opens an Auth route and waits for the rows of the list. */
async function openAuth(search = "", rows = KEYS.length): Promise<void> {
  await page.send("Page.navigate", { url: `${base}/auth${search}` });
  await waitFor("auth rows", 20_000, async () => (await page.eval<number>(`document.querySelectorAll('main [data-slot=auth-row]').length`)) === rows);
  await sleep(300);
}

interface Measure { scrollWidth: number; clientWidth: number; offenders: string[]; clipped: string[]; spills: string[]; gaps: string[]; table: boolean; containerRem: number; rowHeights: number[]; rowHeight: number; tables: number; text: string }

const rowKeys = () => page.eval<string[]>(`[...document.querySelectorAll('main [data-slot=auth-row]')].map(r => r.getAttribute('data-key'))`);

/** The report of the page: overflow, tables and the text of the retired list parts. */
const MEASURE = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 60) + ' right=' + Math.round(r.right));
  }
  const clipped = [...document.querySelectorAll('main [data-slot=auth-row] *')].filter(el => {
    const cs = getComputedStyle(el);
    return el.getBoundingClientRect().width > 1 && (cs.overflowX !== 'visible' || el.classList.contains('truncate')) && el.scrollWidth > el.clientWidth + 1;
  }).map(el => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 60));
  // An element that runs past its own cell covers the text of the next cell. Overflow is visible there, so clipping tests miss it.
  const spills = [];
  for (const cell of document.querySelectorAll('main [data-slot=auth-cell]')) {
    const c = cell.getBoundingClientRect();
    for (const el of cell.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > c.right + 1 || r.left < c.left - 1)) spills.push(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40) + ' by=' + Math.round(Math.max(r.right - c.right, c.left - r.left)));
    }
  }
  // An empty grid cell leaves a line of a row shorter than the row.
  const gaps = [];
  for (const li of document.querySelectorAll('main [data-slot=auth-row]')) {
    const cs = getComputedStyle(li);
    const lr = li.getBoundingClientRect();
    const left = lr.left + parseFloat(cs.paddingLeft);
    const right = lr.right - parseFloat(cs.paddingRight);
    const lines = new Map();
    for (const ch of li.children) {
      const r = ch.getBoundingClientRect();
      const k = Math.round(r.top);
      const l = lines.get(k) ?? { l: Infinity, r: -Infinity };
      l.l = Math.min(l.l, r.left);
      l.r = Math.max(l.r, r.right);
      lines.set(k, l);
    }
    for (const l of lines.values()) if (l.l > left + 1 || l.r < right - 1) gaps.push(li.getAttribute('data-key'));
  }
  const head = document.querySelector('main [data-slot=auth-head]');
  const firstRow = document.querySelector('main [data-slot=auth-row]');
  return { scrollWidth: de.scrollWidth, clientWidth: vw, offenders: offenders.slice(0, 8), clipped: clipped.slice(0, 8), spills: spills.slice(0, 8), gaps: [...new Set(gaps)].slice(0, 8), table: !!head && getComputedStyle(head).display === 'grid', containerRem: firstRow ? Math.round((firstRow.parentElement.parentElement.clientWidth / 16) * 10) / 10 : 0, rowHeights: [...document.querySelectorAll('main [data-slot=auth-row]')].map(r => Math.round(r.getBoundingClientRect().height)), rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0, tables: document.querySelectorAll('main table').length, text: document.querySelector('main').innerText };
})()`;

beforeAll(async () => {
  if (!chromium) throw new Error("no Chromium found; set AIS_E2E_CHROMIUM");
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`apps/web is not built (${distDir}/index.html missing); run pnpm build in apps/web`);
  await mkdir(scratchRoot, { recursive: true });
  runDir = await mkdtemp(join(scratchRoot, "ais-web-auth-e2e-"));
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
      HOME: home,
      AIS_WEB_STATE_DIR: join(runDir, "state"),
      AIS_WEB_DIST: distDir,
      AIS_SPEND_GUARD: "0",
      AIS_HERDR_BRIDGE: "0",
      AIS_AUTH_REFRESH_INTERVAL_MS: "0",
    },
  });
  await waitFor("console daemon", 60_000, async () => (await fetch(`${base}/api/status`)).ok);

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
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${authStub.toString()})(${JSON.stringify(ANSWERS)})` });
}, 150_000);

afterAll(async () => {
  try { cdp?.close(); } catch { /* gone */ }
  if (chrome) { chrome.kill(); await chrome.exited; }
  if (daemon) { daemon.kill(); await daemon.exited; }
  if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}, 60_000);

for (const vp of [{ width: 360, height: 740 }, { width: 1280, height: 900 }, { width: 1920, height: 1000 }]) {
  describe(`Auth page at ${vp.width}x${vp.height}`, () => {
    test("one list holds one row per identity and tool, with every field", async () => {
      await setViewport(vp.width, vp.height);
      await openAuth();
      expect((await rowKeys()).sort()).toEqual([...KEYS].sort());
      const m = await page.eval<Measure>(MEASURE);
      const detail = JSON.stringify({ ...m, text: undefined });
      // One list: no separate renewal table, no second card.
      expect(m.tables, detail).toBe(0);
      expect(m.text).not.toContain("Scheduled credential renewal");
      for (const label of ["Auth state", "Kind", "Expires", "Last renewal", "Next renewal", "Renewed by", "Renewal status", "Detail and last error"]) expect(m.text.toLowerCase(), label).toContain(label.toLowerCase());
      expect(m.text).toContain("refresh_token_invalidated");
      expect(m.text).toContain("Gateway");
      // The renewal status of each kind of row, and the probe detail of a healthy row.
      for (const text of ["Sign-in needed", "Renewing", "Members renewed by the gateway", "token valid", "via gateway: renewed", "oauth", "apikey"]) expect(m.text, text).toContain(text);
      // The host row offers the real renewal and no weaker refresh. A kimi login without a host renewal keeps "Refresh token", and its tooltip says what it does.
      expect(await page.eval<number>(`[...document.querySelectorAll('main button')].filter(b => b.textContent.trim() === 'Run host renewal').length`)).toBe(1);
      expect(await page.eval<number>(`[...document.querySelectorAll('main [data-key="kimi/SYNTHETIC_FIXTURE-kimi-host"] button')].filter(b => b.textContent.trim() === 'Refresh token').length`)).toBe(0);
      expect(await page.eval<number>(`[...document.querySelectorAll('main [data-key="kimi/SYNTHETIC_FIXTURE-kimi-plain"] button')].filter(b => b.textContent.trim() === 'Refresh token').length`)).toBe(1);
      expect(await page.eval<string>(`[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'Refresh token').title`)).toContain("only when it has expired");
      expect(await page.eval<number>(`[...document.querySelectorAll('main button')].filter(b => b.textContent.trim() === 'Refresh now').length`)).toBe(0);
      expect(await page.eval<number>(`[...document.querySelectorAll('main button')].filter(b => b.textContent.trim() === 'Log in').length`)).toBeGreaterThanOrEqual(4);
      expect(m.scrollWidth <= m.clientWidth, detail).toBe(true);
      expect(m.offenders, detail).toEqual([]);
      expect(m.clipped, detail).toEqual([]);
      expect(m.spills, detail).toEqual([]);
      expect(m.gaps, detail).toEqual([]);
      // The table starts at a laptop width. A phone keeps the cards.
      expect(m.table, detail).toBe(vp.width >= 1280);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, `auth-combined-${vp.width}.png`), await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }).then((r) => Buffer.from(r.data, "base64")));
      }
    }, 60_000);

    test("filter and sort come from the URL and a change replaces history", async () => {
      await setViewport(vp.width, vp.height);
      // The URL alone reproduces the view.
      await openAuth("?state=attention&sort=state", 1);
      expect(await rowKeys()).toEqual(["codex/SYNTHETIC_FIXTURE-codex-revoked-with-a-very-long-identity-name"]);
      await openAuth("?tool=codex&sort=identity&dir=desc", 3);
      expect(await rowKeys()).toEqual([
        "codex/SYNTHETIC_FIXTURE-retired",
        "codex/SYNTHETIC_FIXTURE-codex-revoked-with-a-very-long-identity-name",
        "codex/SYNTHETIC_FIXTURE-codex-healthy",
      ]);
      // Typing in the filter writes the URL with history replace.
      await openAuth();
      const before = await page.eval<number>("history.length");
      await page.eval(`(() => { const i = document.querySelector('input[aria-label="Filter credentials"]'); i.focus(); })()`);
      await page.send("Input.insertText", { text: "kimi-host" });
      await waitFor("filtered list", 5_000, async () => (await rowKeys()).length === 1);
      expect(await page.eval<string>("location.search")).toBe("?q=kimi-host");
      expect(await page.eval<number>("history.length")).toBe(before);
      expect(await rowKeys()).toEqual(["kimi/SYNTHETIC_FIXTURE-kimi-host"]);
    }, 60_000);

    test("the sort direction button writes dir to the URL with history replace", async () => {
      await setViewport(vp.width, vp.height);
      await openAuth("?sort=identity");
      const before = await page.eval<number>("history.length");
      const first = (await rowKeys())[0];
      const click = () => page.eval(`[...document.querySelectorAll('main button')].find(b => /^(Ascending|Descending)$/.test(b.textContent.trim())).click()`);
      await click();
      await waitFor("descending URL", 5_000, async () => (await page.eval<string>("location.search")) === "?sort=identity&dir=desc");
      expect((await rowKeys())[0]).not.toBe(first);
      expect(await page.eval<string>(`[...document.querySelectorAll('main button')].find(b => /^(Ascending|Descending)$/.test(b.textContent.trim())).textContent.trim()`)).toBe("Descending");
      await click();
      await waitFor("ascending URL", 5_000, async () => (await page.eval<string>("location.search")) === "?sort=identity");
      expect((await rowKeys())[0]).toBe(first);
      expect(await page.eval<number>("history.length")).toBe(before);
    }, 60_000);

    test("an unknown tool in the URL shows every tool and the address is corrected with history replace", async () => {
      await setViewport(vp.width, vp.height);
      await openAuth("?tool=nope&sort=tool");
      expect((await rowKeys()).sort()).toEqual([...KEYS].sort());
      await waitFor("corrected URL", 5_000, async () => (await page.eval<string>("location.search")) === "?sort=tool");
      expect(await page.eval<string>(`document.querySelector('main').innerText.includes('No matches')`)).toBe(false);
      expect(await page.eval<string>(`document.querySelector('main [role=combobox][aria-label=Tool]').textContent.trim()`)).toBe("All tools");
    }, 60_000);

    test("every control is reachable with the keyboard and shows its focus", async () => {
      await setViewport(vp.width, vp.height);
      await openAuth();
      const total = await page.eval<number>(`document.querySelectorAll('main input, main button:not([disabled]), main [role=combobox]').length`);
      expect(total).toBeGreaterThan(8);
      await page.eval(`document.querySelector('main').scrollIntoView(); document.activeElement && document.activeElement.blur()`);
      const seen = new Set<string>();
      const unfocused: string[] = [];
      for (let i = 0; i < total + 12; i++) {
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        const f = await page.eval<{ inMain: boolean; label: string; ring: boolean; visible: boolean } | null>(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return { inMain: !!el.closest('main'), label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40) + '#' + [...document.querySelectorAll('main *')].indexOf(el), ring: (cs.boxShadow && cs.boxShadow !== 'none') || (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0), visible: r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth };
        })()`);
        if (!f || !f.inMain) continue;
        seen.add(f.label);
        if (!f.ring) unfocused.push(f.label);
        expect(f.visible, f.label).toBe(true);
      }
      expect(seen.size, JSON.stringify([...seen])).toBeGreaterThanOrEqual(total);
      expect(unfocused, "controls without a visible focus ring").toEqual([]);
    }, 90_000);
  });
}

// The table must start at a laptop width. The breakpoint is a container width, so the sidebar counts.
for (const width of [1280, 1366, 1440, 1536, 1680, 1920]) {
  describe(`Auth table at a ${width} px laptop screen`, () => {
    test("shows the table, with nothing spilling into a neighbour cell and nothing clipped", async () => {
      await setViewport(width, 900);
      await openAuth();
      const m = await page.eval<Measure>(MEASURE);
      const detail = JSON.stringify({ ...m, text: undefined });
      expect(m.table, detail).toBe(true);
      expect(m.scrollWidth <= m.clientWidth, detail).toBe(true);
      expect(m.offenders, detail).toEqual([]);
      expect(m.clipped, detail).toEqual([]);
      expect(m.spills, detail).toEqual([]);
      expect(m.gaps, detail).toEqual([]);
      // A compact row, not a tall card: the middle row is far below the 190 px or more of a card.
      expect([...m.rowHeights].sort((a, b) => a - b)[Math.floor(m.rowHeights.length / 2)], detail).toBeLessThan(120);
      // The header and the card label use the same words.
      expect(await page.eval<boolean>(`[...document.querySelectorAll('main [data-slot=auth-head] span')].some(s => s.textContent === 'Detail and last error')`)).toBe(true);
      if (evidence && [1280, 1440, 1920].includes(width)) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, `auth-combined-${width}.png`), await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }).then((r) => Buffer.from(r.data, "base64")));
      }
    }, 60_000);
  });
}

// Below the table width the rows stay cards. Each line of a card must fill the card: an empty grid cell would leave a hole.
for (const width of [360, 600, 800, 1000]) {
  describe(`Auth cards at a ${width} px screen`, () => {
    test("each card line is full and nothing spills", async () => {
      await setViewport(width, 900);
      await openAuth();
      const m = await page.eval<Measure>(MEASURE);
      const detail = JSON.stringify({ ...m, text: undefined });
      expect(m.table, detail).toBe(false);
      expect(m.scrollWidth <= m.clientWidth, detail).toBe(true);
      expect(m.offenders, detail).toEqual([]);
      expect(m.spills, detail).toEqual([]);
      expect(m.gaps, detail).toEqual([]);
    }, 60_000);
  });
}

describe("Auth page while the renewal report is slow", () => {
  test("a tool that only the renewal report knows stays in the URL", async () => {
    await setViewport(1280, 900);
    const grok: RenewalRow = gw("grok", "SYNTHETIC_FIXTURE-grok-renewal-only");
    const slow = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: `(${slowRenewalStub.toString()})(${JSON.stringify({ ...REFRESH, rows: [...RENEWALS, grok] })}, 1500)` });
    try {
      await page.send("Page.navigate", { url: `${base}/auth?tool=grok` });
      // The auth probe answers at once. The renewal report is still 1.5 s away.
      await sleep(700);
      expect(await page.eval<string>("location.search"), "URL while the renewal report is pending").toBe("?tool=grok");
      await waitFor("the grok row", 20_000, async () => (await rowKeys()).length === 1);
      expect(await rowKeys()).toEqual(["grok/SYNTHETIC_FIXTURE-grok-renewal-only"]);
      await sleep(300);
      expect(await page.eval<string>("location.search"), "URL after both answers").toBe("?tool=grok");
    } finally {
      await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: slow.identifier });
    }
  }, 60_000);
});
