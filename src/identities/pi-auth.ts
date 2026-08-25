import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PiCredentialSource = "claude" | "codex" | "grok" | "kimi" | "zai" | "ali";

export interface PiCredentialSourceDirs {
  claude?: string;
  codex?: string;
  grok?: string;
  kimi?: string;
  zai?: string;
  ali?: string;
  /** OpenCode Go is already a native Pi provider, so unlike the six
   * provider-specific AIS registries above it only needs its API key copied
   * into this Pi identity. The CLI obtains this through a masked prompt or
   * OPENCODE_API_KEY; callers never need to put the key in argv. */
  opencodeGoApiKey?: string;
}

type JsonObject = Record<string, unknown>;
type PiCredential =
  | { type: "api_key"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };

export interface PiCredentialImportResult {
  providers: string[];
  authPath: string;
  modelsPath?: string;
}

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  return value as JsonObject;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context}: expected a non-empty string`);
  }
  return value;
}

async function readJson(path: string): Promise<JsonObject> {
  try {
    return object(await Bun.file(path).json(), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(path)) throw error;
    throw new Error(`${path}: could not read valid JSON`, { cause: error });
  }
}

function normaliseExpiry(value: unknown, fallbackAccessToken?: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (fallbackAccessToken) {
    try {
      const payload = fallbackAccessToken.split(".")[1];
      if (payload) {
        const decoded = object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), "JWT payload");
        if (typeof decoded.exp === "number") return decoded.exp * 1000;
      }
    } catch {
      // A non-JWT access token is valid for several providers. A short
      // fallback forces Pi to refresh it promptly using the imported refresh
      // token instead of pretending it has a known lifetime.
    }
  }
  return Date.now() + 5 * 60 * 1000;
}

function oauth(access: unknown, refresh: unknown, expires: unknown, context: string): PiCredential {
  const accessToken = string(access, `${context}.access`);
  return {
    type: "oauth",
    access: accessToken,
    refresh: string(refresh, `${context}.refresh`),
    expires: normaliseExpiry(expires, accessToken),
  };
}

function claudeCredential(json: JsonObject): PiCredential {
  const auth = object(json.claudeAiOauth, "claudeAiOauth");
  return oauth(auth.accessToken, auth.refreshToken, auth.expiresAt, "claudeAiOauth");
}

function codexCredential(json: JsonObject): PiCredential {
  const tokens = object(json.tokens, "codex tokens");
  return oauth(tokens.access_token, tokens.refresh_token, undefined, "codex tokens");
}

function grokCredential(json: JsonObject): PiCredential {
  const candidates = Object.values(json)
    .filter((value): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value))
    .filter((value) => typeof value.key === "string" && typeof value.refresh_token === "string")
    .sort((a, b) => normaliseExpiry(b.expires_at) - normaliseExpiry(a.expires_at));
  const selected = candidates[0];
  if (!selected) throw new Error("grok auth.json: no OAuth account credential found");
  return oauth(selected.key, selected.refresh_token, selected.expires_at, "grok OAuth credential");
}

function kimiCredential(json: JsonObject): PiCredential {
  return oauth(json.access_token, json.refresh_token, json.expires_at, "Kimi credential");
}

function providerApiKey(json: JsonObject, provider: string, context: string): string {
  const providers = object(json.providers, `${context}.providers`);
  const entry = object(providers[provider], `${context}.providers.${provider}`);
  return string(entry.api_key, `${context}.providers.${provider}.api_key`);
}

function alibabaModels(json: JsonObject): JsonObject {
  const providers = object(json.providers, "Alibaba Crush config providers");
  const provider = object(providers.alibaba, "Alibaba Crush provider");
  const rawModels = Array.isArray(provider.models) ? provider.models : [];
  if (rawModels.length === 0) throw new Error("Alibaba Crush provider has no configured models");
  const models = rawModels.map((raw, index) => {
    const model = object(raw, `Alibaba model ${index}`);
    const supportsAttachments = model.supports_attachments === true;
    return {
      id: string(model.id, `Alibaba model ${index}.id`),
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      reasoning: model.can_reason === true,
      input: supportsAttachments ? ["text", "image"] : ["text"],
      ...(typeof model.context_window === "number" ? { contextWindow: model.context_window } : {}),
      ...(typeof model.default_max_tokens === "number" ? { maxTokens: model.default_max_tokens } : {}),
      cost: {
        input: typeof model.cost_per_1m_in === "number" ? model.cost_per_1m_in : 0,
        output: typeof model.cost_per_1m_out === "number" ? model.cost_per_1m_out : 0,
        cacheRead: typeof model.cost_per_1m_in_cached === "number" ? model.cost_per_1m_in_cached : 0,
        cacheWrite: typeof model.cost_per_1m_out_cached === "number" ? model.cost_per_1m_out_cached : 0,
      },
    };
  });
  return {
    baseUrl: string(provider.base_url, "Alibaba Crush provider base_url"),
    api: "anthropic-messages",
    authHeader: true,
    models,
  };
}

async function writeSensitiveJsonAtomic(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.ais-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Merge credentials from existing AIS provider identities into one Pi
 * identity. Secret values are never returned or logged. Existing unrelated Pi
 * credentials and custom providers are preserved.
 */
export async function importPiCredentials(
  piConfigDir: string,
  sourceDirs: PiCredentialSourceDirs,
): Promise<PiCredentialImportResult> {
  const authPath = join(piConfigDir, "auth.json");
  const auth = (await Bun.file(authPath).exists()) ? await readJson(authPath) : {};
  const providers: string[] = [];
  let alibabaProvider: JsonObject | undefined;

  if (sourceDirs.claude) {
    auth.anthropic = claudeCredential(await readJson(join(sourceDirs.claude, ".credentials.json")));
    providers.push("anthropic");
  }
  if (sourceDirs.codex) {
    auth["openai-codex"] = codexCredential(await readJson(join(sourceDirs.codex, "auth.json")));
    providers.push("openai-codex");
  }
  if (sourceDirs.grok) {
    auth.xai = grokCredential(await readJson(join(sourceDirs.grok, "auth.json")));
    providers.push("xai");
  }
  if (sourceDirs.kimi) {
    auth["kimi-coding"] = kimiCredential(
      await readJson(join(sourceDirs.kimi, "credentials", "kimi-code.json")),
    );
    providers.push("kimi-coding");
  }
  if (sourceDirs.zai) {
    const json = await readJson(join(sourceDirs.zai, "crush.json"));
    auth.zai = { type: "api_key", key: providerApiKey(json, "zai", "ZAI Crush config") };
    providers.push("zai");
  }
  if (sourceDirs.ali) {
    const json = await readJson(join(sourceDirs.ali, "crush.json"));
    auth["alibaba-plan"] = {
      type: "api_key",
      key: providerApiKey(json, "alibaba", "Alibaba Crush config"),
    };
    alibabaProvider = alibabaModels(json);
    providers.push("alibaba-plan");
  }
  if (sourceDirs.opencodeGoApiKey) {
    auth["opencode-go"] = { type: "api_key", key: sourceDirs.opencodeGoApiKey };
    providers.push("opencode-go");
  }

  if (providers.length === 0) throw new Error("No Pi credential sources were supplied");
  await writeSensitiveJsonAtomic(authPath, auth);

  let modelsPath: string | undefined;
  if (alibabaProvider) {
    modelsPath = join(piConfigDir, "models.json");
    const models = (await Bun.file(modelsPath).exists()) ? await readJson(modelsPath) : {};
    const configuredProviders =
      typeof models.providers === "object" && models.providers !== null && !Array.isArray(models.providers)
        ? (models.providers as JsonObject)
        : {};
    models.providers = { ...configuredProviders, "alibaba-plan": alibabaProvider };
    await writeSensitiveJsonAtomic(modelsPath, models);
  }

  return { providers, authPath, ...(modelsPath ? { modelsPath } : {}) };
}
