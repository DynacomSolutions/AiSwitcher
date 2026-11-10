import { boolFlag, type ParsedArgs } from "../args.ts";
import { runDoctorQuery } from "./collect.ts";
import { formatDoctorReport } from "./report.ts";
import { fetchLocalStatus } from "../gateway/local-service.ts";
import { t3ProxyDoctorProblems } from "../../identities/t3-anthropic-proxy.ts";
import { collectSpendGuardDoctor } from "../../spend/doctor.ts";

/** `ais doctor [--identity=] [--tool=] [--json]` — takes the top-level
 * parser's already-parsed flags directly, same convention as usage/limits
 * (see limits/dispatch.ts's doc comment for why re-parsing a raw `rest`
 * would silently drop flags here). No positional identity, unlike `limits`
 * — matches `usage`/`resume`'s `--identity=` convention instead. After the
 * per-identity probes, an AWS spend-guard section renders one line per
 * AWS account (in budget / BREACHED / DEGRADED) via a real read-only
 * cycle; machines with no identity->AWS mapping get no section at all. */
export async function runDoctorCommand(flags: ParsedArgs["flags"]): Promise<void> {
  const [results, spendRows] = await Promise.all([runDoctorQuery(flags), collectSpendGuardDoctor().catch(() => [])]);
  const all = [...results, ...spendRows];
  const local = await fetchLocalStatus();
  const t3Problems = await t3ProxyDoctorProblems().catch(() => []);
  if (boolFlag(flags, "json")) {
    // The proxy state rides along as a last row, so existing consumers of the array keep working.
    const proxy = local ? { t3Problems, gatewayLocal: { running: true, mode: local.mode, sinceMs: local.sinceMs, ...(local.probeAtMs !== undefined ? { probeAtMs: local.probeAtMs } : {}) } } : { t3Problems, gatewayLocal: { running: false } };
    console.log(JSON.stringify([...all, proxy], null, 2));
    return;
  }
  console.log(formatDoctorReport(all));
  for (const p of t3Problems) console.log(`\nT3 Code: ${p}`);
  console.log(
    local
      ? `\nGateway local proxy: running, ${local.mode === "direct" ? "DIRECT mode (cluster gateway unreachable)" : "remote mode"} since ${new Date(local.sinceMs).toISOString()}`
      : "\nGateway local proxy: not running (ais gateway local install)",
  );
}
