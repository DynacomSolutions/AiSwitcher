import { adapterFor, runAcpRelay } from "../../acp/relay-process.ts";
import { checkAcpRelay, installAcpRelay, removeAcpRelay, resolveAgentInstall, type AcpRelayOptions, type AcpRelayResult } from "../../identities/t3-acp-relay.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

const USAGE = "Usage: ais gateway t3-acp [--check] [--remove]";

function report(r: AcpRelayResult, out: (line: string) => void): void {
  for (const i of r.instances) {
    const what = { set: "relay set", current: "relay already set", kept: "left as it is", no_install: "not set", removed: "relay removed" }[i.status];
    out(`t3-acp: ${i.instance} (${i.agentId}): ${what}${i.detail ? `: ${i.detail}` : ""}`);
  }
  if (r.backup) out(`t3-acp: settings backup ${r.backup}`);
}

/**
 * `ais gateway t3-acp [--check] [--remove]`: starts T3 Code's ACP registry agents (kimi-code, grok-build, glm-acp-agent)
 * behind the AIS relay, so a failed turn shows its reason in the thread (src/identities/t3-acp-relay.ts). `--check`
 * writes nothing and fails when something is not in place; `--remove` undoes it. T3 Code is never restarted here: it
 * reads its settings file again by itself, and sessions started after that use the relay.
 */
export async function runT3AcpCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: AcpRelayOptions = {}): Promise<void> {
  if (args.length > 0) throw new CliUsageError(USAGE);
  if (boolFlag(flags, "check")) {
    const problems = await checkAcpRelay(opts);
    if (problems.length === 0) {
      deps.out("t3-acp: in place");
      return;
    }
    for (const p of problems) deps.out(`t3-acp: ${p}`);
    throw new Error(`${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  }
  if (boolFlag(flags, "remove")) {
    const r = await removeAcpRelay(opts);
    report(r, deps.out);
    deps.out(r.changed ? "t3-acp: removed; sessions started from now on run the agents directly" : "t3-acp: nothing to remove");
    return;
  }
  const r = await installAcpRelay(opts);
  if (r.instances.length === 0) {
    deps.out("t3-acp: no T3 Code provider instance of kimi-code, grok-build or glm-acp-agent");
    return;
  }
  report(r, deps.out);
  deps.out(r.changed ? "t3-acp: done; sessions started from now on use the relay (a running agent keeps going as it is)" : "t3-acp: already in place");
}

/**
 * `ais __acp_relay <agentId> [agent arguments]`: what a launcher starts. Takes the agent's place on stdin and stdout
 * and runs the agent T3 Code installed behind the relay. Prints nothing to stdout itself.
 */
export async function runAcpRelayProcess(argv: string[]): Promise<number> {
  const [agentId, ...agentArgs] = argv;
  if (!agentId) {
    process.stderr.write("ais __acp_relay: an agent id is required\n");
    return 2;
  }
  const install = await resolveAgentInstall(agentId);
  if (!install) {
    process.stderr.write(`ais __acp_relay: T3 Code has no install of ${agentId}\n`);
    return 127;
  }
  // As T3 Code does for its own installs: the agent's bin directory comes first on PATH.
  const env = { ...process.env };
  if (install.binDirectory) env.PATH = `${install.binDirectory}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
  const adapter = adapterFor(agentId, env);
  return runAcpRelay({ command: install.executable, args: agentArgs, env, ...(adapter ? { adapter } : {}) });
}
