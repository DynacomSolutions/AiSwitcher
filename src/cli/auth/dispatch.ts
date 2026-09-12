import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { ALI_CONFIG } from "../../identities/tool-configs.ts";
import { TOOL_CONFIGS } from "../identities/resolve-tool.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import { expandPath } from "../../identities/match.ts";
import {
  refreshIdentityOAuthGrant,
  type IdentityGrantRefresh,
  type RefreshableTool,
} from "../../identities/oauth-refresh.ts";
import {
  AliAuthRefreshError,
  authBrowserPorts,
  installAliAuthRefreshTimer,
  refreshAliAuthSession,
  startAliAuthSession,
} from "../../identities/auth-session.ts";
import { runPiAuthImport } from "./pi-import.ts";
import { runPiAuthSync } from "./pi-sync.ts";

async function resolveAliIdentity(positionals: string[], flags: ParsedArgs["flags"]) {
  if (stringFlag(flags, "tool") !== undefined && stringFlag(flags, "tool") !== "ali") {
    throw new CliUsageError('auth login/enable/ports support only --tool=ali (auth refresh also accepts codex|claude|grok|kimi)');
  }
  const file = await loadIdentitiesFile(ALI_CONFIG.identitiesJsonPath);
  const flaggedKey = stringFlag(flags, "identity");
  if (positionals[0] && flaggedKey && positionals[0] !== flaggedKey) {
    throw new CliUsageError("auth received conflicting positional and --identity values");
  }
  const key = positionals[0] ?? flaggedKey;
  if (positionals.length > 1) throw new CliUsageError("auth accepts at most one identity");
  const identity = key ? findIdentityByNameOrAlias(file.identities, key) : file.identities.length === 1 ? file.identities[0] : undefined;
  if (!identity) {
    throw new CliUsageError(
      key
        ? `No ali identity named "${key}".`
        : "Specify the ali identity (for example: ais auth login personal --tool=ali).",
    );
  }
  return identity;
}

async function printLoginInfo(identityName: string): Promise<void> {
  const info = await startAliAuthSession(await resolveAliIdentity([identityName], { tool: "ali" }));
  if (!info) throw new CliUsageError(`Could not start chrome-auth-${identityName}; deploy the interactive auth browser first.`);
  const host = info.serverHost || "<server-host>";
  console.log(`Alibaba auth browser ready for ${identityName}.`);
  console.log(`On your local machine, open an SSH tunnel:`);
  console.log(`  ssh -N -L ${info.state.novncPort}:127.0.0.1:${info.state.novncPort} ${host}`);
  console.log(`Then open http://127.0.0.1:${info.state.novncPort}/?autoconnect=1&resize=scale`);
  if (info.vncPassword) console.log(`noVNC password: ${info.vncPassword}`);
  console.log("Complete Alibaba sign-in/MFA in that browser. AIS will capture the cookies server-side.");
}

/** The OAuth-backed tools `ais auth refresh <identity> --tool=<t>` can heal
 * without a re-login: the daemon-side refresh machinery
 * (src/identities/oauth-refresh.ts) exchanges the stored refresh token at
 * the provider's token endpoint and writes the rotated grant through to
 * every store of the account. ali is handled separately (console cookies,
 * not OAuth). */
const OAUTH_REFRESH_TOOLS: readonly RefreshableTool[] = ["codex", "claude", "grok", "kimi"];

function renderRefreshOutcome(result: IdentityGrantRefresh): void {
  console.log(`${result.tool}/${result.identity}: ${result.detail}`);
  for (const failure of result.writeFailures) {
    console.error(`  store write failed (${failure.path}): ${failure.error}`);
  }
}

/** `ais auth refresh <identity> --tool=<t>`: ali keeps its cookie-harvest
 * path; codex/claude/grok/kimi run the OAuth grant refresh. Failures are
 * LOUD and non-zero-exit: the systemd renewal timer runs the ali path with
 * --quiet, so stderr + the exit code are the only signals journalctl will
 * ever show (silence here is how a dead harvester went unnoticed for five
 * days, 2026-09-05..10). */
async function runAuthRefresh(rest: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const tool = stringFlag(flags, "tool") ?? "ali";
  if (tool === "ali") {
    const identity = await resolveAliIdentity(rest, flags);
    try {
      const path = await refreshAliAuthSession(identity);
      if (!boolFlag(flags, "quiet")) {
        console.log(`Alibaba console cookies refreshed for ${identity.name} (${path}).`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof AliAuthRefreshError && err.hint ? `\nFix: ${err.hint}` : "";
      console.error(`Alibaba cookie refresh failed for ${identity.name}: ${message}${hint}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!(OAUTH_REFRESH_TOOLS as readonly string[]).includes(tool)) {
    throw new CliUsageError(
      `auth refresh supports --tool=ali|${OAUTH_REFRESH_TOOLS.join("|")} (got "${tool}")`,
    );
  }
  const cfg = TOOL_CONFIGS[tool as keyof typeof TOOL_CONFIGS];
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const key = rest[0] ?? stringFlag(flags, "identity");
  if (rest.length > 1) throw new CliUsageError("auth accepts at most one identity");
  if (!key) {
    throw new CliUsageError(`Specify the identity (for example: ais auth refresh <identity> --tool=${tool}).`);
  }
  const identity = findIdentityByNameOrAlias(file.identities, key);
  if (!identity) throw new CliUsageError(`No ${tool} identity named "${key}".`);
  const resolved: typeof identity = { ...identity, configDir: expandPath(identity.configDir) };
  try {
    const result = await refreshIdentityOAuthGrant(tool as RefreshableTool, resolved, { force: true });
    if (!boolFlag(flags, "quiet")) renderRefreshOutcome(result);
    if (result.outcome === "skipped-revoked") {
      console.error(`${tool}/${result.identity}: ${result.detail}`);
      process.exitCode = 1;
    } else if (result.outcome === "failed" || result.writeFailures.length > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tool} refresh failed for ${identity.name}: ${message}`);
    process.exitCode = 1;
  }
}

export async function runAuthCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [subcommand = "login", ...rest] = positionals;
  if (subcommand === "import") {
    await runPiAuthImport(rest, flags);
    return;
  }
  if (subcommand === "sync") {
    await runPiAuthSync(rest, flags);
    return;
  }
  if (subcommand === "refresh") {
    await runAuthRefresh(rest, flags);
    return;
  }
  const identity = await resolveAliIdentity(rest, flags);

  if (subcommand === "login") {
    await printLoginInfo(identity.name);
    return;
  }
  if (subcommand === "enable") {
    if (!(await installAliAuthRefreshTimer(identity.name))) throw new CliUsageError("Could not enable the AIS Alibaba auth renewal timer.");
    console.log(`Alibaba cookie renewal enabled for ${identity.name} every 10 minutes.`);
    return;
  }
  if (subcommand === "ports") {
    const ports = authBrowserPorts(identity.name);
    console.log(JSON.stringify(ports, null, 2));
    return;
  }
  throw new CliUsageError(`Unknown auth action "${subcommand}". Use login, refresh, enable, or ports.`);
}
