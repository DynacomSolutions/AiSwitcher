import { installAgentGuardForHome, type AgentGuardDeps } from "../../identities/agent-guard-install.ts";
import { applyT3Instance, type InstanceDriver, type T3InstanceOptions } from "../../identities/t3-instance.ts";
import { isUsageTrouble, describeUsageResult } from "../../identities/t3-usage-credentials.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { connect, type GatewayCliDeps } from "./apps.ts";
import { readSecretsKey } from "./secrets-file.ts";

const USAGE = "Usage: ais gateway t3-instance <instance-id> --driver=claude|grok|opencode|pi --app=<gateway app> [--name=<name>|--display-name=<name>] [--provider=<slug>] [--models=a,b] [--like=<claude instance id>] [--binary=<path>] [--check] [--remove]";

/**
 * `ais gateway t3-instance`: creates or updates one T3 Code provider instance whose folder holds only the gateway app
 * token (src/identities/t3-instance.ts). T3 watches its settings file, so nothing is restarted here.
 */
export async function runT3InstanceCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: Pick<T3InstanceOptions, "home" | "env"> = {}, guard: AgentGuardDeps = {}): Promise<void> {
  const id = args[0];
  if (!id || args.length > 1) throw new CliUsageError(USAGE);
  const check = boolFlag(flags, "check");
  const remove = boolFlag(flags, "remove");
  if (check && remove) throw new CliUsageError("--check and --remove cannot be combined");
  const driver = stringFlag(flags, "driver");
  const app = stringFlag(flags, "app");
  if (driver !== "claude" && driver !== "grok" && driver !== "opencode" && driver !== "pi") throw new CliUsageError(`--driver=claude|grok|opencode|pi is required. ${USAGE}`);
  if (!app && !remove) throw new CliUsageError(`--app=<gateway app> is required. ${USAGE}`);
  const models = stringFlag(flags, "models")?.split(",").map((m) => m.trim()).filter(Boolean);
  const base: T3InstanceOptions = {
    id,
    driver: driver as InstanceDriver,
    app: app ?? "",
    gatewayUrl: "",
    ...opts,
    ...(deps.secretsPath ? { secretsPath: deps.secretsPath } : {}),
    check,
    remove,
  };
  for (const k of ["name", "like", "binary"] as const) {
    const v = stringFlag(flags, k);
    if (v) base[k] = v;
  }
  const displayName = stringFlag(flags, "display-name");
  if (displayName) base.name = displayName;
  if (models && models.length > 0) base.models = models;
  if (!remove) {
    const root = (await readSecretsKey("AIS_GATEWAY_PROXY_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_PROXY_URL;
    if (!root) throw new CliUsageError("Proxy base URL unknown: set AIS_GATEWAY_PROXY_URL in ~/.secrets");
    base.gatewayUrl = `${root.replace(/\/+$/, "")}/${app}`;
    if (driver === "pi") {
      // The upstream provider slug names the pi provider. Without the admin API the app name is used.
      const given = stringFlag(flags, "provider");
      if (given) base.provider = given;
      else {
        try {
          const { admin } = await connect(deps);
          const { json } = await admin.call("GET", `/apps/${app}`);
          if (typeof json.provider === "string" && json.provider !== "") base.provider = json.provider;
        } catch {
          // keep the fallback
        }
      }
    }
  }
  const r = await applyT3Instance(base);
  const detail = r.changes.length > 0 ? `${check ? " (differs" : " (changed"}: ${r.changes.join(", ")})` : "";
  const status = check && r.status !== "current" && r.status !== "absent" ? `would be ${r.status}` : r.status;
  deps.out(`t3-instance: ${id} ${status}${detail}`);
  for (const w of r.warnings ?? []) deps.out(`t3-instance: warning: ${w}`);
  if (r.backup) deps.out(`t3-instance: settings backup ${r.backup}`);
  if (remove && r.status === "removed") deps.out(`t3-instance: the folder ${r.folder} was left in place`);
  let trouble = false;
  for (const u of r.usage ?? []) {
    deps.out(`t3-instance: ${describeUsageResult(u, check)}`);
    if (isUsageTrouble(u, false)) trouble = true;
  }
  // Runs on every apply, also when the home is current, so a home that missed the guard gets it. Never fails the command.
  if (!check && !remove) await installAgentGuardForHome(driver, { ...(opts.home ? { home: opts.home } : {}), log: deps.out, ...guard });
  if (check && r.status !== "current" && r.status !== "absent") throw new Error(`t3-instance ${id} differs`);
  if (trouble) throw new Error(`t3-instance ${id}: usage credential problem`);
}
