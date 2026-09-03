import { platform } from "node:os";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const K3S_NAMESPACE = "chrome-mcp";
const AUTH_PORT_BASE = 9444;
const NOVNC_PORT_BASE = 9744;

export interface AuthBrowserConfig {
  webdriverPort: number;
  novncPort: number;
  deployment: string;
  service: string;
  secret: string;
}

export function authBrowserConfigFor(identityName: string): AuthBrowserConfig {
  const index = stableIndex(identityName);
  return {
    webdriverPort: AUTH_PORT_BASE + index,
    novncPort: NOVNC_PORT_BASE + index,
    deployment: `chrome-auth-${identityName}`,
    service: `chrome-auth-${identityName}`,
    secret: `chrome-auth-${identityName}-vnc`,
  };
}

function stableIndex(identityName: string): number {
  let hash = 0;
  for (const character of identityName) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return 100 + (hash % 800);
}

async function portListening(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

/** A listener on the WebDriver port proves nothing on its own: a port-forward
 * pinned to a replaced browser pod keeps accepting connections and failing
 * every request (observed live: HTTP 404 from a tunnel whose target pod had
 * been recreated). WebDriver readiness is the real test — but the minimal
 * chrome-auth deployment speaks Chrome DevTools (no WebDriver at all), so a
 * live CDP /json/version counts as ready too. */
async function webdriverReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const body = (await res.json()) as { value?: { ready?: boolean } };
      if (body.value?.ready === true) return true;
    }
  } catch {
    // Not WebDriver; the CDP probe below decides.
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { webSocketDebuggerUrl?: string };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

/** Terminates a stale `kubectl port-forward` holding `port` (identified by
 * /proc cmdline, since the container image has no pkill). Never throws. */
async function killStaleForward(port: number): Promise<void> {
  try {
    for (const dir of await readdir("/proc")) {
      if (!/^\d+$/.test(dir)) continue;
      try {
        const bytes = await Bun.file(join("/proc", dir, "cmdline")).bytes();
        const cmdline = new TextDecoder().decode(bytes);
        if (cmdline.includes("port-forward") && cmdline.includes(String(port))) {
          try {
            process.kill(Number(dir), "SIGTERM");
          } catch {
            // Not ours (or already gone) — nothing to do.
          }
        }
      } catch {
        // Process vanished mid-scan.
      }
    }
  } catch {
    // No /proc access to other processes; nothing to clean.
  }
}

/** Starts an owned, loopback-only port-forward to the auth browser. It is
 * deliberately separate from Chrome MCP's CDP forward: WebDriver and noVNC
 * must never share or expose the MCP endpoint.
 *
 * On the host the forward runs under systemd-run so it outlives this
 * process. Inside a container (the console daemon) there is no systemd:
 * there we spawn kubectl directly and let the container's own lifetime
 * manage the forward. */
export async function ensureAuthBrowserPorts(identityName: string): Promise<AuthBrowserConfig | undefined> {
  if (platform() !== "linux" || !Bun.which("kubectl")) return undefined;
  const config = authBrowserConfigFor(identityName);
  if (await webdriverReady(config.webdriverPort)) return config;

  // A live listener that is not WebDriver-ready is a stale forward pinned to
  // a replaced browser pod; clear it so the fresh forward below can bind.
  if (await portListening(config.webdriverPort)) {
    await killStaleForward(config.webdriverPort);
    await Bun.sleep(500);
  }

  if (Bun.which("systemd-run")) {
    const unit = `chrome-auth-pf-${config.webdriverPort}`;
    if (Bun.which("systemctl")) {
      const stop = Bun.spawn(["systemctl", "--user", "stop", `${unit}.service`], { stdout: "ignore", stderr: "ignore" });
      await stop.exited;
    }

    const forward = Bun.spawn(
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
        `service/${config.service}`,
        `${config.webdriverPort}:4444`,
        `${config.novncPort}:7900`,
        "--address",
        "127.0.0.1",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await forward.exited;
  } else {
    // Container mode: a plain detached forward, no unit manager to talk to.
    // AIS_K8S_API_SERVER lets the kubeconfig's 127.0.0.1 server address be
    // overridden with an in-pod reachable one (kubernetes.default.svc);
    // auth still comes from the kubeconfig's client certificate.
    const args = ["kubectl"];
    if (process.env.AIS_K8S_API_SERVER) args.push("--server", process.env.AIS_K8S_API_SERVER);
    args.push(
      "-n",
      K3S_NAMESPACE,
      "port-forward",
      `service/${config.service}`,
      `${config.webdriverPort}:4444`,
      `${config.novncPort}:7900`,
      "--address",
      "127.0.0.1",
    );
    const forward = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", detached: true });
    forward.unref();
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await webdriverReady(config.webdriverPort)) return config;
    await Bun.sleep(500);
  }
  return undefined;
}

export async function readAuthVncPassword(identityName: string): Promise<string | undefined> {
  if (!Bun.which("kubectl")) return undefined;
  const { secret } = authBrowserConfigFor(identityName);
  try {
    const proc = Bun.spawn(
      ["kubectl", "-n", K3S_NAMESPACE, "get", "secret", secret, "-o", "jsonpath={.data.password}"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const encoded = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!encoded) return undefined;
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  } catch {
    return undefined;
  }
}
