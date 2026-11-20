import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aisHome } from "../shared/ais-home.ts";
import { spawnCaptured, type CapturedRunResult } from "../shared/exec.ts";

/**
 * The agent-guard installer lives in the private `.ais` repo, so another user may not have it. Every function here
 * skips with one log line when it is missing and never throws: a guard problem must not fail the main command.
 */
export interface AgentGuardDeps {
  home?: string;
  /** Test seam for the process runner. */
  run?: (command: string, args: string[]) => Promise<CapturedRunResult>;
  /** Test seam for the installer existence check. */
  exists?: (path: string) => boolean;
  log?: (line: string) => void;
}

export function agentGuardInstaller(home: string = homedir()): string {
  return join(aisHome(home), "agent-guard", "install.sh");
}

/** The `install.sh --only` tool for an instance driver (the names match). */
export function agentGuardTool(driver: string): string | undefined {
  return ["claude", "codex", "grok", "kimi", "opencode", "pi"].includes(driver) ? driver : undefined;
}

function short(r: CapturedRunResult): string {
  const text = `${r.stderr}\n${r.stdout}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  return text.slice(0, 160);
}

async function runInstaller(args: string[], deps: AgentGuardDeps): Promise<CapturedRunResult | undefined> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const installer = agentGuardInstaller(deps.home);
  if (!(deps.exists ?? existsSync)(installer)) {
    log("agent-guard: installer not found, skipped");
    return undefined;
  }
  try {
    return await (deps.run ?? ((c, a) => spawnCaptured(c, a, {})))(installer, args);
  } catch (error) {
    log(`agent-guard: warning: installer did not run: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** After a T3 gateway home is created or refreshed: install the guard for that tool only. */
export async function installAgentGuardForHome(driver: string, deps: AgentGuardDeps = {}): Promise<void> {
  const tool = agentGuardTool(driver);
  if (!tool) return;
  const log = deps.log ?? ((l: string) => console.log(l));
  const r = await runInstaller(["--only", tool], deps);
  if (!r) return;
  if (r.exitCode !== 0) log(`agent-guard: warning: install for ${tool} failed (exit ${r.exitCode}): ${short(r)}`);
  else log(`agent-guard: ${tool} homes installed`);
}

/** In `ais update`: check every home, install only when something is out of date. Returns a one-line summary or undefined. */
export async function checkAndInstallAgentGuard(deps: AgentGuardDeps = {}): Promise<string | undefined> {
  const check = await runInstaller(["--check"], deps);
  if (!check) return undefined;
  if (check.exitCode === 0) return "agent-guard: all homes up to date";
  const install = await runInstaller([], deps);
  if (!install) return undefined;
  if (install.exitCode !== 0) return `agent-guard: warning: install failed (exit ${install.exitCode}): ${short(install)}`;
  return "agent-guard: installed into out-of-date homes";
}
