// End-to-end: the built WebUI served by a real console daemon, driven in real Chromium over CDP at phone widths.
//
// Not picked up by plain `bun test` (the file name has no .test. part). Run from the repo root with:
//   (cd apps/web && pnpm install --frozen-lockfile && pnpm build) && bun run test:e2e:web
// Env: AIS_E2E_CHROMIUM (binary), AIS_E2E_EVIDENCE (dir for screenshots).
//
// Asserts, for every route of apps/web/src/App.tsx at 360x740 and 390x844:
//   document.documentElement.scrollWidth <= clientWidth (no horizontal page overflow);
// and that on a narrow screen the menu button opens the navigation, Escape closes it, and following a link closes it.
// With a stubbed limits answer it also asserts on /limits at each width and at 1280x900: no reset line or badge clips
// text, no box cuts a countdown off, each countdown is in one piece inside its card, no line starts with the separator,
// and the plan badge stays clear of the status badge. The reset lines are found by their text, not by the markup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, type Session } from "../../chrome-extension/test/e2e/cdp.ts";
import { countdownUntil } from "../src/lib/format.ts";
import { formatResetTimes } from "../src/lib/reset-time.ts";
import type { LimitsResponse, PoolsUsageResponse } from "../src/types/api.ts";

const repoRoot = join(import.meta.dir, "../../..");
const distDir = process.env.AIS_WEB_DIST ?? join(repoRoot, "apps/web/dist");
const chromium = process.env.AIS_E2E_CHROMIUM
  ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(p => existsSync(p));
const evidence = process.env.AIS_E2E_EVIDENCE;
const scratchRoot = process.env.AIS_WEB_E2E_SCRATCH ?? tmpdir();

const ROUTES = [
  "/", "/identities", "/local-models", "/local-models/example", "/limits", "/usage", "/usage/gateway", "/gateway", "/usage/models", "/usage/sources", "/usage/projects", "/usage/repos", "/usage/orgs", "/dashboard/herdr", "/dashboard/processes", "/breakdown", "/breakdown/consumers",
  "/sessions", "/auth", "/browsers", "/permissions", "/files", "/no-such-page",
];
const VIEWPORTS = [{ width: 360, height: 740 }, { width: 390, height: 844 }];
const LONG = "VeryLongUnbrokenTokenVeryLongUnbrokenTokenVeryLongUnbrokenTokenVeryLong";
// The e2e identities have no credentials, so the daemon never reports reset times. This synthetic answer does.
// 12 days and 17 hours give a long countdown text, so a reset line wraps at 360 px and on the desktop grid.
const RESET_AT = Date.now() + 12 * 86_400_000 + 17 * 3_600_000 + 23 * 60_000;
const SYNTHETIC_IDENTITY = { label: "Synthetic identity", configDir: "synthetic" };
const SYNTHETIC_LIMITS: LimitsResponse = {
  cached: false,
  fetchedAt: new Date().toISOString(),
  results: [
    {
      toolName: "claude",
      provider: "anthropic",
      identity: { name: "SYNTHETIC_FIXTURE-long-plan", ...SYNTHETIC_IDENTITY },
      status: "live",
      plan: "Self Serve Business Prolite",
      windows: [
        { label: "Session", category: "session", usedPercent: 40, resetsAtMs: RESET_AT },
        { label: "Week", category: "week", usedPercent: 95, resetsAtMs: RESET_AT + 86_400_000, note: "over budget: $1234.56 of $1000.00" },
        { label: "Month", category: "month", usedPercent: 100, resetsAtMs: RESET_AT - 60_000 }, // a reset in the past shows "now"
      ],
    },
    {
      toolName: "claude",
      provider: "anthropic",
      identity: { name: "SYNTHETIC_FIXTURE-short-plan", ...SYNTHETIC_IDENTITY },
      status: "live",
      plan: "Go",
      windows: [{ label: "Session", category: "session", usedPercent: 10, resetsAtMs: RESET_AT }],
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-credit", ...SYNTHETIC_IDENTITY },
      status: "live",
      gatewayManaged: true,
      windows: [{ label: "Week", category: "week", usedPercent: 70, resetsAtMs: RESET_AT }],
      manualReset: {
        availableCount: 2,
        label: "Full reset",
        creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_003", label: "Full reset", endsAt: "2026-12-01T22:27:07.649Z" }],
      },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-other-credit", ...SYNTHETIC_IDENTITY },
      status: "live",
      gatewayManaged: true,
      windows: [],
      manualReset: { availableCount: 5 },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-zero", ...SYNTHETIC_IDENTITY },
      status: "live",
      windows: [{ label: "Week", category: "week", usedPercent: 0, resetsAtMs: RESET_AT }],
      manualReset: { availableCount: 0 },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-stale", ...SYNTHETIC_IDENTITY },
      status: "live",
      windows: [],
      manualReset: { availableCount: 2, stale: true },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-cached", ...SYNTHETIC_IDENTITY },
      status: "cached",
      windows: [],
      manualReset: { availableCount: 2 },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-unknown", ...SYNTHETIC_IDENTITY },
      status: "unavailable",
      windows: [],
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-retired", ...SYNTHETIC_IDENTITY, retired: true },
      status: "live",
      windows: [],
      manualReset: { availableCount: 2 },
    },
    {
      toolName: "codex",
      provider: "openai",
      identity: { name: "SYNTHETIC_FIXTURE-codex-pool", ...SYNTHETIC_IDENTITY, swapPool: { accounts: ["member"] } },
      status: "live",
      windows: [],
      manualReset: { availableCount: 2 },
    },
  ],
};
// One pool with both identities. A pool card shows the reset of the window with the highest use of each member.
const SYNTHETIC_POOLS: PoolsUsageResponse = {
  todayKey: "2026-11-25",
  weekStartKey: "2026-11-19",
  pools: [{ tool: "claude", name: "SYNTHETIC_FIXTURE-pool", active: "SYNTHETIC_FIXTURE-long-plan", members: SYNTHETIC_LIMITS.results.map((r) => ({ name: r.identity.name, allowed: true })) }],
  gateway: { today: { configured: false, rows: [] }, week: { configured: false, rows: [] } },
};
const POOL_RESETS = SYNTHETIC_LIMITS.results.filter((r) => r.windows.length > 0).map((r) => r.windows.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst)).resetsAtMs!);

/** What the page reports about the Limits cards. */
type LimitsCheck = { lines: number; wrapped: number; notes: number; poolLines: number; poolWrapped: number; plans: number; problems: string[] };

/** The left and the right edge of a box in the page, in px. */
type Box = { left: number; right: number };

/** One character of the rendered text of an element: its box and the character. */
type Char = { top: number; left: number; right: number; ch: string };

const LIMITS_ANSWERS: Record<string, unknown> = { "/api/limits": SYNTHETIC_LIMITS, "/api/pools/usage": SYNTHETIC_POOLS };

/**
 * Runs in the page before each document: it answers the limits routes with the synthetic data. The real fetch serves
 * each other path. The test sends the source of each page function with its `toString()`.
 */
function limitsStub(answers: Record<string, unknown>): void {
  const real = window.fetch.bind(window);
  const stub = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    const answer = u.origin === location.origin && Object.hasOwn(answers, u.pathname) ? answers[u.pathname] : undefined;
    return answer === undefined
      ? real(input, init)
      : Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
  };
  // The type of fetch has a preconnect member. The stub keeps the member of the page.
  window.fetch = Object.assign(stub, { preconnect: window.fetch.preconnect });
}

/** Adds one synthetic spend endpoint. It never reaches the console or a provider. */
function limitsAndSpendStub(answers: Record<string, unknown>): void {
  const real = window.fetch.bind(window);
  const calls: Array<{ path: string; method: string; body: string | null }> = [];
  const stub = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, location.href);
    if (u.origin === location.origin && Object.hasOwn(answers, u.pathname)) {
      return Promise.resolve(new Response(JSON.stringify(answers[u.pathname]), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (u.origin === location.origin && u.pathname.startsWith("/api/limits/codex/") && u.pathname.endsWith("/resets/use")) {
      calls.push({ path: u.pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      const status = (window as unknown as { __aisCodexResetStatus?: number }).__aisCodexResetStatus ?? 200;
      return Promise.resolve(status === 200
        ? Response.json({ identity: "SYNTHETIC_FIXTURE-codex-credit" })
        : Response.json({ error: "Codex refused reset (SYNTHETIC_FIXTURE)" }, { status }));
    }
    return real(input, init);
  };
  Object.assign(window, { __aisCodexResetCalls: calls });
  window.fetch = Object.assign(stub, { preconnect: window.fetch.preconnect });
}

/** Runs in the page: the innermost elements that show one of the given texts. The markup of the page does not matter. */
function withText(wanted: string[]): Element[] {
  const text = (el: Element) => (el.textContent ?? "").replace(/[\s\u00a0]+/g, " ").trim();
  const found = [...document.querySelectorAll("main *")].filter((el) => wanted.includes(text(el)));
  return found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
}

/**
 * Runs in the page. Finds the reset lines, the notes and the plan badges by their text, so the markup of the page is
 * free, and names each rule of the Limits cards that is broken.
 */
function limitCheck(
  args: { expected: string[]; times: string[]; notes: string[]; plans: string[] },
  withText: (wanted: string[]) => Element[],
): LimitsCheck {
  const R = (el: Element) => el.getBoundingClientRect();
  const text = (el: Element) => (el.textContent ?? "").replace(/[\s\u00a0]+/g, " ").trim();
  const inside = (r: Box, box: Box) => r.left >= box.left - 1 && r.right <= box.right + 1;
  // True when the element can hide part of its content.
  const guarded = (el: Element) => {
    const cs = getComputedStyle(el);
    return cs.overflowX !== "visible" || cs.overflowY !== "visible" || el.classList.contains("truncate");
  };
  const clips = (el: Element) => guarded(el) && el.scrollWidth > el.clientWidth + 1;
  // The content box of the card part an element is in. The header and the content of a card have the same box.
  const cardBox = (el: Element): Box => {
    const part = el.closest("[data-slot=card-content], [data-slot=card-header]") ?? el;
    const r = R(part);
    const cs = getComputedStyle(part);
    return {
      left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
      right: r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
    };
  };
  // One box for each character that has one, in the order of the text.
  const chars = (root: Element): Char[] => {
    const out: Char[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? "";
      for (let i = 0; i < value.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        // A character in a span can give two rects. Their union is the box of the character.
        const r = range.getBoundingClientRect();
        if (r.width > 0) out.push({ top: r.top, left: r.left, right: r.right, ch: value[i]! });
      }
    }
    return out;
  };
  // The text of each line box, from the top line down. Characters whose tops are less than 4 px apart are on one line.
  const lineTexts = (cs: Char[]) => {
    const lines: Char[][] = [];
    for (const c of [...cs].sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      if (last && c.top - last[0]!.top < 4) last.push(c);
      else lines.push([c]);
    }
    return lines.map((l) => [...l].sort((a, b) => a.left - b.left).map((c) => c.ch).join(""));
  };
  const boxOf = (cs: Char[]): Box => ({ left: Math.min(...cs.map((c) => c.left)), right: Math.max(...cs.map((c) => c.right)) });
  // A box up to the card that hides its overflow and holds part of a box outside its edge.
  const cutBy = (el: Element, box: Box): string | undefined => {
    const card = el.closest("[data-slot=card]");
    for (let a: Element | null = el; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const hidden = ["hidden", "clip"].includes(cs.overflowX) || ["hidden", "clip"].includes(cs.overflowY);
      if (hidden && !inside(box, R(a))) return a.tagName.toLowerCase() + "." + String(a.className).slice(0, 60);
      if (a === card) break;
    }
    return undefined;
  };

  const problems: string[] = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) problems.push(`page overflow: ${root.scrollWidth} > ${root.clientWidth}`);
  // One reset line: "<times> · <countdown>" on an identity card, "Resets <times> · <countdown>" on a pool card.
  const check = (el: Element) => {
    const full = text(el);
    const pool = full.startsWith("Resets ");
    const box = cardBox(el);
    const cs = chars(el);
    // The countdown is the end of the line.
    const countdown = full.slice(full.lastIndexOf(" · ") + 3);
    if (cs.length < countdown.length) {
      problems.push(`the line has no rendered text: "${full}"`);
      return { pool, wrapped: false };
    }
    const tail = cs.slice(-countdown.length);
    const tailBox = boxOf(tail);
    if (tail.map((c) => c.ch).join("") !== countdown) problems.push(`the countdown is not one run of characters: "${full}"`);
    if (clips(el) || [...el.querySelectorAll("*")].some(clips)) problems.push(`clipped text: "${full}"`);
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`text wider than its box: "${full}"`);
    const cut = cutBy(el, tailBox);
    if (cut) problems.push(`the countdown is cut off by ${cut}: "${full}"`);
    if (lineTexts(tail).length !== 1) problems.push(`countdown over two lines: "${full}"`);
    if (!inside(tailBox, box)) problems.push(`countdown outside the card: "${full}"`);
    const lines = lineTexts(cs);
    // The separator can be a non-breaking space and a dot: both must stay off the start of a line.
    if (lines.some((l) => /^\s*\u00b7/.test(l))) problems.push(`a line starts with the separator: "${full}"`);
    if (!pool) {
      // The tooltip of the line shows the reset times.
      const title = el instanceof HTMLElement ? el.title : "";
      if (!args.times.includes(title)) problems.push(`the tooltip with the reset times is missing: "${full}"`);
      // A bound separator ends a line, so the line after it holds the countdown alone.
      const first = lines[lines.length - 2];
      const second = lines[lines.length - 1];
      if (lines.length > 1 && (!first?.endsWith("\u00b7") || !/^(in .+|now)$/.test(second ?? ""))) {
        problems.push(`a wrapped line does not end with the separator, or the line after it is not the countdown alone: ${JSON.stringify(lines)}`);
      }
    }
    return { pool, wrapped: lines.length > 1 };
  };
  let lines = 0;
  let wrapped = 0;
  let poolLines = 0;
  let poolWrapped = 0;
  for (const el of withText(args.expected)) {
    const r = check(el);
    if (r.pool) poolLines++;
    else lines++;
    if (r.wrapped) {
      if (r.pool) poolWrapped++;
      else wrapped++;
    }
  }
  const notes = withText(args.notes);
  for (const note of notes) {
    const box = cardBox(note);
    const r = R(note);
    if (clips(note) || !inside(r, box)) problems.push(`note clipped or outside the card: "${note.textContent}"`);
    if (r.right < box.right - 1) problems.push(`note is not at the right edge of the card: "${note.textContent}"`);
  }
  // The badge that shows a plan text, and the other badge of the same header: the status badge.
  let plans = 0;
  const badges = [...document.querySelectorAll("main [data-slot=badge]")];
  for (const plan of badges.filter((b) => args.plans.includes(text(b)))) {
    plans++;
    const box = cardBox(plan);
    const header = plan.closest("[data-slot=card-header]");
    const status = header ? [...header.querySelectorAll("[data-slot=badge]")].find((b) => b !== plan) : undefined;
    if (!status) {
      problems.push(`plan badge without a status badge: "${plan.textContent}"`);
      continue;
    }
    if (clips(plan)) problems.push(`clipped plan badge: "${plan.textContent}"`);
    if (clips(status)) problems.push(`clipped status badge: "${status.textContent}"`);
    const p = R(plan);
    const s = R(status);
    if (!inside(p, box)) problems.push(`plan badge outside the card: "${plan.textContent}"`);
    if (!inside(s, box)) problems.push(`status badge outside the card: "${status.textContent}"`);
    if (p.left < s.right - 1 && s.left < p.right - 1 && p.top < s.bottom - 1 && s.top < p.bottom - 1) {
      problems.push(`plan badge covers the status badge: "${plan.textContent}"`);
    }
  }
  return { lines, wrapped, notes: notes.length, poolLines, poolWrapped, plans, problems };
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

// The countdown text can change while the page renders. Each accepted instant gives one accepted text.
const COUNTDOWN_INSTANTS = [0, -20_000, -40_000, 5_000];

/** Opens a limits route with the synthetic data and asserts the rules of the Limits cards at one viewport. */
async function checkLimitsCards(
  width: number,
  height: number,
  route: string,
  counts: { lines: number; notes: number; plans: number; poolLines: number; wrappedAtLeast: number },
): Promise<void> {
  await setViewport(width, height);
  const { identifier } = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${limitsStub.toString()})(${JSON.stringify(LIMITS_ANSWERS)})`,
  });
  try {
    await open(route);
    const texts = (ms: number) =>
      COUNTDOWN_INSTANTS.map((dt) => {
        const countdown = countdownUntil(ms, Date.now() + dt);
        return countdown === "now" ? "now" : `in ${countdown}`;
      });
    const expected = [
      ...SYNTHETIC_LIMITS.results.flatMap((r) => r.windows.flatMap((w) => texts(w.resetsAtMs!).map((c) => `${formatResetTimes(w.resetsAtMs!)} · ${c}`))),
      ...POOL_RESETS.flatMap((ms) => texts(ms).map((c) => `Resets ${formatResetTimes(ms)} · ${c}`)),
    ];
    // Wait until each reset line of the route is on the page. A line is found by its text, so the page markup is free.
    await waitFor("limits rows", 10_000, async () =>
      (await page.eval<number>(`(${withText.toString()})(${JSON.stringify(expected)}).length`)) >= counts.lines + counts.poolLines);
    await sleep(300);
    const resets = [...SYNTHETIC_LIMITS.results.flatMap((r) => r.windows.map((w) => w.resetsAtMs!)), ...POOL_RESETS];
    const times = [...new Set(resets.map((ms) => formatResetTimes(ms)))];
    const notes = [...new Set(SYNTHETIC_LIMITS.results.flatMap((r) => r.windows.flatMap((w) => (w.note ? [w.note] : []))))];
    const plans = [...new Set(SYNTHETIC_LIMITS.results.flatMap((r) => (r.plan ? [r.plan] : [])))];
    const checkArgs = JSON.stringify({ expected, times, notes, plans });
    const m = await page.eval<LimitsCheck>(`(${limitCheck.toString()})(${checkArgs}, ${withText.toString()})`);
    const detail = JSON.stringify(m);
    console.log(`limits cards at ${width}px ${route}: ${detail}`);
    expect(m.problems, detail).toEqual([]);
    expect(m.lines, detail).toBe(counts.lines);
    expect(m.wrapped, detail).toBeGreaterThanOrEqual(counts.wrappedAtLeast);
    expect(m.notes, detail).toBe(counts.notes);
    expect(m.plans, detail).toBe(counts.plans);
    expect(m.poolLines, detail).toBe(counts.poolLines);
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      const name = route === "/limits" ? "overview" : route.slice("/limits/".length);
      await writeFile(join(evidence, `${width}-limits-${name}.png`), await page.screenshot());
    }
  } finally {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
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
  await mkdir(scratchRoot, { recursive: true });
  runDir = await mkdtemp(join(scratchRoot, "ais-web-e2e-"));
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

    // Identity cards: three lines on the card with the long plan, one line on the card with the short plan.
    // The rule of the separator needs a line that wraps. At 360 px a reset line is too long for the card.
    test("/limits/anthropic keeps each reset countdown in full", async () => {
      await checkLimitsCards(vp.width, vp.height, "/limits/anthropic", { lines: 4, notes: 1, plans: 2, poolLines: 0, wrappedAtLeast: vp.width === 360 ? 1 : 0 });
    }, 40_000);

    test("/limits/openai shows Codex reset availability, expiry, and known zero", async () => {
      await setViewport(vp.width, vp.height);
      const { identifier } = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${limitsStub.toString()})(${JSON.stringify(LIMITS_ANSWERS)})`,
      });
      try {
        await open("/limits/openai");
        await waitFor("Codex manual reset states", 10_000, async () => page.eval<boolean>(`(() => {
          const text = document.querySelector('main')?.innerText ?? '';
          return text.includes('Manual reset available ×2: Full reset') && text.includes('No manual reset available');
        })()`));
        const state = await page.eval<{ positive: boolean; zero: boolean; expiry: boolean }>(`(() => {
          const text = document.querySelector('main')?.innerText ?? '';
          return {
            positive: text.includes('Manual reset available ×2: Full reset'),
            zero: text.includes('No manual reset available'),
            expiry: text.includes('Full reset: expires'),
          };
        })()`);
        expect(state).toEqual({ positive: true, zero: true, expiry: true });
        expect(await page.eval<number>(`document.querySelectorAll('main button[aria-label^="Use reset on"]').length`)).toBe(2);
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, `${vp.width}-limits-codex-resets.png`), await page.screenshot());
          await page.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
          await sleep(200);
          await writeFile(join(evidence, `${vp.width}-limits-codex-resets-zero.png`), await page.screenshot());
        }
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      }
    }, 40_000);

    test("Codex reset confirmation cancels safely and sends one mocked request", async () => {
      await setViewport(vp.width, vp.height);
      const { identifier } = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${limitsAndSpendStub.toString()})(${JSON.stringify(LIMITS_ANSWERS)})`,
      });
      try {
        await open("/limits/openai");
        const resetButton = 'main button[aria-label="Use reset on SYNTHETIC_FIXTURE-codex-credit"]';
        await waitFor("eligible Codex reset button", 8_000, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(resetButton)})`));
        await page.eval(`document.querySelector(${JSON.stringify(resetButton)}).scrollIntoView({ block: 'center' })`);
        await page.eval(`document.querySelector(${JSON.stringify(resetButton)}).click()`);
        await waitFor("Codex reset confirmation", 5_000, () => page.eval<boolean>(`!!document.querySelector('[role=alertdialog]')`));
        const prompt = await page.eval<string>(`document.querySelector('[role=alertdialog]')?.innerText ?? ''`);
        expect(prompt).toContain("Use a reset on SYNTHETIC_FIXTURE-codex-credit?");
        expect(prompt).toContain("one of 2 available reset credits");
        if (evidence) {
          await sleep(300);
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, `${vp.width}-codex-reset-confirmation-multi.png`), await page.screenshot());
        }
        await page.eval(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim() === 'Cancel').click()`);
        await waitFor("cancelled Codex reset confirmation", 5_000, () => page.eval<boolean>(`!document.querySelector('[role=alertdialog]')`));
        expect(await page.eval<number>(`window.__aisCodexResetCalls.length`)).toBe(0);

        await page.eval(`document.querySelector(${JSON.stringify(resetButton)}).click()`);
        await waitFor("second Codex reset confirmation", 5_000, () => page.eval<boolean>(`!!document.querySelector('[role=alertdialog]')`));
        await page.eval(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim() === 'Confirm use reset').click(); [...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim() === 'Confirm use reset')?.click()`);
        await waitFor("mocked Codex reset success", 5_000, () => page.eval<boolean>(`!document.querySelector('[role=alertdialog]') && document.body.innerText.includes('Reset used')`));
        expect(await page.eval<Array<{ path: string; method: string }>>(`window.__aisCodexResetCalls.map(({ path, method }) => ({ path, method }))`)).toEqual([
          { path: "/api/limits/codex/SYNTHETIC_FIXTURE-codex-credit/resets/use", method: "POST" },
        ]);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      }
    }, 40_000);

    test("Codex reset provider refusal stays visible and does not retry", async () => {
      await setViewport(vp.width, vp.height);
      const { identifier } = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${limitsAndSpendStub.toString()})(${JSON.stringify(LIMITS_ANSWERS)})`,
      });
      try {
        await open("/limits/openai");
        await page.eval(`window.__aisCodexResetStatus = 409`);
        const resetButton = 'main button[aria-label="Use reset on SYNTHETIC_FIXTURE-codex-credit"]';
        await waitFor("eligible Codex reset button", 8_000, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(resetButton)})`));
        await page.eval(`document.querySelector(${JSON.stringify(resetButton)}).click()`);
        await waitFor("Codex reset confirmation", 5_000, () => page.eval<boolean>(`!!document.querySelector('[role=alertdialog]')`));
        await page.eval(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.textContent.trim() === 'Confirm use reset').click()`);
        await waitFor("Codex refusal feedback", 5_000, () => page.eval<boolean>(`!!document.querySelector('[role=alertdialog] [role=alert]')`));
        expect(await page.eval<string>(`document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? ''`)).toContain("Codex refused reset");
        await sleep(300);
        expect(await page.eval<number>(`window.__aisCodexResetCalls.length`)).toBe(1);
      } finally {
        await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      }
    }, 40_000);

    // Pool cards: one reset line for each member of the pool.
    test("/limits keeps each pool reset countdown in full", async () => {
      await checkLimitsCards(vp.width, vp.height, "/limits", { lines: 0, notes: 0, plans: 0, poolLines: 2, wrappedAtLeast: 0 });
    }, 40_000);

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

// The desktop grid. The countdown was cut off here, and a long plan badge covered the status badge.
describe("1280x900", () => {
  // Each card of the grid is narrow, so every reset line wraps here.
  test("/limits/anthropic keeps each reset countdown in full", async () => {
    await checkLimitsCards(1280, 900, "/limits/anthropic", { lines: 4, notes: 1, plans: 2, poolLines: 0, wrappedAtLeast: 1 });
  }, 40_000);

  test("Codex reset control renders beside credits on desktop", async () => {
    await setViewport(1280, 900);
    const { identifier } = await page.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${limitsAndSpendStub.toString()})(${JSON.stringify(LIMITS_ANSWERS)})`,
    });
    try {
      await open("/limits/openai");
      const resetButton = 'main button[aria-label="Use reset on SYNTHETIC_FIXTURE-codex-credit"]';
      await waitFor("eligible desktop Codex reset button", 8_000, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(resetButton)})`));
      expect(await page.eval<number>(`document.querySelectorAll('main button[aria-label^="Use reset on"]').length`)).toBe(2);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, "1280-codex-reset-limits-multi.png"), await page.screenshot());
      }
    } finally {
      await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }, 40_000);

  test("/limits keeps each pool reset countdown in full", async () => {
    await checkLimitsCards(1280, 900, "/limits", { lines: 0, notes: 0, plans: 0, poolLines: 2, wrappedAtLeast: 0 });
  }, 40_000);
});
