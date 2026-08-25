import { homedir, platform } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aisConfigDir } from "../shared/ais-home.ts";
import { isValidIdentityKey } from "./match.ts";

/**
 * Where Chrome actually lives on Linux. It is not a host application there: it
 * runs in k3s, one Deployment per identity, named `chrome-mcp-<identity>` (ie
 * exactly the devserver session name), with CDP bound to pod loopback. The host
 * port is reached through a `kubectl port-forward`. See ensureChromeMcpRunning.
 */
const K3S_NAMESPACE = "chrome-mcp";
const K3S_POD_CDP_PORT = 9222;

/**
 * Per-identity Chrome endpoints are machine-local configuration, never source
 * code. This keeps account names and local port assignments out of a public
 * repository while preserving the explicit allow-list: a shared browser that
 * is not an identity cannot accidentally become reachable as one.
 */
export interface ChromeMcpConfig {
  port: number;
  profileDir: string;
}

interface ChromeMcpConfigFile {
  version: 1;
  identities: Record<string, ChromeMcpConfig>;
}

export function chromeMcpConfigPath(): string {
  return process.env.AIS_CHROME_MCP_CONFIG ?? join(aisConfigDir(), "chrome-mcp.json");
}

export function loadChromeMcpIdentities(path: string = chromeMcpConfigPath()): Record<string, ChromeMcpConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Invalid Chrome MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const file = parsed as Partial<ChromeMcpConfigFile>;
  if (file.version !== 1 || !file.identities || typeof file.identities !== "object" || Array.isArray(file.identities)) {
    throw new Error(`Invalid Chrome MCP config at ${path}: expected version 1 with an identities object`);
  }

  const result: Record<string, ChromeMcpConfig> = {};
  const ports = new Set<number>();
  for (const [identityName, value] of Object.entries(file.identities)) {
    if (!isValidIdentityKey(identityName)) throw new Error(`Invalid Chrome MCP identity name "${identityName}" at ${path}`);
    if (!value || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
      throw new Error(`Invalid Chrome MCP port for "${identityName}" at ${path}`);
    }
    if (typeof value.profileDir !== "string" || value.profileDir.trim().length === 0) {
      throw new Error(`Invalid Chrome MCP profileDir for "${identityName}" at ${path}`);
    }
    if (ports.has(value.port)) throw new Error(`Duplicate Chrome MCP port ${value.port} at ${path}`);
    ports.add(value.port);
    result[identityName] = { port: value.port, profileDir: value.profileDir };
  }
  return result;
}

export function chromeMcpConfigFor(
  identityName: string,
  identities: Record<string, ChromeMcpConfig> = loadChromeMcpIdentities(),
): ChromeMcpConfig | undefined {
  return identities[identityName];
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function devserverSessionExists(session: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["devserver", "ls"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.split("\n").some((line) => line.startsWith(`${session}:`));
  } catch {
    return false;
  }
}

/**
 * Binds `port` on host loopback to the identity's in-cluster Chrome.
 *
 * Two details matter and both were learned the hard way:
 *
 * 1. **Target the Deployment, never a pod.** Pod names carry a ReplicaSet hash
 *    that changes on any eviction or reboot, so a pinned pod name works until
 *    it silently does not.
 * 2. **Give the forward an owner.** A bare background child reparents to PID 1
 *    and leaks one process per identity forever, with nothing to reap it.
 *    `systemd-run --user --collect` makes it a real unit, so it is both
 *    addressable by name (idempotency) and cleaned up when it exits.
 *
 * Returns false rather than throwing when the machine cannot do this, so the
 * caller degrades to the same "could not self-heal" path as a failed launch.
 */
async function ensureLinuxPortForward(session: string, port: number): Promise<boolean> {
  if (!Bun.which("kubectl") || !Bun.which("systemd-run")) return false;

  const unit = `chrome-mcp-pf-${port}`;

  // We only get here when the port is not answering, so any existing unit is
  // stale (most likely its pod was replaced). Replace it rather than stacking a
  // second forward on the same port, which would just fail to bind.
  if (Bun.which("systemctl")) {
    try {
      const stop = Bun.spawn(["systemctl", "--user", "stop", `${unit}.service`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await stop.exited;
    } catch {
      // No such unit, which is the normal first-run case.
    }
  }

  try {
    const proc = Bun.spawn(
      [
        "systemd-run",
        "--user",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        "kubectl",
        "-n",
        K3S_NAMESPACE,
        "port-forward",
        `deployment/${session}`,
        `${port}:${K3S_POD_CDP_PORT}`,
        "--address",
        "127.0.0.1",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Self-heals an identity's dedicated Chrome (Claude MCP) instance — mirrors
 * chrome-mcp-ensure-running.sh's logic (same guards, same poll) so an
 * auto-opened link never depends on some other tool call having triggered the
 * self-heal first.
 *
 * The two platforms host Chrome completely differently, so "self-heal" means
 * two different things:
 *
 * - **macOS**: Chrome is a host application. Launch it through devserver, and
 *   only when the session is genuinely missing, so we never spawn a second
 *   duplicate window (Chrome's single-instance lock is scoped to the app, not
 *   to --user-data-dir, so a second launch silently hands off to the first).
 * - **Linux**: Chrome already runs in k3s and is not ours to launch. The thing
 *   that is missing is the host-side port-forward, so establish that instead.
 *   Restarting the Deployment would disturb other people using the same shared
 *   browser, so this path never does.
 *
 * Before this had a Linux branch, the whole function was dead code there:
 * devserver does not exist, so it fell straight through to a 15-second poll and
 * gave up, on every call.
 */
export async function ensureChromeMcpRunning(identityName: string): Promise<number | undefined> {
  const config = chromeMcpConfigFor(identityName);
  if (!config) return undefined;

  if (await isPortListening(config.port)) return config.port;

  const session = `chrome-mcp-${identityName}`;

  if (platform() === "linux") {
    await ensureLinuxPortForward(session, config.port);
  } else if (!(await devserverSessionExists(session))) {
    const userDataDir = join(homedir(), ".claude", "identities", identityName, "chrome-profile");
    try {
      const proc = Bun.spawn(
        [
          "devserver",
          "up",
          session,
          "~",
          "--",
          `'/Applications/Chrome (Claude MCP).app/Contents/MacOS/Google Chrome'`,
          `--remote-debugging-port=${config.port}`,
          `--user-data-dir=${userDataDir}`,
          `--profile-directory='${config.profileDir}'`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-fre",
          "--disable-background-networking",
          "--disable-client-side-phishing-detection",
          "--disable-popup-blocking",
          "--disable-hang-monitor",
          "--disable-prompt-on-repost",
          "--disable-sync",
          "--hide-crash-restore-bubble",
          "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await proc.exited;
    } catch {
      return undefined;
    }
  }

  for (let i = 0; i < 30; i++) {
    if (await isPortListening(config.port)) return config.port;
    await Bun.sleep(500);
  }
  return undefined;
}

async function browserWebSocketUrl(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    return info.webSocketDebuggerUrl;
  } catch {
    return undefined;
  }
}

/**
 * Opens `url` as a new tab in the already-running Chrome (Claude MCP)
 * instance on `port`, via the full CDP WebSocket protocol's
 * `Target.createTarget` — never the simpler HTTP `/json/new` endpoint, and
 * never launches a new Chrome process.
 *
 * Two separate things had to be right here, and an earlier version of this
 * function got the first one wrong in a way that visibly disrupted the user
 * (2026-07-14):
 *
 * 1. **Must not steal focus.** This browser is shared and visible — see the
 *    chrome-mcp-profile skill's "Don't steal focus" section, the same reason
 *    `mcp__chrome-devtools__new_page` takes a `background: true` param. The
 *    HTTP `/json/new` endpoint has no equivalent parameter at all — it
 *    always activates the new tab and brings the whole window to the front,
 *    with no way to opt out. `Target.createTarget` (only reachable over the
 *    WebSocket protocol, not the HTTP one) takes `background: true` +
 *    `newWindow: false`, the exact mechanism puppeteer/chrome-devtools-mcp
 *    itself relies on for the identical, already-proven-working guarantee
 *    elsewhere in this project. Verified against a fully disposable,
 *    throwaway headless Chrome instance (not any real identity's browser)
 *    that the call succeeds with these params before this ever touched a
 *    real window again.
 * 2. **Must not launch a second Chrome process.** Launching a second
 *    "Chrome (Claude MCP).app" process pointed at a DIFFERENT
 *    --user-data-dir while one is already running silently hands off to
 *    whichever instance launched first (Chrome's single-instance lock is
 *    scoped to the app, not to --user-data-dir+--profile-directory together)
 *    — see the chrome-mcp-profile skill's "Why not one shared multi-profile
 *    window" section. Talking to the already-known, already-correct port
 *    over CDP sidesteps that failure mode entirely: there's no app-launch
 *    race to lose.
 */
export async function openUrlInChromeMcp(port: number, url: string): Promise<boolean> {
  const wsUrl = await browserWebSocketUrl(port);
  if (!wsUrl) return false;

  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Already closed/erroring — nothing to do.
      }
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), 5000);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url, background: true, newWindow: false },
        }),
      );
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.id === 1) finish(Boolean(data.result?.targetId));
      } catch {
        finish(false);
      }
    };
    ws.onerror = () => finish(false);
  });
}
