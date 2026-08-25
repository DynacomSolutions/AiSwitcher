import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import type { Identity, IdentitiesFile, ToolConfig } from "./types.ts";
import { expandPath, isValidIdentityKey, parseDirectoryPattern } from "./match.ts";
import { saveIdentitiesFile } from "./store.ts";
import { PromptCancelledError, PromptTimeoutError, InvalidIdentitiesFileError } from "./errors.ts";
import { writeZaiAuthFile } from "./zai-auth.ts";
import { writeAliAuthFile } from "./ali-auth.ts";

// A plain string sentinel rather than a Symbol: identity names are validated
// elsewhere to be lowercase kebab-case only, so this can never collide with a
// real identity name, and it keeps clack's select() value type a plain
// string (a Symbol value forced awkward type-widening at the call site).
const CREATE_NEW = "__create_new_identity__";

export interface PromptResult {
  identity: Identity;
  created: boolean;
}

/**
 * Interactive picker + create-new-identity flow, wrapped in a single 60s
 * AbortSignal timeout covering the *whole* session (picker plus every
 * create-flow sub-question share one clock, not reset per question).
 */
export async function promptForIdentity(
  identitiesFile: IdentitiesFile,
  cfg: ToolConfig,
  timeoutMs: number,
): Promise<PromptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Don't let this timer keep the process alive on its own.
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    clack.intro(`${cfg.toolName}: no identity resolved from flag, env, or cwd`);

    const choice = await clack.select({
      message: "Select an identity to use",
      options: [
        ...identitiesFile.identities.map((identity) => ({
          value: identity.name,
          label: identity.label,
          hint: identity.description,
        })),
        { value: CREATE_NEW, label: "+ Create new identity" },
      ],
      signal: controller.signal,
    });

    if (clack.isCancel(choice)) {
      throw timedOut
        ? new PromptTimeoutError(cfg.toolName, timeoutMs)
        : new PromptCancelledError(cfg.toolName);
    }

    if (choice === CREATE_NEW) {
      const created = await createIdentityFlow(
        identitiesFile,
        cfg,
        controller.signal,
        () => timedOut,
        timeoutMs,
      );
      clack.outro(`Created identity "${created.name}"`);
      return { identity: created, created: true };
    }

    const identity = identitiesFile.identities.find((i) => i.name === choice);
    if (!identity) {
      // Shouldn't happen — choice came from the options list above.
      throw new InvalidIdentitiesFileError(`selected identity "${String(choice)}" vanished`);
    }
    clack.outro(`Using identity "${identity.name}"`);
    return { identity, created: false };
  } finally {
    clearTimeout(timer);
  }
}

async function createIdentityFlow(
  identitiesFile: IdentitiesFile,
  cfg: ToolConfig,
  signal: AbortSignal,
  timedOut: () => boolean,
  timeoutMs: number,
): Promise<Identity> {
  // Names and aliases share one namespace, so both must be checked together.
  const existingKeys = new Set(
    identitiesFile.identities.flatMap((i) => [i.name, ...(i.aliases ?? [])]),
  );

  const name = await clack.text({
    message: "Identity name (kebab-case, e.g. identity-a)",
    validate: (value) => {
      if (!value) return "Name is required";
      if (!isValidIdentityKey(value)) {
        return "Use lowercase letters, digits, and single hyphens only (e.g. identity-a)";
      }
      if (existingKeys.has(value)) return `"${value}" is already an identity name or alias`;
      return undefined;
    },
    signal,
  });
  assertNotCancelled(name, cfg, timedOut, timeoutMs);

  const label = await clack.text({
    message: "Display label",
    initialValue: name as string,
    signal,
  });
  assertNotCancelled(label, cfg, timedOut, timeoutMs);

  const description = await clack.text({
    message: "Description (optional)",
    signal,
  });
  assertNotCancelled(description, cfg, timedOut, timeoutMs);

  const directoriesRaw = await clack.text({
    message: "Directories to auto-match on cwd (optional, comma-separated, end with /* for recursive)",
    signal,
  });
  assertNotCancelled(directoriesRaw, cfg, timedOut, timeoutMs);

  const directories = String(directoriesRaw || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  for (const pattern of directories) {
    // Reuses the exact same grammar validation identities.json itself is
    // held to, so an interactively-entered pattern can never drift from
    // what a manually-edited identities.json would accept.
    parseDirectoryPattern(pattern, `new identity "${name}"`);
  }

  const aliasesRaw = await clack.text({
    message: "Aliases (optional, comma-separated, e.g. wk)",
    validate: (value) => {
      if (!value) return undefined;
      for (const alias of value.split(",").map((a) => a.trim()).filter(Boolean)) {
        if (existingKeys.has(alias)) return `"${alias}" is already an identity name or alias`;
      }
      return undefined;
    },
    signal,
  });
  assertNotCancelled(aliasesRaw, cfg, timedOut, timeoutMs);

  const aliases = String(aliasesRaw || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  // Neither zai nor ali has a real login flow of its own to fall back on the
  // way the other four tools do; see cli/identities/create.ts's identical
  // prompt and identities/zai-auth.ts / identities/ali-auth.ts for what this
  // closes (no interactive `crush login` ever needed once this is written).
  let apiKey: string | undefined;
  if (cfg.toolName === "zai" || cfg.toolName === "ali") {
    const apiKeyRaw = await clack.text({
      message:
        cfg.toolName === "zai"
          ? "Z.ai API key (optional, leave blank to configure Crush manually later)"
          : "Alibaba Cloud Model Studio API key (optional, leave blank to configure Crush manually later)",
      signal,
    });
    assertNotCancelled(apiKeyRaw, cfg, timedOut, timeoutMs);
    apiKey = apiKeyRaw || undefined;
  }

  const configDir = join(cfg.identitiesRootDir, name as string);
  await mkdir(expandPath(configDir), { recursive: true });
  if (apiKey) {
    if (cfg.toolName === "zai") await writeZaiAuthFile(configDir, apiKey);
    else if (cfg.toolName === "ali") await writeAliAuthFile(configDir, apiKey);
  }

  const identity: Identity = {
    name: name as string,
    label: (label as string) || (name as string),
    ...(description ? { description: description as string } : {}),
    configDir,
    ...(directories.length ? { directories } : {}),
    ...(aliases.length ? { aliases } : {}),
  };

  identitiesFile.identities.push(identity);
  await saveIdentitiesFile(cfg.identitiesJsonPath, identitiesFile);

  return identity;
}

function assertNotCancelled(
  value: unknown,
  cfg: ToolConfig,
  timedOut: () => boolean,
  timeoutMs: number,
): asserts value is string {
  if (clack.isCancel(value)) {
    throw timedOut()
      ? new PromptTimeoutError(cfg.toolName, timeoutMs)
      : new PromptCancelledError(cfg.toolName);
  }
}
