import { instancesToken } from "../../gateway/instances-token.ts";
import { ADMIN_TOKEN_KEY } from "../../t3/favourites/config.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { readSecretsKey } from "./secrets-file.ts";

/**
 * `ais gateway instances-token`: prints the t3-instances token derived from the gateway admin token
 * (env or ~/.secrets AIS_GATEWAY_ADMIN_TOKEN). Seal it into the Secret of a T3 pod as AIS_GATEWAY_INSTANCES_TOKEN.
 * The gateway accepts it on GET /apps (a reduced view) and POST /apps/<app>/instance-token only. It prints the token and nothing else.
 */
export async function runInstancesTokenCommand(args: string[], deps: GatewayCliDeps, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway instances-token");
  const admin = env[ADMIN_TOKEN_KEY]?.trim() || (await readSecretsKey(ADMIN_TOKEN_KEY, deps.secretsPath))?.trim();
  if (!admin) throw new CliUsageError(`${ADMIN_TOKEN_KEY} must be set in the environment or in ~/.secrets`);
  deps.out(instancesToken(admin));
}
