import { describeCodexTelemetryResult, syncCodexTelemetry } from "../../identities/codex-telemetry.ts";
import { checkT3Telemetry, installT3Telemetry, type T3Options } from "../../identities/t3-anthropic-proxy.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway t3-telemetry [--check]`: turns telemetry off for T3 and its agents. Sets the opt-out env keys in ~/.t3/service.env
 * (T3 passes them to every child) and the opt-out keys in the config.toml of every Codex home. `--check` writes nothing and
 * fails on drift. T3 Claude homes get their keys from `ais gateway t3-claude-sync`. Never restarts T3.
 */
export async function runT3TelemetryCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: T3Options = {}): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-telemetry [--check]");
  const check = boolFlag(flags, "check");
  let bad = 0;
  if (check) {
    for (const p of await checkT3Telemetry(opts)) {
      bad += 1;
      deps.out(`t3-telemetry: ${p}`);
    }
  } else {
    const r = await installT3Telemetry(opts);
    deps.out(`t3-telemetry: ${r.serviceEnv} ${r.changed ? "updated" : "already current"}${r.backup ? ` (backup ${r.backup})` : ""}`);
  }
  for (const r of await syncCodexTelemetry({ ...(opts.home ? { home: opts.home } : {}), ...(opts.env ? { env: opts.env } : {}), check })) {
    deps.out(`t3-telemetry: codex ${describeCodexTelemetryResult(r)}`);
    if (r.status === "drift" || r.status === "failed") bad += 1;
  }
  if (bad > 0) throw new Error(check ? "t3-telemetry: telemetry is not off everywhere" : "t3-telemetry: a Codex home failed");
  if (!check) deps.out("Restart T3 Code to apply the service.env change (not restarted by this command).");
}
