import { boolFlag, parseArgs } from "./args.ts";
import { bold } from "./colors.ts";
import { runDoctorCommand } from "./doctor/dispatch.ts";
import { CliUsageError } from "./errors.ts";
import { runHelp } from "./help.ts";
import { runIdentitiesCommand } from "./identities/dispatch.ts";
import { runLimitsCommand } from "./limits/dispatch.ts";
import { runResumeCommand } from "./resume/dispatch.ts";
import { runUpdate } from "./update.ts";
import { runUpgrade } from "./upgrade.ts";
import { runUsageCommand } from "./usage/dispatch.ts";
import { runVersion } from "./version.ts";
import { runSyncCommand } from "./sync/dispatch.ts";
import { startBackgroundProfileSync } from "../sync/background.ts";
import { migrateLegacyAisHome } from "../shared/migrate-ais-home.ts";
import { runAuthCommand } from "./auth/dispatch.ts";

export async function runCli(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const [command, ...rest] = positionals;

  try {
    // Self-healing, idempotent, and must run before anything below reads a
    // path that now defaults under ~/.ais (sync config/cache, the managed
    // npm prefix) — see migrate-ais-home.ts. Never throws.
    await migrateLegacyAisHome();

    if (command === "version" || command === "-v" || boolFlag(flags, "version")) {
      return runVersion();
    }
    if (command === undefined || command === "help" || command === "-h" || boolFlag(flags, "help")) {
      return runHelp();
    }

    // Resume launches must never wait for SSH, and neither may any other
    // `ais` command. A prior version `await`ed `automaticSync()` in this very
    // process — the same blocking SSH/rsync/lock-wait work `run-wrapper.ts`
    // deliberately detaches for claude/codex/grok/kimi/zai launches — which
    // made `ais limits`/`ais usage` (and `identities`/`doctor`) hang for as
    // long as reconciliation with a slow or unreachable remote took, up to
    // forever. Fixed to spawn the exact same detached `ais sync background`
    // worker `startBackgroundProfileSync` already uses elsewhere, and to say
    // so out loud (stderr, so `--json` output stays clean) rather than
    // leaving reconciliation silently running after this process exits.
    const syncAware = new Set(["identities", "usage", "limits", "doctor"]);
    if (syncAware.has(command)) {
      const started = startBackgroundProfileSync({ direction: "both", scope: { kind: "all" } });
      if (started) {
        console.error('ais sync: reconciling with configured SSH remotes in the background (run "ais sync now" to wait for it directly).');
      }
    }

    switch (command) {
      case "update":
        return await runUpdate();
      case "upgrade":
        return await runUpgrade();
      case "identities":
        await runIdentitiesCommand(rest, flags);
        break;
      case "usage":
        // Raw, unparsed remainder of argv (not `flags`/`rest`) — usage's own
        // dispatcher needs to see a literal "--" to split its own flags from
        // a tokscale passthrough command; the shared parseArgs() above would
        // have already mangled that split. See usage/dispatch.ts.
        return await runUsageCommand(argv.slice(1));
      case "limits":
        await runLimitsCommand(rest, flags);
        break;
      case "doctor":
        await runDoctorCommand(flags);
        break;
      case "resume":
        await runResumeCommand(rest, flags);
        break;
      case "sync":
        return await runSyncCommand(rest, flags);
      case "auth":
        await runAuthCommand(rest, flags);
        break;
      default:
        throw new CliUsageError(`Unknown command "${command}". Run "ais help" for usage.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${bold("Error:")} ${message}`);
    process.exit(1);
  }
}
