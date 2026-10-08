import { createInterface } from "node:readline/promises";
import { purgeRetiredIdentityCredentials, type PurgeOptions, type PurgeReport } from "../../identities/retire-credentials.ts";
import type { ToolConfig } from "../../identities/types.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { dim, green, yellow } from "../colors.ts";
import { CliUsageError } from "../errors.ts";
import * as actions from "./actions.ts";
import { persist, resolveMutationTarget } from "./resolve-tool.ts";

/** Seams for tests; real callers use the defaults. */
export interface RetireDeps {
  /** Registries to resolve the name against; default is every real one. */
  configs?: ToolConfig[];
  now?: () => Date;
  isInteractive?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  purge?: (opts: PurgeOptions) => Promise<PurgeReport>;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runRetire(rest: string[], flags: ParsedArgs["flags"], deps: RetireDeps = {}): Promise<void> {
  const name = rest[0];
  if (!name) throw new CliUsageError("Usage: ais identities retire <name> [--tool=<t>] [--yes]");
  const loaded = await resolveMutationTarget(flags, name, deps.configs);
  const toolName = loaded.cfg.toolName;

  if (!boolFlag(flags, "yes")) {
    const interactive = (deps.isInteractive ?? (() => process.stdin.isTTY === true))();
    if (!interactive) {
      throw new CliUsageError(
        `Refusing to retire "${name}" without --yes. Retiring irreversibly deletes its stored credentials ` +
          `(usage history is kept).`,
      );
    }
    const ok = await (deps.confirm ?? promptYesNo)(
      `Retire "${name}" in ${toolName}'s registry? Its stored credentials will be deleted and cannot be restored.`,
    );
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  const identity = actions.retireIdentity(loaded.file, name, (deps.now ?? (() => new Date()))());
  await persist(loaded);
  const report = await (deps.purge ?? purgeRetiredIdentityCredentials)({ toolName, identity });

  console.log(`${green("✔")} Retired "${name}" in ${toolName}'s registry (usage history kept).`);
  if (report.removed.length === 0) console.log(dim("No stored credentials were found to remove."));
  for (const path of report.removed) console.log(dim(`  removed ${path}`));
  for (const warning of report.warnings) console.log(yellow(`Warning: ${warning}`));
}

export async function runUnretire(rest: string[], flags: ParsedArgs["flags"], deps: RetireDeps = {}): Promise<void> {
  const name = rest[0];
  if (!name) throw new CliUsageError("Usage: ais identities unretire <name> [--tool=<t>]");
  const loaded = await resolveMutationTarget(flags, name, deps.configs);
  actions.unretireIdentity(loaded.file, name, (deps.now ?? (() => new Date()))());
  await persist(loaded);
  console.log(`${green("✔")} Unretired "${name}" in ${loaded.cfg.toolName}'s registry.`);
  console.log(
    dim(
      "Credentials were removed at retirement and are not restored: sign in again " +
        `(ali: ais auth login ${name} --tool=ali; others: launch the tool through ais and log in, or use the web UI Auth page).`,
    ),
  );
}
