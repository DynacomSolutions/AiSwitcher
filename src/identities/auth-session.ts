import { chmod, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Identity } from "./types.ts";
import { expandPath } from "./match.ts";
import { authBrowserConfigFor, ensureAuthBrowserPorts, readAuthVncPassword } from "./auth-browser.ts";

const AUTH_STATE_DIR = join(homedir(), ".ais", "auth-browser");
const ALI_CONSOLE_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal";

interface AuthSessionState {
  identityName: string;
  webdriverPort: number;
  novncPort: number;
  sessionId: string;
  updatedAt: string;
}

interface WebDriverResponse {
  // Deliberately unknown: WebDriver payloads vary per endpoint (a session id
  // object, a plain string, null, a cookie array); every consumer narrows at
  // its own use site.
  value?: unknown;
}

/** One CDP command against the first debuggable target reachable on the
 * local port-forward. Exported for tests. */
export async function cdpCommand(port: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl?: string }[];
  const wsUrl = list.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("normal auth browser is not ready");
  // The target's debugger URL names the BROWSER's own bind address (e.g.
  // ws://127.0.0.1:9222/...), which is wrong through a port-forward: rewrite
  // it onto the local tunnel port we actually reached the HTTP endpoints on.
  const tunnelled = wsUrl.replace(/^ws:\/\/[^/]+\//, `ws://127.0.0.1:${port}/`);
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(tunnelled);
    const id = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP request timed out")); }, 8_000);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id !== id) return;
      clearTimeout(timer); ws.close();
      if (message.error) reject(new Error(message.error.message ?? "CDP request failed"));
      else resolve(message.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP connection failed")); };
  });
}

function statePath(identityName: string): string {
  return join(AUTH_STATE_DIR, `${identityName}.json`);
}

async function readState(identityName: string): Promise<AuthSessionState | undefined> {
  try {
    return (await Bun.file(statePath(identityName)).json()) as AuthSessionState;
  } catch {
    return undefined;
  }
}

async function writeState(state: AuthSessionState): Promise<void> {
  await mkdir(AUTH_STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${statePath(state.identityName)}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await chmod(temporary, 0o600);
  await rename(temporary, statePath(state.identityName));
}

async function webdriverRequest(
  port: number,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; payload?: WebDriverResponse }> {
  if (path === "/session" && method === "POST") {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as unknown[];
    return { response: new Response(JSON.stringify({ value: { sessionId: list.length ? "normal-chrome" : undefined } }), { status: list.length ? 200 : 503 }), payload: { value: { sessionId: list.length ? "normal-chrome" : undefined } } };
  }
  if (path.endsWith("/url") && method === "GET") {
    const result = await cdpCommand(port, "Runtime.evaluate", { expression: "window.location.href", returnByValue: true }) as { result?: { value?: string } };
    return { response: new Response("{}", { status: 200 }), payload: { value: result.result?.value } };
  }
  if (path.endsWith("/execute/sync") && method === "POST") {
    const input = body as { args?: unknown[] };
    await cdpCommand(port, "Runtime.evaluate", { expression: `window.location.href = ${JSON.stringify(input.args?.[0] ?? "about:blank")}` });
    return { response: new Response("{}", { status: 200 }), payload: { value: null } };
  }
  if (path.endsWith("/cookie") && method === "GET") {
    const result = await cdpCommand(port, "Network.getAllCookies") as { cookies?: unknown[] };
    return { response: new Response("{}", { status: 200 }), payload: { value: result.cookies } };
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Background renewal must never wait indefinitely on a provider page.
    signal: AbortSignal.timeout(8_000),
  });
  let payload: WebDriverResponse | undefined;
  try {
    payload = (await response.json()) as WebDriverResponse;
  } catch {
    // Selenium may return an empty body for a successful command.
  }
  return { response, payload };
}

async function navigateDashboard(state: AuthSessionState): Promise<void> {
  // Execute-script navigation returns immediately even when Alibaba keeps a
  // long-lived login document open; WebDriver's normal `/url` command can
  // otherwise hold an AIS refresh for the full page-load timeout.
  await webdriverRequest(state.webdriverPort, `/session/${encodeURIComponent(state.sessionId)}/execute/sync`, "POST", {
    script: "window.location.href = arguments[0];",
    args: [ALI_CONSOLE_URL],
  });
  await Bun.sleep(1500);
}

async function navigate(state: AuthSessionState, url: string): Promise<void> {
  await webdriverRequest(state.webdriverPort, `/session/${encodeURIComponent(state.sessionId)}/execute/sync`, "POST", {
    script: "window.location.href = arguments[0];",
    args: [url],
  });
  await Bun.sleep(1200);
}

async function ensureSession(identityName: string, openDashboard: boolean): Promise<AuthSessionState | undefined> {
  const ports = await ensureAuthBrowserPorts(identityName);
  if (!ports) return undefined;
  const existing = await readState(identityName);

  if (existing) {
    const probe = await webdriverRequest(ports.webdriverPort, `/session/${encodeURIComponent(existing.sessionId)}/url`);
    if (probe.response.ok && typeof probe.payload?.value === "string") {
      const state = { ...existing, webdriverPort: ports.webdriverPort, novncPort: ports.novncPort, updatedAt: new Date().toISOString() };
      if (openDashboard) await navigateDashboard(state);
      await writeState(state);
      return state;
    }
  }

  const created = await webdriverRequest(ports.webdriverPort, "/session", "POST", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        pageLoadStrategy: "eager",
        "goog:chromeOptions": { args: ["--start-maximized"] },
      },
    },
  });
  const sessionId = (created.payload?.value as { sessionId?: string } | undefined)?.sessionId;
  if (!created.response.ok || typeof sessionId !== "string" || !sessionId) return undefined;

  const state: AuthSessionState = {
    identityName,
    webdriverPort: ports.webdriverPort,
    novncPort: ports.novncPort,
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  if (openDashboard) await navigateDashboard(state);
  await writeState(state);
  return state;
}

export interface AuthLoginInfo {
  state: { webdriverPort: number; novncPort: number; sessionId: string };
  vncPassword?: string;
  serverHost: string;
}

export async function startAliAuthSession(identity: Identity): Promise<AuthLoginInfo | undefined> {
  const state = await ensureSession(identity.name, true);
  if (!state) return undefined;
  return {
    state,
    vncPassword: await readAuthVncPassword(identity.name),
    serverHost: await serverHostname(),
  };
}

async function serverHostname(): Promise<string> {
  try {
    const process = Bun.spawn(["hostname", "-f"], { stdout: "pipe", stderr: "ignore" });
    const value = (await new Response(process.stdout).text()).trim();
    await process.exited;
    return value;
  } catch {
    return "<server-host>";
  }
}

/** A refresh failure worth escalating, with the exact remediation. Thrown
 * (never returned as `undefined`) so every caller (the daemon scheduler, the
 * systemd timer's `ais auth refresh`, POST /api/auth/refresh) records and
 * shows the same precise message instead of a vague "not authenticated". */
export class AliAuthRefreshError extends Error {
  constructor(
    message: string,
    /** One concrete command/URL the user can act on; surfaced alongside the
     * message by the CLI, the scheduler's lastError, and `ais doctor`. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AliAuthRefreshError";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Alibaba marks an authenticated console session with the ticket cookies
 * issued at login. Verified live 2026-09-10: a logged-OUT console still
 * carries `login_aliyunid_csrf` plus ~39 analytics cookies, so csrf is NOT a
 * login marker; only the ticket/id pair proves authentication. Accepts CDP
 * cookie objects ({name}) or harvested "name=value" header entries. Exported
 * for tests. */
export function hasAliLoginCookie(cookies: Iterable<{ name?: string } | string>): boolean {
  for (const cookie of cookies) {
    const name = typeof cookie === "string" ? cookie.slice(0, cookie.indexOf("=")) : cookie.name;
    if (name === "login_aliyunid_ticket" || name === "login_aliyunid") return true;
  }
  return false;
}

export async function refreshAliAuthSession(identity: Identity): Promise<string> {
  let state: AuthSessionState | undefined;
  try {
    // openDashboard=true is the self-heal: a pod restart (observed live
    // 2026-09-03/07) or a closed tab leaves the auth browser on about:blank,
    // and the old starting-URL precondition then failed EVERY future refresh
    // until a human happened to look. Navigating to the console first
    // recovers the harvest with no human action.
    state = await ensureSession(identity.name, true);
  } catch (err) {
    throw new AliAuthRefreshError(
      `could not reach the auth browser for "${identity.name}": ${errorText(err)}`,
      "check the chrome-auth deployment and its kubectl port-forward (ais auth ports --tool=ali --identity=" + identity.name + ")",
    );
  }
  if (!state) {
    throw new AliAuthRefreshError(
      `auth browser for "${identity.name}" is unreachable (chrome-auth deployment or its port-forward is down)`,
      "start it with 'ais auth login " + identity.name + " --tool=ali' (prints the noVNC URL), or inspect 'kubectl -n chrome-mcp get pods'",
    );
  }
  const cookieByName = new Map<string, string>();
  // WebDriver exposes cookies applicable to the current document domain. The
  // console gateway also relies on Alibaba's account-domain ticket, so collect
  // both domains and return to the console afterwards.
  for (const page of [ALI_CONSOLE_URL, "https://account.alibabacloud.com/login/login.htm"]) {
    try {
      await navigate(state, page);
      const cookies = await webdriverRequest(state.webdriverPort, `/session/${encodeURIComponent(state.sessionId)}/cookie`);
      for (const cookie of (cookies.payload?.value as { name?: string; value?: string; domain?: string }[] | undefined) ?? []) {
        if (cookie.name && cookie.value && /(^|\.)alibabacloud\.com$|(^|\.)aliyun\.com$/i.test(cookie.domain ?? "")) {
          cookieByName.set(`${cookie.domain ?? ""}:${cookie.name}`, `${cookie.name}=${cookie.value}`);
        }
      }
    } catch (err) {
      throw new AliAuthRefreshError(
        `cookie harvest from the auth browser failed: ${errorText(err)}`,
        "retry once; if it persists, restart the chrome-auth browser and re-login over noVNC",
      );
    }
  }
  // Verify AUTHENTICATION before writing anything. Without this check the
  // harvest happily collected 39 logged-out analytics cookies and stamped
  // them over a still-valid cookie file, reporting success (observed live
  // 2026-09-10). The ticket cookie is the only reliable login marker.
  if (!hasAliLoginCookie(cookieByName.values())) {
    throw new AliAuthRefreshError(
      `the auth browser for "${identity.name}" is not signed in to the Alibaba console (no login-ticket cookie after opening the console page)`,
      `re-login once: run 'ais auth login ${identity.name} --tool=ali' and complete Alibaba sign-in/MFA over the printed noVNC URL; the scheduled refresh keeps that session alive afterwards`,
    );
  }
  try {
    await navigateDashboard(state);
  } catch (err) {
    throw new AliAuthRefreshError(`post-harvest navigation back to the console failed: ${errorText(err)}`);
  }
  const entries = [...cookieByName.values()];
  if (entries.length === 0) {
    throw new AliAuthRefreshError("the auth browser carried no alibabacloud.com/aliyun.com cookies to harvest");
  }

  const target = join(expandPath(identity.configDir), "console-cookie.txt");
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${entries.join("; ")}\n`);
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return target;
}

export async function installAliAuthRefreshTimer(identityName: string): Promise<boolean> {
  if (!Bun.which("systemctl")) return false;
  const aisBinary = Bun.which("ais");
  if (!aisBinary) return false;
  const safeName = identityName.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const unitBase = `ais-ali-auth-refresh-${safeName}`;
  const unitDir = join(homedir(), ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true, mode: 0o700 });
  await Bun.write(
    join(unitDir, `${unitBase}.service`),
    `[Unit]\nDescription=AIS Alibaba auth-session renewal (${identityName})\n\n[Service]\nType=oneshot\nExecStart=${aisBinary} auth refresh --tool=ali --identity=${identityName} --quiet\n`,
  );
  await Bun.write(
    join(unitDir, `${unitBase}.timer`),
    `[Unit]\nDescription=Renew AIS Alibaba auth session (${identityName})\n\n[Timer]\nOnBootSec=2m\nOnUnitActiveSec=10m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );
  const reload = Bun.spawn(["systemctl", "--user", "daemon-reload"], { stdout: "ignore", stderr: "ignore" });
  await reload.exited;
  const enable = Bun.spawn(["systemctl", "--user", "enable", "--now", `${unitBase}.timer`], { stdout: "ignore", stderr: "ignore" });
  await enable.exited;
  return enable.exitCode === 0;
}

export function authDashboardUrl(): string {
  return ALI_CONSOLE_URL;
}

export function authBrowserPorts(identityName: string): { webdriverPort: number; novncPort: number } {
  const config = authBrowserConfigFor(identityName);
  return { webdriverPort: config.webdriverPort, novncPort: config.novncPort };
}
