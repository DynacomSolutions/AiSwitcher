import { boolFlag, type ParsedArgs } from "../args.ts";
import { runDoctorQuery } from "./collect.ts";
import { formatDoctorReport } from "./report.ts";

/** `ais doctor [--identity=] [--tool=] [--json]` — takes the top-level
 * parser's already-parsed flags directly, same convention as usage/limits
 * (see limits/dispatch.ts's doc comment for why re-parsing a raw `rest`
 * would silently drop flags here). No positional identity, unlike `limits`
 * — matches `usage`/`resume`'s `--identity=` convention instead. */
export async function runDoctorCommand(flags: ParsedArgs["flags"]): Promise<void> {
  const results = await runDoctorQuery(flags);
  if (boolFlag(flags, "json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(formatDoctorReport(results));
}
