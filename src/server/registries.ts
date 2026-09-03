import { stat } from "node:fs/promises";
import {
  addAlias,
  addDirectory,
  createIdentity,
  deleteIdentity,
  removeAlias,
  removeDirectory,
  updateIdentity,
  type CreateIdentityInput,
} from "../cli/identities/actions.ts";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { expandPath } from "../identities/index.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "../identities/store.ts";
import { writeAliAuthFile } from "../identities/ali-auth.ts";
import { writeZaiAuthFile } from "../identities/zai-auth.ts";
import type { ToolConfig } from "../identities/types.ts";
import { HttpError, type RegistryDto, type RegistriesDto } from "./types.ts";

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function registryDto(cfg: ToolConfig, file: Awaited<ReturnType<typeof loadIdentitiesFile>>): RegistryDto {
  return {
    toolName: cfg.toolName,
    path: cfg.identitiesJsonPath,
    identities: file.identities.map((identity) => ({
      name: identity.name,
      label: identity.label,
      ...(identity.description !== undefined ? { description: identity.description } : {}),
      configDir: identity.configDir,
      configDirExists: true, // replaced below
      ...(identity.directories?.length ? { directories: identity.directories } : {}),
      ...(identity.aliases?.length ? { aliases: identity.aliases } : {}),
    })),
    ...(file.chromeProfileOverrides?.length ? { chromeProfileOverrides: file.chromeProfileOverrides } : {}),
  };
}

/** `configs` follows the repo's test-injection convention (same as
 * collectLimitTargets): defaults to the real TOOL_CONFIGS, overridden by
 * tests with synthetic registries under a temp dir so mutations can never
 * touch the live home. */
export async function listRegistries(configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<RegistriesDto> {
  const loaded = await loadAll(configs);
  const registries = await Promise.all(
    loaded.map(async ({ cfg, file }) => {
      const dto = registryDto(cfg, file);
      await Promise.all(
        dto.identities.map(async (identity) => {
          identity.configDirExists = await dirExists(identity.configDir);
        }),
      );
      return dto;
    }),
  );
  return { registries };
}

export function requireTool(toolName: string, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): ToolConfig {
  const cfg = configs.find((candidate) => candidate.toolName === toolName);
  if (!cfg) throw new HttpError(404, `unknown tool "${toolName}"`);
  return cfg;
}

/** Loads the registry for mutation work, applies the caller's pure action,
 * persists atomically, and hands back the updated file (for echoing state).
 * All mutations share this one I/O shape so none can forget the save. */
async function withRegistry<T>(
  cfg: ToolConfig,
  mutate: (file: Awaited<ReturnType<typeof loadIdentitiesFile>>) => T,
): Promise<{ result: T; file: Awaited<ReturnType<typeof loadIdentitiesFile>> }> {
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const result = mutate(file);
  await saveIdentitiesFile(cfg.identitiesJsonPath, file);
  return { result, file };
}

export interface CreateBody extends Omit<CreateIdentityInput, "configDir" | "directories"> {
  configDir?: string;
  directories?: string[];
  apiKey?: string;
}

export async function createIdentityInRegistry(toolName: string, body: CreateBody, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<RegistryDto> {
  const cfg = requireTool(toolName, configs);
  if (!body.configDir) throw new HttpError(400, "configDir is required");
  const expandedDir = expandPath(body.configDir);
  const { file } = await withRegistry(cfg, (file) =>
    createIdentity(file, {
      name: body.name,
      label: body.label,
      ...(body.description !== undefined ? { description: body.description } : {}),
      configDir: expandedDir,
      ...(body.directories?.length ? { directories: body.directories } : {}),
      ...(body.aliases?.length ? { aliases: body.aliases } : {}),
    }),
  );
  // Auth seeding is best-effort and AFTER the registry save: a failed key
  // write must not roll back or block the identity itself (the user can
  // retry via the auth endpoints).
  if (body.apiKey) {
    if (cfg.toolName === "zai") await writeZaiAuthFile(expandedDir, body.apiKey);
    else if (cfg.toolName === "ali") await writeAliAuthFile(expandedDir, body.apiKey);
  }
  return registryFor(cfg, configs);
}

export async function updateIdentityInRegistry(
  toolName: string,
  name: string,
  body: { label?: string; description?: string; configDir?: string },
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<RegistryDto> {
  const cfg = requireTool(toolName, configs);
  await withRegistry(cfg, (file) =>
    updateIdentity(file, name, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      description: body.description,
      ...(body.configDir !== undefined ? { configDir: expandPath(body.configDir) } : {}),
    }),
  );
  return registryFor(cfg, configs);
}

export async function deleteIdentityFromRegistry(toolName: string, name: string, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<RegistryDto> {
  const cfg = requireTool(toolName, configs);
  await withRegistry(cfg, (file) => deleteIdentity(file, name));
  return registryFor(cfg, configs);
}

export async function mutateDirectory(toolName: string, name: string, pattern: string, add: boolean, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<RegistryDto> {
  const cfg = requireTool(toolName, configs);
  await withRegistry(cfg, (file) => (add ? addDirectory(file, name, pattern) : removeDirectory(file, name, pattern)));
  return registryFor(cfg, configs);
}

export async function mutateAlias(toolName: string, name: string, alias: string, add: boolean, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<RegistryDto> {
  const cfg = requireTool(toolName, configs);
  await withRegistry(cfg, (file) => (add ? addAlias(file, name, alias) : removeAlias(file, name, alias)));
  return registryFor(cfg, configs);
}

async function registryFor(cfg: ToolConfig, configs: ToolConfig[]): Promise<RegistryDto> {
  const all = await listRegistries(configs);
  const found = all.registries.find((r) => r.toolName === cfg.toolName);
  if (!found) throw new HttpError(500, "registry vanished mid-mutation");
  return found;
}
