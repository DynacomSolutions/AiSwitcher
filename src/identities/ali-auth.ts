import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expandPath } from "./match.ts";
import { ALI_MODEL_PRICES } from "./model-pricing.ts";

/**
 * Alibaba Cloud Model Studio's Token plan endpoint, Anthropic-compatible
 * shape (confirmed live, 2026-08-07): writing this exact provider entry
 * into a plain crush.json, with NO `crush login` ever run, was enough for
 * `crush run --model alibaba/<id> "..."` to attempt a real request to
 * `<base_url>/v1/messages` (rejected only for an invalid placeholder key,
 * a genuine Alibaba 401 with a request_id, proving the config was actually
 * read and used, the same proof shape zai-auth.ts's own writer relies on).
 */
const ALI_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";

/**
 * A static model list for Alibaba's Token plan: unlike zai-auth.ts's
 * ZAI_MODELS, this is the ONLY source of truth, not a fallback: the Token
 * plan endpoint has no model-list endpoint at all (only /v1/messages), so
 * there is nothing for crush's own `discover_models` to merge in (see
 * `writeAliAuthFile` below for why `discover_models` is omitted entirely
 * rather than set to `false` for clarity). Costs are public-price estimates,
 * including plan-included tokens; context windows/max-tokens are reasonable
 * fallback metadata, not independently verified per-model figures.
 */
const ALI_MODELS = [
  {
    // The GA id, distinct from the -preview one below. Both confirmed live
    // (2026-08-07) with real /v1/messages requests against a Token plan key;
    // the endpoint has no model-list API, so any id missing from this static
    // list is simply invisible in Crush's picker even when the subscription
    // supports it.
    id: "qwen3.8-max",
    name: "Qwen3.8-Max",
    ...ALI_MODEL_PRICES["qwen3.8-max"],
    context_window: 262144,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "qwen3.8-max-preview",
    name: "Qwen3.8-Max-Preview",
    ...ALI_MODEL_PRICES["qwen3.8-max-preview"],
    context_window: 262144,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "qwen3.7-max",
    name: "Qwen3.7-Max",
    ...ALI_MODEL_PRICES["qwen3.7-max"],
    context_window: 262144,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7-Plus",
    ...ALI_MODEL_PRICES["qwen3.7-plus"],
    context_window: 262144,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6-Plus",
    ...ALI_MODEL_PRICES["qwen3.6-plus"],
    context_window: 131072,
    default_max_tokens: 32768,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "qwen3.6-flash",
    name: "Qwen3.6-Flash",
    ...ALI_MODEL_PRICES["qwen3.6-flash"],
    context_window: 131072,
    default_max_tokens: 32768,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    ...ALI_MODEL_PRICES["glm-5.2"],
    context_window: 204800,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    ...ALI_MODEL_PRICES["deepseek-v4-pro"],
    context_window: 131072,
    default_max_tokens: 32768,
    can_reason: true,
    supports_attachments: false,
  },
];

/**
 * Writes Crush's own config file (`<configDir>/crush.json`) with a fully
 * self-contained "alibaba" provider entry, directly into an ali identity's
 * own configDir. Mirrors zai-auth.ts's `writeZaiAuthFile` one-for-one
 * (read-modify-write, same `disable_default_providers`/static-models
 * requirement for the same reason, see that function's own doc for the
 * full "why disable_default_providers, why the model list must be
 * self-contained" explanation, which applies identically here).
 *
 * One deliberate difference from zai: `discover_models` is NOT set at all
 * (zai sets it to `true`). Confirmed live (2026-08-07): Alibaba's Token plan
 * endpoint has no model-list endpoint whatsoever (only `/v1/messages`), so
 * live discovery would simply fail on every launch; ALI_MODELS above is the
 * only source of truth for this provider, not a fallback a live fetch could
 * ever supersede.
 */
export async function writeAliAuthFile(configDir: string, apiKey: string): Promise<void> {
  const dir = expandPath(configDir);
  await mkdir(dir, { recursive: true });
  const authPath = join(dir, "crush.json");

  let existing: Record<string, unknown> = {};
  try {
    existing = (await Bun.file(authPath).json()) as Record<string, unknown>;
  } catch {
    // No existing crush.json: the common case right after identity creation.
  }

  const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
  const options = (existing.options as Record<string, unknown> | undefined) ?? {};
  const merged = {
    ...existing,
    providers: {
      ...providers,
      alibaba: {
        type: "anthropic",
        name: "Alibaba Cloud Model Studio",
        base_url: ALI_BASE_URL,
        api_key: apiKey,
        models: ALI_MODELS,
      },
    },
    options: {
      ...options,
      disable_default_providers: true,
    },
  };

  await Bun.write(authPath, `${JSON.stringify(merged, null, 2)}\n`);
  await chmod(authPath, 0o600);
}

/**
 * Reads back the literal Alibaba API key `writeAliAuthFile` wrote into
 * `<configDir>/crush.json`. Mirrors zai-auth.ts's `readZaiApiKey`
 * one-for-one. Alibaba has no documented quota/usage API for this plan (see
 * AGENTS.md's "ali case study"), so unlike `readZaiApiKey` this has no
 * `limits`/tokscale caller today, kept for parity and for any future direct
 * API caller, and because `cli/identities/dispatch.ts`'s update path needs
 * it symmetrically with zai's.
 */
export async function readAliApiKey(configDir: string): Promise<string | undefined> {
  const authPath = join(expandPath(configDir), "crush.json");
  let contents: Record<string, unknown>;
  try {
    contents = (await Bun.file(authPath).json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const providers = contents.providers as Record<string, unknown> | undefined;
  const alibaba = providers?.alibaba as Record<string, unknown> | undefined;
  const apiKey = alibaba?.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.startsWith("$")) return undefined;
  return apiKey;
}
