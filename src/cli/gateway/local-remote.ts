import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultSecretsPath, readSecretsKey } from "./secrets-file.ts";

export const rememberedRemotePath = (): string => join(homedir(), ".ais", "gateway-local-remote");

export interface ResolveRemoteOptions {
  env?: Record<string, string | undefined>;
  secretsPath?: string;
  rememberPath?: string;
}

/**
 * The cluster gateway base for the local proxy. Order: AIS_GATEWAY_REMOTE_URL, AIS_GATEWAY_PROXY_URL (both shell env, never remembered),
 * then AIS_GATEWAY_PROXY_URL in ~/.secrets (remembered). A readable ~/.secrets without the key clears the remembered copy;
 * an unreadable one falls back to it. Empty string means no remote is known.
 */
export async function resolveRemoteBase(opts: ResolveRemoteOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const secretsPath = opts.secretsPath ?? defaultSecretsPath();
  const rememberPath = opts.rememberPath ?? rememberedRemotePath();
  const fromEnv = env.AIS_GATEWAY_REMOTE_URL || env.AIS_GATEWAY_PROXY_URL;
  if (fromEnv) return fromEnv;
  const readable = await readFile(secretsPath, "utf8").then(() => true, () => false);
  const fromSecrets = readable ? await readSecretsKey("AIS_GATEWAY_PROXY_URL", secretsPath) : undefined;
  if (fromSecrets) {
    await mkdir(dirname(rememberPath), { recursive: true }).then(() => writeFile(rememberPath, `${fromSecrets}\n`, { mode: 0o600 })).catch(() => undefined);
    return fromSecrets;
  }
  if (readable) {
    await rm(rememberPath, { force: true }).catch(() => undefined);
    return "";
  }
  return readFile(rememberPath, "utf8").then((t) => t.trim(), () => "");
}
