import { defaultSecretsPath, readSecretsKey } from "../../cli/gateway/secrets-file.ts";

export const ADMIN_URL_KEY = "AIS_GATEWAY_ADMIN_URL";
export const ADMIN_TOKEN_KEY = "AIS_GATEWAY_ADMIN_TOKEN";
/** The favourites-only token (`ais gateway favourites-token`). The sync prefers it to the admin token. */
export const FAVOURITES_TOKEN_KEY = "AIS_GATEWAY_FAVOURITES_TOKEN";

/**
 * The gateway admin address and the token for /favourites, from the environment first and then ~/.secrets.
 * The token is the favourites-only one when it is set, else the admin token (the key the host credential sync uses).
 */
export async function gatewayAdmin(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<{ url: string; token: string } | undefined> {
  const get = async (k: string): Promise<string | undefined> => env[k]?.trim() || (await readSecretsKey(k, secretsPath))?.trim() || undefined;
  const url = await get(ADMIN_URL_KEY);
  const token = (await get(FAVOURITES_TOKEN_KEY)) ?? (await get(ADMIN_TOKEN_KEY));
  return url && token ? { url, token } : undefined;
}
