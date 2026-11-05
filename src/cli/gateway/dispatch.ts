import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { resolveRemoteBase } from "./local-remote.ts";
import { runKubectl } from "./kube-secret.ts";
import { runAppCommand, runUsageCommand, type GatewayCliDeps } from "./apps.ts";
import { installDrainHandlers, LOCAL_GATEWAY_DEFAULT_PORT, startLocalGateway } from "../../gateway/local.ts";
import { DEFAULT_GATEWAY_ADMIN_PORT, DEFAULT_GATEWAY_PORT, startGateway } from "../../gateway/serve.ts";

function portOf(flag: string | undefined, env: string | undefined, fallback: number, name: string): number {
  const raw = flag ?? env;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`${name} must be a port number, got "${raw}"`);
  return n;
}

export type { GatewayCliDeps };

const defaultDeps = (): GatewayCliDeps => ({ fetch, kubectl: runKubectl, out: (line) => console.info(line), now: () => Date.now() });

export async function runGatewayCommand(positionals: string[], flags: ParsedArgs["flags"], deps: Partial<GatewayCliDeps> = {}): Promise<void> {
  const [sub, ...rest] = positionals;
  const merged: GatewayCliDeps = { ...defaultDeps(), ...deps };
  if (sub === "app") return runAppCommand(rest[0], rest.slice(1), flags, merged);
  if (sub === "usage") return runUsageCommand(flags, merged);
  if (sub === "local") return runLocal(rest, merged);
  if (sub !== "serve") throw new CliUsageError("Usage: ais gateway serve|local|app|usage ...  (ais gateway --help)");
  const databaseUrl = process.env.AIS_GATEWAY_DATABASE_URL;
  const adminToken = process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!databaseUrl) throw new CliUsageError("AIS_GATEWAY_DATABASE_URL is required");
  if (!adminToken) throw new CliUsageError("AIS_GATEWAY_ADMIN_TOKEN is required");
  const port = portOf(stringFlag(flags, "port"), process.env.AIS_GATEWAY_PORT, DEFAULT_GATEWAY_PORT, "AIS_GATEWAY_PORT");
  const adminPort = portOf(stringFlag(flags, "admin-port"), process.env.AIS_GATEWAY_ADMIN_PORT, DEFAULT_GATEWAY_ADMIN_PORT, "AIS_GATEWAY_ADMIN_PORT");
  const gateway = await startGateway({ port, adminPort, databaseUrl, adminToken, handleSignals: true });
  console.info(`gateway: proxy on :${gateway.port}, admin on :${gateway.adminPort}; warming up`);
  // Runs until SIGTERM or SIGINT, whose handler drains and exits the process.
  await new Promise<void>(() => {});
}

async function runLocal(args: string[], deps: GatewayCliDeps): Promise<void> {
  const port = portOf(undefined, process.env.AIS_GATEWAY_LOCAL_PORT, LOCAL_GATEWAY_DEFAULT_PORT, "AIS_GATEWAY_LOCAL_PORT");
  if (args[0] === "install") {
    const { installLocalGatewayService } = await import("./local-service.ts");
    const r = await installLocalGatewayService();
    deps.out(`gateway local: ${r.action}${r.slot ? ` (slot ${r.slot})` : ""}; unit at ${r.path}`);
    return;
  }
  if (args[0] === "status") {
    const { fetchLocalStatus } = await import("./local-service.ts");
    const st = await fetchLocalStatus(port);
    deps.out(st ? `gateway local: ${st.mode} mode since ${new Date(st.sinceMs).toISOString()} (remote ${st.remote})` : `gateway local: not running on 127.0.0.1:${port}`);
    return;
  }
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway local [install|status]");
  const remoteBase = await resolveRemoteBase();
  const running = await startLocalGateway({ port, remoteBase, bindRetryMs: 30_000 });
  console.info(`gateway local: listening on 127.0.0.1:${running.port}`);
  installDrainHandlers(running);
  await new Promise<void>(() => {});
}
