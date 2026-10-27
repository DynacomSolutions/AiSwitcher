import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { expandPath } from "./match.ts";
import { loadIdentitiesFile } from "./store.ts";
import { KIMI_CONFIG } from "./tool-configs.ts";
import type { ResolvedIdentity } from "./types.ts";
import { requirePool } from "./pool/swap-pool.ts";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * Kimi launch helper: a pool's configDir carries the swapped credentials but
 * nobody ever configures models inside it, and Kimi refuses to run when the
 * selected model is not configured in its config.toml ("Model ... is not
 * configured"). Seed the pool config.toml ONCE from the current active
 * member's own config: the `default_model` root key, the `[secondary_model]`
 * table (copied all-or-nothing), every missing `models` table entry, and the
 * missing `providers` entries those newly added models reference. Existing
 * pool keys and table entries always win (a later in-pool /model choice is
 * written to the same file and must never be overwritten); an active member
 * without a usable `default_model` invents nothing and no file is created.
 * Ordinary identities and non-pool launches are a no-op. Never throws: a
 * launch must not fail over a seeding step.
 *
 * Credential safety: the seeded entries carry no secrets. Credential-shaped
 * keys (api keys, tokens, secrets, passwords, authorization/credential
 * fields) are stripped recursively from copied model and provider entries; a
 * provider `api_key` survives only when it is the empty string (OAuth
 * providers keep their grant in the swapped credentials file, not in
 * config.toml). OAuth storage/key metadata is kept: it is a pointer, not a
 * secret.
 */

/** JSON basic strings share TOML's escapes; TOML also forbids a literal DEL. */
const tomlString = (value: string): string => JSON.stringify(value).replace(/\x7f/g, "\\u007f");

/**
 * Credential-shaped substrings, matched on the lowercased key with all
 * non-alphanumerics removed so `api-key`, `api.key` and `apiKey` forms are
 * caught alongside `api_key`/`apikey`. Plain `key` is not listed: the OAuth
 * storage/key metadata is a pointer, not a secret, and must survive.
 */
const CREDENTIAL_KEY_PARTS = ["apikey", "token", "secret", "password", "authorization", "credential"];

const isCredentialKey = (key: string): boolean => {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_KEY_PARTS.some((part) => normalised.includes(part));
};

/** Deep copy without credential-shaped keys; a provider api_key survives only as the empty string. */
function stripCredentialFields(value: unknown, keepEmptyApiKey: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => stripCredentialFields(item, keepEmptyApiKey));
  if (value !== null && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isCredentialKey(key)) {
        if (keepEmptyApiKey && key === "api_key" && item === "") clean[key] = item;
        continue;
      }
      clean[key] = stripCredentialFields(item, keepEmptyApiKey);
    }
    return clean;
  }
  return value;
}

/** A parsed TOML table, or {} when the value is missing or not a table. */
const tableOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A plain TOML sub-table entry (a scalar model/provider entry is never copied). */
const isTable = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const usable = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

interface ConfigProbe {
  /** File content, undefined when absent or unreadable. */
  source: string | undefined;
  /** Root keys; undefined when the file exists but did not parse. */
  parsed: Record<string, unknown> | undefined;
}

async function probeConfig(configDir: string): Promise<ConfigProbe> {
  let source: string | undefined;
  try {
    source = await readFile(join(expandPath(configDir), "config.toml"), "utf8");
  } catch {
    return { source: undefined, parsed: undefined };
  }
  try {
    return { source, parsed: parseToml(source) as Record<string, unknown> };
  } catch {
    // Parser diagnostics can echo source lines; the file is left alone.
    return { source, parsed: undefined };
  }
}

export async function seedKimiPoolModelConfig(
  configDir: string,
  resolved: ResolvedIdentity,
  deps: { registryPath?: string } = {},
): Promise<void> {
  try {
    const launched = resolved.identity;
    if (!launched?.swapPool) return;
    // Re-read the registry fresh: the pre-launch pool check may have swapped
    // the active member after resolution. A duplicate pool name redirects to
    // the canonical record.
    const file = await loadIdentitiesFile(deps.registryPath ?? KIMI_CONFIG.identitiesJsonPath).catch(() => undefined);
    if (!file) return;
    let pool;
    try {
      pool = requirePool(file, launched.name, "kimi");
    } catch {
      return;
    }
    const poolConfig = await probeConfig(pool.configDir);
    // An unparsable pool config is never touched.
    if (poolConfig.source !== undefined && poolConfig.parsed === undefined) return;
    const activeName = pool.swapPool.active;
    const active = activeName === undefined ? undefined : file.identities.find((i) => i.name === activeName);
    if (!active) return;
    const memberConfig = await probeConfig(active.configDir);
    const member = memberConfig.parsed;
    if (member === undefined) return;
    const poolParsed = poolConfig.parsed ?? {};

    // With no usable default_model on either side the pool could not pick a
    // model anyway: invent nothing and leave the file alone (never create it).
    const memberDefault = member.default_model;
    if (!Object.hasOwn(poolParsed, "default_model") && !usable(memberDefault)) return;

    const seeds: string[] = [];
    if (!Object.hasOwn(poolParsed, "default_model") && usable(memberDefault)) {
      seeds.push(`default_model = ${tomlString(memberDefault)}`);
    }

    // [secondary_model] holds a default_model and model aliases: copy the
    // whole table or nothing, and only while the pool has none of its own.
    const memberSecondary = member.secondary_model;
    const secondaryToAdd =
      !Object.hasOwn(poolParsed, "secondary_model") && isTable(memberSecondary) ? memberSecondary : undefined;

    const poolModels = tableOf(poolParsed.models);
    const referencedProviders = new Set<string>();
    const modelsToAdd: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(tableOf(member.models))) {
      if (Object.hasOwn(poolModels, id) || !isTable(entry)) continue;
      modelsToAdd[id] = stripCredentialFields(entry, false);
      if (typeof entry.provider === "string") referencedProviders.add(entry.provider);
    }
    const poolProviders = tableOf(poolParsed.providers);
    const memberProviders = tableOf(member.providers);
    const providersToAdd: Record<string, unknown> = {};
    for (const id of referencedProviders) {
      if (Object.hasOwn(poolProviders, id)) continue;
      const entry = memberProviders[id];
      if (!isTable(entry)) continue;
      providersToAdd[id] = stripCredentialFields(entry, true);
    }

    // stringify emits `[models."id"]`/`[providers."id"]` without a parent
    // header, so appending only the missing entries never duplicates a table.
    const sections: string[] = [];
    if (secondaryToAdd !== undefined) sections.push(stringifyToml({ secondary_model: secondaryToAdd }));
    if (Object.keys(modelsToAdd).length > 0) sections.push(stringifyToml({ models: modelsToAdd }));
    if (Object.keys(providersToAdd).length > 0) sections.push(stringifyToml({ providers: providersToAdd }));
    if (seeds.length === 0 && sections.length === 0) return;

    const poolPath = join(expandPath(pool.configDir), "config.toml");
    if (poolConfig.source === undefined) await mkdir(dirname(poolPath), { recursive: true });
    // The root default_model is prepended so it stays at TOML's root level
    // whatever the rest of the document declares; missing table sections are
    // appended. The existing source in between is kept byte-identical.
    let content = seeds.length > 0 ? `${seeds.join("\n")}\n\n${poolConfig.source ?? ""}` : (poolConfig.source ?? "");
    if (sections.length > 0) {
      if (content !== "" && !content.endsWith("\n")) content += "\n";
      content += `${content === "" ? "" : "\n"}${sections.join("\n")}`;
    }
    await writeFileAtomic(poolPath, content);
  } catch (err) {
    console.error(`kimi: could not seed the pool model configuration (${err instanceof Error ? err.message : String(err)}); launching without it`);
  }
}
