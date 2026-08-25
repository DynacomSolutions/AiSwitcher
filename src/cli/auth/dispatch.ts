import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { ALI_CONFIG } from "../../identities/tool-configs.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import {
  authBrowserPorts,
  installAliAuthRefreshTimer,
  refreshAliAuthSession,
  startAliAuthSession,
} from "../../identities/auth-session.ts";
import { runPiAuthImport } from "./pi-import.ts";

async function resolveAliIdentity(positionals: string[], flags: ParsedArgs["flags"]) {
  if (stringFlag(flags, "tool") !== undefined && stringFlag(flags, "tool") !== "ali") {
    throw new CliUsageError('auth currently supports only --tool=ali');
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

export async function runAuthCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const [subcommand = "login", ...rest] = positionals;
  if (subcommand === "import") {
    await runPiAuthImport(rest, flags);
    return;
  }
  const identity = await resolveAliIdentity(rest, flags);

  if (subcommand === "login") {
    await printLoginInfo(identity.name);
    return;
  }
  if (subcommand === "refresh") {
    const path = await refreshAliAuthSession(identity);
    if (!boolFlag(flags, "quiet")) {
      console.log(path ? `Alibaba console cookies refreshed for ${identity.name}.` : `Alibaba session is not authenticated for ${identity.name}.`);
    }
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
