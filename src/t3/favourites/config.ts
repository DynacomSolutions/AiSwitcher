import { defaultSecretsPath, readSecretsKey } from "../../cli/gateway/secrets-file.ts";

export const ADMIN_URL_KEY = "AIS_GATEWAY_ADMIN_URL";
export const ADMIN_TOKEN_KEY = "AIS_GATEWAY_ADMIN_TOKEN";

/** The gateway admin address and token, from the environment first and then ~/.secrets: the same two keys the host credential sync uses. */
export async function gatewayAdmin(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<{ url: string; token: string } | undefined> {
  const get = async (k: string): Promise<string | undefined> => env[k]?.trim() || (await readSecretsKey(k, secretsPath))?.trim() || undefined;
  const url = await get(ADMIN_URL_KEY);
  const token = await get(ADMIN_TOKEN_KEY);
  return url && token ? { url, token } : undefined;
}
