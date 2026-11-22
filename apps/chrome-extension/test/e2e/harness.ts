// Shared pieces of the real-Chromium end-to-end tests: build the extension, start Chromium, sign the browser in,
// reach extension pages over CDP, and the small wait helpers. Each e2e file keeps its own state and calls these.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountBrowserAuthorize } from "../../../../src/server/browser-authorize.ts";
import type { CallResult } from "../../../../src/browser/protocol.ts";
import { Cdp, type Session } from "./cdp.ts";

export const ADMIN = "adm-e2e-value-0001-0123456789abcdef";
export const extRoot = join(import.meta.dir, "../..");
export const repoRoot = join(import.meta.dir, "../../../..");
export const chromium = process.env.AIS_E2E_CHROMIUM ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(p => existsSync(p));
export const evidence = process.env.AIS_E2E_EVIDENCE;

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Races a step against a labelled timeout, so a hang names the step instead of timing the whole test out. */
export async function step<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`step "${label}" timed out after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

/** The environment for a child that must not inherit the caller's own agent session (its session id and thread title would leak into the test). */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(CLAUDE|CODEX|T3CODE|AIS_|AI_PROFILE)/.test(k) || k === "CLAUDECODE") continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** Writes an evidence file when AIS_E2E_EVIDENCE is set. */
export async function save(name: string, bytes: Buffer): Promise<void> {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, name), bytes);
}

export async function dumpLogs(files: string[]): Promise<void> {
  for (const f of files) {
    const text = await readFile(f, "utf8").catch(() => "");
    if (text.trim()) console.error(`--- tail of ${f}\n${text.split("\n").slice(-25).join("\n")}`);
  }
}

/** A scratch directory for one run, with the logs directory made. */
export async function makeRunDir(): Promise<string> {
  const base = process.env.AIS_E2E_TMP ?? tmpdir();
  await mkdir(base, { recursive: true });
  const runDir = await mkdtemp(join(base, "ais-e2e-"));
  await mkdir(join(runDir, "logs"), { recursive: true });
  return runDir;
}

/** Builds the extension into `<runDir>/ext` (never the shared dist/) with the e2e inspection hooks. Returns the real path. */
export async function buildExtension(runDir: string): Promise<string> {
  await mkdir(join(runDir, "ext"));
  const extDir = realpathSync(join(runDir, "ext"));
  const built = Bun.spawnSync(["bun", "run", "build.ts", extDir], { cwd: extRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, AIS_E2E: "1" } }); // AIS_E2E keeps the overlay inspection hooks in this build only
  if (built.exitCode !== 0) throw new Error(`extension build failed: ${built.stderr.toString()}`);
  return extDir;
}

export interface Browser { proc: ReturnType<typeof Bun.spawn>; cdp: Cdp; extId: string }

/** Starts headless Chromium with the unpacked extension and connects CDP. */
export async function launchChromium(runDir: string, extDir: string): Promise<Browser> {
  const proc = Bun.spawn([
    chromium!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${join(runDir, "profile")}`, "--remote-debugging-port=0", `--load-extension=${extDir}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch", "--window-size=1280,800", "about:blank",
  ], { stdout: "ignore", stderr: Bun.file(join(runDir, "logs", "chromium.log")) });
  const wsUrl = await step("chromium start (DevToolsActivePort)", 90_000, until("DevToolsActivePort", async () => {
    const f = Bun.file(join(runDir, "profile", "DevToolsActivePort"));
    if (!(await f.exists())) return undefined;
    const [port, path] = (await f.text()).trim().split("\n");
    return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
  }, 90_000));
  const cdp = await step("CDP connect", 30_000, Cdp.connect(wsUrl));
  // Unpacked extension id: first 32 hex digits of sha256(path), mapped onto a-p.
  const extId = [...createHash("sha256").update(extDir).digest("hex").slice(0, 32)].map(c => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
  return { proc, cdp, extId };
}

export async function targets(cdp: Cdp): Promise<Array<{ type: string; url: string; targetId: string }>> {
  return (await cdp.send<{ targetInfos: Array<{ type: string; url: string; targetId: string }> }>("Target.getTargets")).targetInfos;
}

export async function pageSession(cdp: Cdp, match: (url: string) => boolean): Promise<Session> {
  const t = await until("page target", async () => (await targets(cdp)).find(x => x.type === "page" && match(x.url)));
  return cdp.attach(t.targetId);
}

export async function extensionPage(cdp: Cdp, extId: string, path: string): Promise<Session> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `chrome-extension://${extId}/${path}` });
  return cdp.attach(targetId);
}

export interface SignInOptions {
  cdp: Cdp;
  extId: string;
  gatewayPort: number;
  adminPort: number;
  /** The label the browser shows for itself. */
  profileLabel?: string;
}

/**
 * Signs the extension in through the console sign-in page, which runs in-process against the real gateway (public pair + admin approve + poll).
 * Returns the service worker session and a side panel page that stays open.
 */
export async function signIn(o: SignInOptions): Promise<{ sw: Session; panel: Session }> {
  const { cdp, extId } = o;
  const gw = `http://127.0.0.1:${o.gatewayPort}`;
  const label = o.profileLabel ?? "E2E profile";
  const app = new Hono();
  mountBrowserAuthorize(app, { proxyUrl: gw, adminUrl: `http://127.0.0.1:${o.adminPort}`, adminToken: ADMIN, relayUrl: `ws://127.0.0.1:${o.gatewayPort}`, extensionIds: [extId], targets: async () => ({ pools: ["main"], identities: [] }) });
  const consoleSrv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const redirect = `https://${extId}.chromiumapp.org/cb`;
    const page = await fetch(`http://127.0.0.1:${consoleSrv.port}/browser/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=e2e1&label=${encodeURIComponent(label)}`);
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const done = await fetch(`http://127.0.0.1:${consoleSrv.port}/browser/authorize`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, redirect_uri: redirect, state: "e2e1", label, target: "pool:main", action: "approve" }).toString() });
    if (done.status !== 302) throw new Error(`sign-in page answered ${done.status}`);
    const frag = new URLSearchParams(new URL(done.headers.get("location")!).hash.slice(1));
    // Hand the redirect to the extension's own sign-in code, through a real extension page.
    const panel = await extensionPage(cdp, extId, "sidepanel.html");
    await until("side panel loaded", () => panel.eval<boolean>(`document.getElementById("ais-connect") !== null`), 120_000); // the worker can need 20 s to start on a loaded host
    const swTarget = await until("extension service worker", async () => (await targets(cdp)).find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)), 60_000);
    const sw = await cdp.attach(swTarget.targetId);
    await sw.eval(`chrome.storage.local.set({ gatewayUrl: ${JSON.stringify(frag.get("gateway"))}, token: ${JSON.stringify(frag.get("token"))}, binding: ${JSON.stringify(frag.get("binding"))}, target: { kind: "pool", pool: ${JSON.stringify(frag.get("target_name"))} }, profileLabel: ${JSON.stringify(label)} })`);
    await until("connected", async () => (await sw.eval<{ status?: string }>(`chrome.storage.local.get("status")`)).status === "connected", 60_000);
    await until("panel shows Connected", () => panel.eval<boolean>(`document.getElementById("chip").textContent === "Connected"`), 60_000);
    return { sw, panel };
  } finally {
    consoleSrv.stop(true);
  }
}

/** A real (trusted) mouse click at page coordinates, sent through CDP input. */
export async function trustedClick(s: Session, x: number, y: number): Promise<void> {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

type Rpc = { result?: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } };

/** One MCP shim process (stdio JSON-RPC), as an agent CLI would run it. */
export class Agent {
  private nextId = 1;
  private readonly waiting = new Map<number, (r: Rpc) => void>();
  private readonly proc: Bun.Subprocess<"pipe", "pipe", Bun.BunFile>;

  constructor(readonly identity: string, readonly sessionId: string, configDir: string, gatewayUrl: string, logFile: string) {
    // The environment is cleaned: a session id or thread title of the process that runs the test must not name the agent.
    const proc = Bun.spawn(["bun", join(repoRoot, "src/ais.ts"), "browser", "mcp", "--config-dir", configDir, "--identity", identity, "--gateway", gatewayUrl], {
      cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: Bun.file(logFile), env: cleanEnv({ CLAUDE_SESSION_ID: sessionId, AIS_GATEWAY_PROXY_URL: gatewayUrl, AIS_SESSION_NAME: `Agent ${sessionId.slice(-1).toUpperCase()}` }),
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
