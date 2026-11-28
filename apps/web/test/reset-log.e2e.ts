// End-to-end: the Reset log page and the Limits links to it, in the built WebUI, driven in real Chromium over CDP.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   (cd apps/web && pnpm install --frozen-lockfile && pnpm build) && bun test ./apps/web/test/reset-log.e2e.ts
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots).
//
// No daemon runs here. A small static server serves apps/web/dist with the single-page fallback and answers the few
// API routes with synthetic data, and it records every request to /api/logs/resets. The page must show the rows, load the
// next page with the cursor, write every filter to the URL with history replace, rebuild the view from a URL alone, drop
// invalid values, redirect /logs, and the Limits page must link each identity to its filtered log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { Cdp, type Session } from "../../chrome-extension/test/e2e/cdp.ts";
import type { LimitsResponse, ResetLogResponse, ResetLogRow, ResetLogWindow, ToolLimitResult } from "../src/types/api.ts";

const repoRoot = join(import.meta.dir, "../../..");
const distDir = process.env.AIS_WEB_DIST ?? join(repoRoot, "apps/web/dist");
const chromium = process.env.AIS_E2E_CHROMIUM
  ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/chromium"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;
const scratchRoot = process.env.AIS_WEB_E2E_SCRATCH ?? tmpdir();

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;
const D = 24 * H;
const PAGE_CAP = 3;

const A = "SYNTHETIC_FIXTURE-member-a";
const B = "SYNTHETIC_FIXTURE-member-b";
const C = "SYNTHETIC_FIXTURE-codex-a";
const UNUSED = "SYNTHETIC_FIXTURE-never-reset";
const BOOM = "SYNTHETIC_FIXTURE-boom";

const win = (key: string, percent: number, resetsAt: string | null, label: string | null = null): ResetLogWindow => ({ key, label, percent, resetsAt });
const row = (id: number, over: Partial<ResetLogRow>): ResetLogRow => ({
  id: `SYNTHETIC_FIXTURE-row-${id}`, at: iso(-id * H), provider: "claude", trigger: "manual", actor: "console", identity: A, account: null, pool: null, grantId: null,
  before: [], outcome: "reset", message: null, resetsLeftAfter: null, after: null, afterAt: null, ...over,
});
/** Newest first. The first page holds three rows, so "Load more" has two more pages to fetch. */
const ROWS: ResetLogRow[] = [
  row(1, { at: iso(-10 * 60_000), account: "SYNTHETIC_FIXTURE@example.invalid", pool: "SYNTHETIC_FIXTURE-pool", grantId: "SYNTHETIC_FIXTURE-grant-1", before: [win("five_hour", 96, iso(H)), win("weekly", 88.4, iso(2 * D))], resetsLeftAfter: 2 }),
  row(2, { at: iso(-2 * H), provider: "codex", trigger: "auto", actor: "auto-reset daemon", identity: C, before: [win("weekly", 100, iso(D))], resetsLeftAfter: 0, after: [win("weekly", 0, null)], afterAt: iso(-H) }),
  row(3, { at: iso(-5 * H), trigger: "auto", actor: "auto-reset daemon", identity: B, pool: "SYNTHETIC_FIXTURE-pool", before: [win("weekly_opus", 91, iso(3 * D))], outcome: "error", message: "SYNTHETIC_FIXTURE upstream answered 502 Bad Gateway" }),
  row(4, { at: iso(-D), before: [win("weekly", 99, iso(D))], outcome: "no_credit" }),
  row(5, { at: iso(-2 * D), provider: "codex", identity: C, before: [], outcome: "rejected", message: "SYNTHETIC_FIXTURE the provider refused the request" }),
  row(6, { at: iso(-3 * D), trigger: "auto", actor: "auto-reset daemon", identity: B, before: [win("five_hour", 100, iso(H))], outcome: "already_redeemed" }),
  row(7, { at: iso(-10 * D), before: [win("weekly", 97, iso(D), "week (all)")], resetsLeftAfter: 1, after: [win("weekly", 2, iso(7 * D), "week (all)")], afterAt: iso(-10 * D + H) }),
];
const IDENTITIES = [A, B, C];

const LIMIT_ROW = (identity: string): ToolLimitResult => ({
  toolName: "claude", provider: "anthropic", identity: { name: identity, label: identity, configDir: "synthetic" },
  windows: [{ label: "session (5h)", category: "session", usedPercent: 12 }], status: "live", capturedAt: iso(-60_000),
});
const LIMITS: LimitsResponse = { results: [LIMIT_ROW(A), LIMIT_ROW(B)], cached: false, fetchedAt: iso(0) };

/** The answer of the stub API to one log request: the filters of the contract, the cursor, and a page size cap. */
function answer(params: URLSearchParams): { status: number; body: unknown } {
  if (params.get("identity") === BOOM) return { status: 500, body: { error: "SYNTHETIC_FIXTURE the log store is down" } };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const matches = ROWS.filter((r) =>
    (!params.get("identity") || r.identity === params.get("identity"))
    && (!params.get("provider") || r.provider === params.get("provider"))
    && (!params.get("trigger") || r.trigger === params.get("trigger"))
    && (!params.get("outcome") || r.outcome === params.get("outcome"))
    && (!params.get("from") || day(Date.parse(r.at)) >= params.get("from")!)
    && (!params.get("to") || day(Date.parse(r.at)) <= params.get("to")!));
  const before = params.get("before");
  const start = before ? matches.findIndex((r) => r.id === before) + 1 : 0;
  const limit = Math.min(Number(params.get("limit") ?? PAGE_CAP), PAGE_CAP);
  const rows = matches.slice(start, start + limit);
  const more = start + limit < matches.length;
  const body: ResetLogResponse = { rows, nextBefore: more ? rows[rows.length - 1]!.id : null, identities: IDENTITIES };
  return { status: 200, body };
}

const requests: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
let runDir = "";
/** Chromium puts a unix socket in TMPDIR, and a socket path has a short limit. A long TMPDIR needs a short one for the browser. */
let shortTmp = "";
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let cdp: Cdp | undefined;
let page: Session;
let base = "";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/logs/resets") {
    requests.push(url.search);
    const { status, body } = answer(url.searchParams);
    return json(body, status);
  }
  if (url.pathname === "/api/limits") return json(LIMITS);
  if (url.pathname === "/api/limits/auto-reset") return json({ configured: false });
  if (url.pathname === "/api/status") return json({ ok: true, version: "0.0.0-synthetic" });
  if (url.pathname.startsWith("/api/")) return json({ error: "not part of this test" }, 404);
  const file = normalize(join(distDir, url.pathname));
  if (file.startsWith(distDir) && extname(file) && (await Bun.file(file).exists())) {
    return new Response(Bun.file(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
  }
  return new Response(Bun.file(join(distDir, "index.html")), { headers: { "content-type": MIME[".html"]! } });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor<T>(what: string, ms: number, fn: () => Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function setViewport(width: number, height: number): Promise<void> {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
}

const rowIds = () => page.eval<string[]>(`[...document.querySelectorAll('main [data-slot=reset-log-row]')].map(r => r.getAttribute('data-id').replace('SYNTHETIC_FIXTURE-row-', ''))`);
const search = () => page.eval<string>("location.search");
const pathname = () => page.eval<string>("location.pathname");
const historyLength = () => page.eval<number>("history.length");
const mainText = () => page.eval<string>("document.querySelector('main').innerText");

/** Opens a route and waits until the log shows `count` rows, or any state when `count` is null. */
async function open(path: string, count: number | null): Promise<void> {
  requests.length = 0;
  await page.send("Page.navigate", { url: `${base}${path}` });
  if (count !== null) await waitFor(`${count} rows`, 20_000, async () => (await rowIds()).length === count);
  await sleep(150);
}

/** A real mouse click on the centre of the element that the expression returns. Radix opens a select on pointer down. */
async function clickAt(expression: string): Promise<void> {
  const point = await page.eval<{ x: number; y: number } | null>(`(() => { const el = (${expression}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!point) throw new Error(`nothing to click for ${expression}`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

/** Picks an option of one of the filter selects, as a person does. */
async function choose(label: string, option: string): Promise<void> {
  await clickAt(`document.querySelector('main [role=combobox][aria-label=${JSON.stringify(label)}]')`);
  await waitFor(`the ${label} list`, 5_000, async () => page.eval<boolean>(`!!document.querySelector('[role=option]')`));
  await clickAt(`[...document.querySelectorAll('[role=option]')].find(o => o.textContent.trim() === ${JSON.stringify(option)})`);
  await waitFor(`the ${label} list to close`, 5_000, async () => page.eval<boolean>(`!document.querySelector('[role=option]')`));
}

const selectText = (label: string) => page.eval<string>(`document.querySelector('main [role=combobox][aria-label=${JSON.stringify(label)}]').textContent.trim()`);

async function setDate(label: string, value: string): Promise<void> {
  await page.eval(`(() => { const i = document.querySelector('input[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

async function shot(name: string, fullPage = true): Promise<void> {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  const r = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage });
  await writeFile(join(evidence, name), Buffer.from(r.data, "base64"));
}

beforeAll(async () => {
  if (!chromium) throw new Error("no Chromium found; set AIS_E2E_CHROMIUM");
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`apps/web is not built (${distDir}/index.html missing); run pnpm build in apps/web`);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  base = `http://127.0.0.1:${server.port}`;
  await mkdir(scratchRoot, { recursive: true });
  runDir = await mkdtemp(join(scratchRoot, "ais-web-reset-log-e2e-"));
  shortTmp = await mkdtemp(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "ais-rl-"));
  chrome = Bun.spawn([
    chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${join(runDir, "profile")}`, "--remote-debugging-port=0", "about:blank",
  ], { stdout: "ignore", stderr: Bun.file(join(runDir, "chromium.log")), env: { ...process.env, TMPDIR: shortTmp } });
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
  await setViewport(1440, 900);
}, 120_000);

afterAll(async () => {
  try { cdp?.close(); } catch { /* gone */ }
  if (chrome) { chrome.kill(); await chrome.exited; }
  if (server) await server.stop(true);
  if (shortTmp) await rm(shortTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  if (runDir) await rm(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}, 60_000);

describe("Reset log page", () => {
  test("shows the newest resets first with every field, from the API", async () => {
    await open("/logs/resets", 3);
    expect(await rowIds()).toEqual(["1", "2", "3"]);
    expect(requests).toEqual(["?limit=50"]);
    const text = await mainText();
    for (const part of [
      "Reset log", "SYNTHETIC_FIXTURE-grant-1", "SYNTHETIC_FIXTURE@example.invalid", "pool SYNTHETIC_FIXTURE-pool", "auto-reset daemon", "console",
      "5-hour", "96%", "Weekly 88.4%", "Weekly Opus 91%", "ICT", "Resets left",
    ]) expect(text, part).toContain(part);
    // The row of a worked reset with no later reading waits. A row with a reading shows it. A failed row keeps its message.
    const first = await page.eval<string>(`document.querySelector('main [data-id=SYNTHETIC_FIXTURE-row-1]').innerText`);
    expect(first).toContain("Waiting for next reading");
    expect(first).toContain("Reset");
    const second = await page.eval<string>(`document.querySelector('main [data-id=SYNTHETIC_FIXTURE-row-2]').innerText`);
    expect(second).toContain("Weekly 0%");
    expect(second).toContain("read ");
    expect(second).not.toContain("Waiting for next reading");
    const third = await page.eval<string>(`document.querySelector('main [data-id=SYNTHETIC_FIXTURE-row-3]').innerText`);
    expect(third).toContain("Error");
    expect(third).toContain("SYNTHETIC_FIXTURE upstream answered 502 Bad Gateway");
    expect(third).toContain("None expected");
    expect(await page.eval<string>(`document.querySelector('main [role=status]').textContent`)).toContain("3 resets shown, older resets are available");
    await shot("reset-log-1-page.png");
  }, 60_000);

  test("Load more asks for the next page with the cursor and appends the rows", async () => {
    await open("/logs/resets", 3);
    await clickAt(`[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'Load more')`);
    await waitFor("six rows", 10_000, async () => (await rowIds()).length === 6);
    expect(requests).toEqual(["?limit=50", "?limit=50&before=SYNTHETIC_FIXTURE-row-3"]);
    expect(await rowIds()).toEqual(["1", "2", "3", "4", "5", "6"]);
    await clickAt(`[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'Load more')`);
    await waitFor("seven rows", 10_000, async () => (await rowIds()).length === 7);
    expect(await page.eval<number>(`[...document.querySelectorAll('main button')].filter(b => b.textContent.trim() === 'Load more').length`)).toBe(0);
    expect(await page.eval<string>(`document.querySelector('main [role=status]').textContent`)).toContain("7 resets shown, end of the log");
  }, 60_000);

  test("a filter writes the URL with history replace and the request follows", async () => {
    await open("/logs/resets", 3);
    const before = await historyLength();
    await choose("Identity", C);
    await waitFor("the identity URL", 5_000, async () => (await search()) === `?identity=${C}`);
    await waitFor("the filtered rows", 10_000, async () => (await rowIds()).join() === "2,5");
    expect(requests.at(-1)).toBe(`?identity=${C}&limit=50`);
    await choose("Outcome", "Rejected");
    await waitFor("the outcome URL", 5_000, async () => (await search()) === `?identity=${C}&outcome=rejected`);
    await waitFor("one row", 10_000, async () => (await rowIds()).join() === "5");
    await choose("Provider", "Codex");
    await choose("Trigger", "Manual");
    await waitFor("every key", 5_000, async () => (await search()) === `?identity=${C}&provider=codex&trigger=manual&outcome=rejected`);
    await setDate("From date", iso(-3 * D).slice(0, 10));
    await setDate("To date", iso(0).slice(0, 10));
    await waitFor("the date URL", 5_000, async () => (await search()).includes("&from=") && (await search()).includes("&to="));
    expect(await historyLength()).toBe(before);
    expect(requests.at(-1)).toContain("&from=");
    // Clearing one filter removes its key and the others stay.
    await choose("Outcome", "All outcomes");
    await waitFor("the outcome key to go", 5_000, async () => !(await search()).includes("outcome"));
    expect(await historyLength()).toBe(before);
    await clickAt(`[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === 'Clear filters')`);
    await waitFor("a plain URL", 5_000, async () => (await search()) === "");
    await waitFor("every row again", 10_000, async () => (await rowIds()).length === 3);
    expect(await historyLength()).toBe(before);
  }, 90_000);

  test("the URL alone rebuilds the view: the controls show the filters and the request uses them", async () => {
    const query = `?identity=${A}&provider=claude&trigger=manual&outcome=reset&from=2026-01-01&to=2099-12-31`;
    await open(`/logs/resets${query}`, 2);
    expect(requests).toEqual([`?identity=${A}&provider=claude&trigger=manual&outcome=reset&from=2026-01-01&to=2099-12-31&limit=50`]);
    expect(await search()).toBe(query);
    expect(await selectText("Identity")).toBe(A);
    expect(await selectText("Provider")).toBe("Claude");
    expect(await selectText("Trigger")).toBe("Manual");
    expect(await selectText("Outcome")).toBe("Reset");
    expect(await page.eval<string>(`document.querySelector('input[aria-label="From date"]').value`)).toBe("2026-01-01");
    expect(await page.eval<string>(`document.querySelector('input[aria-label="To date"]').value`)).toBe("2099-12-31");
    expect(await rowIds()).toEqual(["1", "7"]);
    await shot("reset-log-2-filtered.png");
  }, 60_000);

  test("an invalid or unknown value is dropped from the URL with history replace", async () => {
    await open("/logs/resets?provider=grok&junk=1&trigger=auto&from=2026-02-30&outcome=maybe", 3);
    await waitFor("the corrected URL", 5_000, async () => (await search()) === "?trigger=auto");
    await waitFor("the automatic rows", 10_000, async () => (await rowIds()).join() === "2,3,6");
    expect(await selectText("Provider")).toBe("All providers");
    expect(requests.every((r) => !r.includes("grok") && !r.includes("junk") && !r.includes("2026-02-30"))).toBe(true);
    // The wrong address left no entry of its own behind: Back leaves the page.
    await page.eval("history.back()");
    await waitFor("the entry before", 5_000, async () => (await pathname()) !== "/logs/resets" || (await search()) !== "?trigger=auto");
    expect(await search()).not.toContain("grok");
  }, 60_000);

  test("/logs redirects to /logs/resets, keeps the query and leaves no history entry of its own", async () => {
    await open("/logs/resets", 3);
    const direct = await historyLength();
    await open("/logs", 3);
    expect(await pathname()).toBe("/logs/resets");
    expect(await historyLength()).toBe(direct + 1);
    await open(`/logs?identity=${B}`, 2);
    expect(await pathname()).toBe("/logs/resets");
    expect(await search()).toBe(`?identity=${B}`);
    expect(await rowIds()).toEqual(["3", "6"]);
  }, 60_000);

  test("the main navigation has a Logs entry, and Back and Forward restore the filtered view", async () => {
    await open("/limits", null);
    expect(await page.eval<string>(`document.querySelector('nav[aria-label=Main] a[href="/logs"]').textContent.trim()`)).toBe("Logs");
    await clickAt(`document.querySelector('nav[aria-label=Main] a[href="/logs"]')`);
    await waitFor("the log page", 10_000, async () => (await pathname()) === "/logs/resets" && (await rowIds()).length === 3);
    expect(await page.eval<string>(`document.querySelector('nav[aria-label=Main] a[href="/logs"]').getAttribute('aria-current')`)).toBe("page");
    await choose("Identity", B);
    await waitFor("the filter", 5_000, async () => (await search()) === `?identity=${B}`);
    await page.eval("history.back()");
    await waitFor("the Limits page", 5_000, async () => (await pathname()) === "/limits");
    await page.eval("history.forward()");
    await waitFor("the log page again", 5_000, async () => (await pathname()) === "/logs/resets");
    expect(await search()).toBe(`?identity=${B}`);
    await waitFor("the filtered rows", 10_000, async () => (await rowIds()).join() === "3,6");
    expect(await selectText("Identity")).toBe(B);
  }, 60_000);

  test("an identity with no log row stays selectable and shows an honest empty state", async () => {
    await open(`/logs/resets?identity=${UNUSED}`, null);
    await waitFor("the empty state", 10_000, async () => (await mainText()).includes("No resets match these filters"));
    expect(await selectText("Identity")).toBe(UNUSED);
    expect(await rowIds()).toEqual([]);
    expect(await mainText()).not.toMatch(/\b0 resets/);
    await shot("reset-log-3-empty.png", false);
  }, 60_000);

  test("a failed request shows the error and no row", async () => {
    await open(`/logs/resets?identity=${BOOM}`, null);
    await waitFor("the error", 20_000, async () => (await mainText()).includes("SYNTHETIC_FIXTURE the log store is down"));
    expect(await rowIds()).toEqual([]);
    expect(await mainText()).not.toContain("No resets");
  }, 60_000);

  for (const width of [360, 1440]) {
    test(`the page stays inside the screen at ${width} px`, async () => {
      await setViewport(width, 900);
      try {
        await open("/logs/resets", 3);
        const m = await page.eval<{ scrollWidth: number; clientWidth: number; offenders: string[] }>(`(() => {
          const de = document.documentElement;
          const container = document.querySelector('main [data-slot=table-container]');
          const cr = container.getBoundingClientRect();
          const offenders = [...document.querySelectorAll('main > div > *:not([aria-label=Resets]) *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > de.clientWidth + 1; }).map(el => el.tagName + '.' + String(el.className).slice(0, 40));
          if (cr.right > de.clientWidth + 1) offenders.push('table-container');
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders };
        })()`);
        expect(m.scrollWidth <= m.clientWidth, JSON.stringify(m)).toBe(true);
        expect(m.offenders, JSON.stringify(m)).toEqual([]);
        await shot(`reset-log-4-width-${width}.png`, false);
      } finally {
        await setViewport(1440, 900);
      }
    }, 60_000);
  }
});

describe("Limits page links to the reset log", () => {
  test("each identity card has a Reset log link filtered by that identity", async () => {
    await open("/limits/anthropic", null);
    await waitFor("the cards", 20_000, async () => page.eval<boolean>(`!!document.querySelector('a[aria-label="Reset log for ${A}"]')`));
    const hrefs = await page.eval<Record<string, string | null>>(`Object.fromEntries([${JSON.stringify(A)}, ${JSON.stringify(B)}].map(n => [n, document.querySelector('a[aria-label="Reset log for ' + n + '"]')?.getAttribute('href') ?? null]))`);
    expect(hrefs).toEqual({ [A]: `/logs/resets?identity=${A}`, [B]: `/logs/resets?identity=${B}` });
    // A real anchor with an href, so a middle click opens it in a new tab.
    expect(await page.eval<string>(`document.querySelector('a[aria-label="Reset log for ${A}"]').tagName`)).toBe("A");
    await shot("reset-log-5-limits-button.png", false);
    // The link opens the log for that identity: the select shows it and the request carries it.
    requests.length = 0;
    await clickAt(`document.querySelector('a[aria-label="Reset log for ${B}"]')`);
    await waitFor("the filtered log", 10_000, async () => (await pathname()) === "/logs/resets" && (await rowIds()).join() === "3,6");
    expect(await search()).toBe(`?identity=${B}`);
    expect(requests).toEqual([`?identity=${B}&limit=50`]);
    expect(await selectText("Identity")).toBe(B);
    await page.eval("history.back()");
    await waitFor("the Limits page", 5_000, async () => (await pathname()) === "/limits/anthropic");
  }, 60_000);
});
