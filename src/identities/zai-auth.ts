import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expandPath } from "./match.ts";
import { ZAI_MODEL_PRICES } from "./model-pricing.ts";

/** Z.ai's real endpoint for Crush's openai-compatible provider shape —
 * confirmed via Z.ai's own devpack docs and empirically live (2026-07-17):
 * writing this exact provider entry into a plain crush.json, with NO
 * `crush login` ever run, was enough for `crush run "..." --model
 * zai/glm-4.6` to attempt a real request to this endpoint (rejected only for
 * an invalid placeholder key, proving the config was actually read and used,
 * not just listed from Crush's own static model catalog). Matches the
 * `api_endpoint` of Crush's own built-in "zai" provider entry (Crush ships
 * Z.ai as a known provider already — see the `models` comment below for why
 * we still fully define it ourselves rather than relying on that). */
const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/**
 * The real GLM model list, copied from Crush's own built-in Catwalk catalog
 * entry for provider id "zai" (`~/.local/share/crush/providers.json`,
 * confirmed live 2026-07-17). Kept as a static fallback — NOT the only
 * source of truth — because `discover_models: true` below makes Crush merge
 * in a live-fetched list from Z.ai's own API when a working key is present
 * (confirmed live: a real key returned 8 models, a strict subset of this
 * static 11, and the merge kept all 11 rather than shrinking to 8). This
 * static list is what keeps a freshly-created zai identity usable (picking a
 * model, starting Crush at all) even before a real key is supplied — see
 * `writeZaiAuthFile`'s caller in `cli/identities/create.ts`, which allows a
 * blank key at creation time. Without it, an unconfigured/invalid key would
 * make model discovery fail with nothing to fall back to, and
 * `disable_default_providers` (below) would then leave zero usable
 * providers, refusing to start Crush at all.
 */
const ZAI_MODELS = [
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    ...ZAI_MODEL_PRICES["glm-5.2"],
    context_window: 1000000,
    default_max_tokens: 131072,
    can_reason: true,
    reasoning_levels: ["high", "xhigh"],
    default_reasoning_effort: "xhigh",
    supports_attachments: false,
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    ...ZAI_MODEL_PRICES["glm-5.1"],
    context_window: 204800,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-5-turbo",
    name: "GLM-5-Turbo",
    ...ZAI_MODEL_PRICES["glm-5-turbo"],
    context_window: 200000,
    default_max_tokens: 128000,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-5",
    name: "GLM-5",
    ...ZAI_MODEL_PRICES["glm-5"],
    context_window: 204800,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    ...ZAI_MODEL_PRICES["glm-4.7"],
    context_window: 204800,
    default_max_tokens: 98000,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    ...ZAI_MODEL_PRICES["glm-4.7-flash"],
    context_window: 200000,
    default_max_tokens: 65550,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    ...ZAI_MODEL_PRICES["glm-4.6"],
    context_window: 204800,
    default_max_tokens: 102400,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.6v",
    name: "GLM-4.6V",
    ...ZAI_MODEL_PRICES["glm-4.6v"],
    context_window: 131072,
    default_max_tokens: 65536,
    can_reason: true,
    supports_attachments: true,
  },
  {
    id: "glm-4.5",
    name: "GLM-4.5",
    ...ZAI_MODEL_PRICES["glm-4.5"],
    context_window: 131072,
    default_max_tokens: 49152,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.5-air",
    name: "GLM-4.5-Air",
    ...ZAI_MODEL_PRICES["glm-4.5-air"],
    context_window: 131072,
    default_max_tokens: 49152,
    can_reason: true,
    supports_attachments: false,
  },
  {
    id: "glm-4.5v",
    name: "GLM-4.5V",
    ...ZAI_MODEL_PRICES["glm-4.5v"],
    context_window: 65536,
    default_max_tokens: 8192,
    can_reason: true,
    supports_attachments: true,
  },
];

/**
 * Writes Crush's own config file (`<configDir>/crush.json`) with a fully
 * self-contained "zai" provider entry, directly into a zai identity's own
 * configDir — this is what lets a zai identity work with zero interactive
 * `crush login`, closing the exact gap an earlier (opencode-based) design
 * had. `CRUSH_GLOBAL_CONFIG` points straight at the directory holding
 * `crush.json` (confirmed via `crush dirs`) — no nested subfolder needed,
 * unlike opencode's own `auth.json` convention.
 *
 * Also sets `options.disable_default_providers: true` — confirmed live
 * (2026-07-17) this is the ONLY thing that actually restricts Crush's model
 * picker/`crush models` output to just GLM. Crush ships a built-in "zai"
 * provider already (its Catwalk catalog), so a working key alone is enough
 * for zai to WORK, but every other known provider (Gemini, Grok/xAI, OpenAI,
 * Anthropic, dozens of resellers, ...) still shows up alongside it in the
 * picker/listing — not what a Z.ai-only CLI should look like. Setting
 * `disable_default_providers` skips loading that entire default catalog, but
 * then requires each custom provider to be FULLY self-specified (`type` +
 * non-empty `models`) to count as "configured" — an override-only entry
 * (just `base_url`/`api_key`, relying on the built-in "zai" catalog entry to
 * fill in the rest) stops validating once the built-in catalog is gone, and
 * Crush refuses to start at all ("no custom providers are configured").
 * Hence `type: "openai-compat"` and the static `ZAI_MODELS` list above are
 * both required here, not optional extras.
 *
 * IMPORTANT: do NOT reach for `crush update-providers` to trim/scope the
 * model catalog instead of this — confirmed live (2026-07-17) that command
 * ignores `CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA` entirely and always
 * writes to the real global `~/.local/share/crush/providers.json` (governed
 * by `XDG_DATA_HOME`/the OS default, a path this project's per-identity env
 * vars don't touch at all) — running it against one identity corrupts the
 * shared default Crush install for every identity and any ad-hoc `crush`
 * usage outside this project. Restorable via a plain `crush update-providers`
 * (re-fetches the full Catwalk list), but avoid the whole mechanism.
 *
 * Read-modify-write, not a blind overwrite: preserves any OTHER config a
 * user may have added to this same file directly (other providers, model
 * preferences, ...) — matters for the update path (rotating a key on an
 * already-in-use identity), not just fresh creation (where the file can't
 * exist yet anyway). Same treatment for `options`: merged in, not replaced.
 */
export async function writeZaiAuthFile(configDir: string, apiKey: string): Promise<void> {
  const dir = expandPath(configDir);
  await mkdir(dir, { recursive: true });
  const authPath = join(dir, "crush.json");

  let existing: Record<string, unknown> = {};
  try {
    existing = (await Bun.file(authPath).json()) as Record<string, unknown>;
  } catch {
    // No existing crush.json — the common case right after identity creation.
  }

  const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
  const options = (existing.options as Record<string, unknown> | undefined) ?? {};
  const merged = {
    ...existing,
    providers: {
      ...providers,
      zai: {
        type: "openai-compat",
        name: "ZAI Provider",
        base_url: ZAI_BASE_URL,
        api_key: apiKey,
        discover_models: true,
        models: ZAI_MODELS,
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
 * Reads back the literal Z.ai API key `writeZaiAuthFile` wrote into
 * `<configDir>/crush.json`, for callers that need to make their OWN request
 * against Z.ai's API directly (e.g. `limits/zai-limits.ts`'s live quota
 * fetch, `usage/tokscale.ts`'s `ZAI_API_KEY` env var for tokscale's own zai
 * client) rather than going through Crush itself.
 *
 * Returns undefined for anything that isn't a usable literal string key: no
 * file, unparseable JSON, no `providers.zai.api_key` at all, or a value that
 * looks like an env-var reference (e.g. `"$ZAI_API_KEY"`, valid in Crush's
 * own config but not something this project's HTTP callers can resolve) —
 * callers treat undefined the same as "not authenticated yet" rather than
 * sending a literal placeholder string as a Bearer token.
 */
export async function readZaiApiKey(configDir: string): Promise<string | undefined> {
  const authPath = join(expandPath(configDir), "crush.json");
  let contents: Record<string, unknown>;
  try {
    contents = (await Bun.file(authPath).json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const providers = contents.providers as Record<string, unknown> | undefined;
  const zai = providers?.zai as Record<string, unknown> | undefined;
  const apiKey = zai?.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.startsWith("$")) return undefined;
  return apiKey;
}
