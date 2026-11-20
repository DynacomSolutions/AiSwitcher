import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_DEFAULT_PORT, MCP_HEALTH_PATH, MCP_UNIT_NAME, ensureMcpKey, mcpKeyDir, mcpPort, mcpUnitDir, portAnswers } from "../../browser/mcp-http-config.ts";
import { systemctlUser, type Ctl } from "../gateway/local-service.ts";

/**
 * The user unit of the shared browser MCP service. Same pattern as the local gateway unit: ready only when the port listens,
 * and the daemon drains on SIGTERM with no timer of its own (TimeoutStopSec is only the kill ceiling).
 */
export const BROWSER_MCP_UNIT = `[Unit]
Description=AiProfileSwitcher shared browser MCP server (127.0.0.1)

[Service]
Type=simple
ExecStart=%h/.local/bin/ais browser mcp-serve
# Ready only once the port listens. $$ is systemd's escape for a literal $.
ExecStartPost=/usr/bin/env bash -c 'p=\$\${AIS_BROWSER_MCP_PORT:-${MCP_DEFAULT_PORT}}; for i in $$(seq 1 150); do (exec 3<>/dev/tcp/127.0.0.1/$$p) 2>/dev/null && exit 0; sleep 0.1; done; exit 1'
TimeoutStartSec=30s
# The daemon stops accepting on SIGTERM and exits when its in-flight calls are done (a call lasts 125 s at most); this is only the kill ceiling.
TimeoutStopSec=3min
Restart=always
RestartSec=1s
MemoryHigh=512M
MemoryMax=1G

[Install]
WantedBy=default.target
`;

export interface McpServiceOptions {
  unitDirectory?: string;
  platform?: NodeJS.Platform;
  ctl?: Ctl;
  keyDir?: string;
  /** Resolves when the daemon answers on its port; rejects on timeout. */
  waitListening?: (port: number) => Promise<void>;
  /** The binary changed: restart the running daemon so it runs the new code. */
  restartIfActive?: boolean;
  /** Release and host-update mode: never start or re-enable a unit the user stopped. */
  respectDisabled?: boolean;
  log?: (line: string) => void;
}

async function defaultWait(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portAnswers(port, 300)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the browser MCP service did not start listening on port ${port}`);
}

async function writeUnit(dir: string, text: string): Promise<boolean> {
  const path = join(dir, MCP_UNIT_NAME);
  const current = await readFile(path, "utf8").catch(() => undefined);
  const mode = await stat(path).then((s) => s.mode & 0o777, () => undefined);
  if (current === text && mode === 0o644) return false;
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
  return true;
}

/**
 * Installs and starts the shared browser MCP service (Linux with a systemd user manager only).
 * Without systemd nothing is written, so the launch wiring stays on the stdio form.
 */
export async function installBrowserMcpService(o: McpServiceOptions = {}): Promise<{ path: string; changed: boolean; action: string }> {
  if ((o.platform ?? process.platform) !== "linux") throw new Error("the shared browser MCP service is available on Linux only");
  const ctl = o.ctl ?? systemctlUser;
  const dir = o.unitDirectory ?? mcpUnitDir();
  const port = mcpPort();
  const wait = o.waitListening ?? defaultWait;
  const log = o.log ?? ((line: string) => console.error(line));
  // A host without a user manager must not get a unit file: the launch wiring reads the file to pick the HTTP form.
  if ((await ctl(["show-environment"])).code !== 0) throw new Error("no systemd user manager is available");
  ensureMcpKey(o.keyDir ?? mcpKeyDir());
  await mkdir(dir, { recursive: true });
  const path = join(dir, MCP_UNIT_NAME);
  const existedBefore = await stat(path).then(() => true, () => false);
  const changed = await writeUnit(dir, BROWSER_MCP_UNIT);
  const must = async (args: string[]): Promise<void> => {
    if ((await ctl(args)).code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed`);
  };
  await must(["daemon-reload"]);
  const active = (await ctl(["is-active", MCP_UNIT_NAME])).out === "active";
  if (!active) {
    if (o.respectDisabled && existedBefore) return { path, changed, action: "left-alone" };
    await must(["enable", MCP_UNIT_NAME]);
    await must(["start", MCP_UNIT_NAME]);
    await wait(port);
    return { path, changed, action: "started" };
  }
  if (changed || o.restartIfActive) {
    // The running daemon finishes its in-flight calls, then the new one starts. A call that arrives in between fails once, and the agent retries.
    await must(["restart", MCP_UNIT_NAME]);
    await wait(port);
    log("browser mcp: service restarted on the new binary");
    return { path, changed, action: "restarted" };
  }
  return { path, changed, action: "unchanged" };
}

export async function uninstallBrowserMcpService(o: McpServiceOptions = {}): Promise<{ removed: boolean }> {
  const ctl = o.ctl ?? systemctlUser;
  const path = join(o.unitDirectory ?? mcpUnitDir(), MCP_UNIT_NAME);
  const existed = await stat(path).then(() => true, () => false);
  await ctl(["disable", "--now", MCP_UNIT_NAME]).catch(() => undefined);
  await rm(path, { force: true });
  await ctl(["daemon-reload"]).catch(() => undefined);
  return { removed: existed };
}

export interface McpServiceStatus {
  installed: boolean;
  /** systemd's answer: active, inactive, failed, or "unknown" without systemd. */
  unit: string;
  answering: boolean;
  port: number;
}

/** True when `GET /healthz` of the daemon answers 200. */
export async function mcpDaemonHealthy(port: number, doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}${MCP_HEALTH_PATH}`, { signal: AbortSignal.timeout(1_500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function browserMcpServiceStatus(o: McpServiceOptions & { fetch?: typeof fetch } = {}): Promise<McpServiceStatus> {
  const ctl = o.ctl ?? systemctlUser;
  const port = mcpPort();
  const installed = await stat(join(o.unitDirectory ?? mcpUnitDir(), MCP_UNIT_NAME)).then(() => true, () => false);
  const unit = installed ? await ctl(["is-active", MCP_UNIT_NAME]).then((r) => r.out || "unknown", () => "unknown") : "not installed";
  return { installed, unit, answering: await mcpDaemonHealthy(port, o.fetch), port };
}
