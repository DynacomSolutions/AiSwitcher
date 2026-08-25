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
  value?: { sessionId?: string; [key: string]: unknown };
}

async function cdpCommand(port: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl?: string }[];
  const wsUrl = list.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("normal auth browser is not ready");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
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

async function currentUrl(state: AuthSessionState): Promise<string | undefined> {
  const result = await webdriverRequest(state.webdriverPort, `/session/${encodeURIComponent(state.sessionId)}/url`);
  return typeof result.payload?.value === "string" ? result.payload.value : undefined;
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
  const sessionId = created.payload?.value?.sessionId;
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

export async function refreshAliAuthSession(identity: Identity): Promise<string | undefined> {
  let state: AuthSessionState | undefined;
  try {
    state = await ensureSession(identity.name, false);
  } catch {
    return undefined;
  }
  if (!state) return undefined;
  let url: string | undefined;
  try {
    url = await currentUrl(state);
  } catch {
    return undefined;
  }
  // Alibaba may redirect a completed login through the public account site
  // before the console tab is restored. Any Alibaba-owned page is a valid
  // authenticated starting point; navigation below returns to Model Studio.
  if (!url || !/(^|\.)alibabacloud\.com(\/|$)|(^|\.)aliyun\.com(\/|$)/i.test(url)) return undefined;
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
    } catch {
      return undefined;
    }
  }
  try {
    await navigateDashboard(state);
  } catch {
    return undefined;
  }
  const entries = [...cookieByName.values()];
  if (entries.length === 0) return undefined;

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
