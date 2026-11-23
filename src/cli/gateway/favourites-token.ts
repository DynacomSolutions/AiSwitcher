import { favouritesToken } from "../../gateway/favourites-token.ts";
import { ADMIN_TOKEN_KEY } from "../../t3/favourites/config.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";
import { readSecretsKey } from "./secrets-file.ts";

/**
 * `ais gateway favourites-token`: prints the favourites-only token derived from the gateway admin token
 * (env or ~/.secrets AIS_GATEWAY_ADMIN_TOKEN). Seal it into the Secret of a T3 pod sidecar as AIS_GATEWAY_FAVOURITES_TOKEN.
 * The gateway accepts it on GET and POST /favourites only. It prints the token and nothing else.
 */
export async function runFavouritesTokenCommand(args: string[], deps: GatewayCliDeps, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway favourites-token");
  const admin = env[ADMIN_TOKEN_KEY]?.trim() || (await readSecretsKey(ADMIN_TOKEN_KEY, deps.secretsPath))?.trim();
  if (!admin) throw new CliUsageError(`${ADMIN_TOKEN_KEY} must be set in the environment or in ~/.secrets`);
  deps.out(favouritesToken(admin));
}
