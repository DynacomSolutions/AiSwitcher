import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import type { Identity, IdentitiesFile, ToolConfig } from "./types.ts";
import { expandPath, isValidIdentityKey, parseDirectoryPattern } from "./match.ts";
import { saveIdentitiesFile } from "./store.ts";
import { PromptCancelledError, PromptTimeoutError, InvalidIdentitiesFileError, UnknownPoolError } from "./errors.ts";
import { writeZaiAuthFile } from "./zai-auth.ts";
import { ensureClaudeTranscriptRetention } from "./claude-settings.ts";
import { writeAliAuthFile } from "./ali-auth.ts";
import { activeIdentities } from "./retired.ts";
import { readLastIdentity, writeLastIdentity } from "./last-identity.ts";
import { performSwap } from "./claude-swap.ts";

// A plain string sentinel rather than a Symbol: identity names are validated
// elsewhere to be lowercase kebab-case only, so this can never collide with a
// real identity name, and it keeps clack's select() value type a plain
// string (a Symbol value forced awkward type-widening at the call site).
const CREATE_NEW = "__create_new_identity__";
const KIND_IDENTITY = "identity";
const KIND_POOL = "pool";

export interface PromptDeps {
  /** Makes `member` the active account of `pool` (manual reason). */
  switchMember: (pool: Identity, member: string) => Promise<unknown>;
  readLast: (toolName: string) => Promise<string | undefined>;
  writeLast: (toolName: string, name: string) => Promise<void>;
}

export function defaultPromptDeps(cfg: ToolConfig): PromptDeps {
  return {
    switchMember: (pool, member) =>
      performSwap({ registryPath: cfg.identitiesJsonPath, pool: pool.name, target: member, reason: "manual" }),
    readLast: (toolName) => readLastIdentity(toolName),
    writeLast: (toolName, name) => writeLastIdentity(toolName, name),
  };
}

function poolMembers(pool: Identity): string[] {
  return pool.swapPool?.accounts ?? [];
}

function labelOfName(active: Identity[], name: string | undefined): string {
  return active.find((i) => i.name === name)?.label ?? name ?? "none";
}

function memberAllowed(pool: Identity, member: string): boolean {
  return poolMembers(pool).includes(member) && !(pool.swapPool?.disallowed ?? []).includes(member);
}

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
  deps: PromptDeps = defaultPromptDeps(cfg),
  /** Open only this list (no chooser); undefined = normal chooser flow. */
  only?: "identity" | "pool",
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

    const active = activeIdentities(identitiesFile.identities);
    const pools = cfg.toolName === "claude" ? active.filter((i) => i.swapPool !== undefined) : [];
    const plain = active.filter((i) => i.swapPool === undefined);
    const remembered = await deps.readLast(cfg.toolName).catch(() => undefined);
    const rememberedPool = remembered !== undefined ? pools.find((p) => p.name === remembered) : undefined;
    const rememberedIdentity =
      remembered !== undefined && plain.some((i) => i.name === remembered) ? remembered : undefined;
    if (only === "pool" && pools.length === 0) {
      throw new UnknownPoolError("(any)", []);
    }
    const showChooser = pools.length > 0 && only === undefined;

    // Pool-member accounts keep their own identity row; they only gain a tag.
    const tagFor = (name: string): string => {
      const tags = pools
        .filter((p) => poolMembers(p).includes(name))
        .map((p) => `[pool: ${p.name}${memberAllowed(p, name) ? "" : " (not allowed)"}]`);
      return tags.length > 0 ? ` ${styleText("cyan", tags.join(" "))}` : "";
    };

    const cancelled = (): Error =>
      timedOut ? new PromptTimeoutError(cfg.toolName, timeoutMs) : new PromptCancelledError(cfg.toolName);

    for (;;) {
      let kind: string = only ?? KIND_IDENTITY;
      if (showChooser) {
        const picked = await clack.select({
          message: "Select an identity or pool",
          options: [
            { value: KIND_IDENTITY, label: "Identity" },
            { value: KIND_POOL, label: "Pool" },
          ],
          initialValue: rememberedPool ? KIND_POOL : KIND_IDENTITY,
          signal: controller.signal,
        });
        if (clack.isCancel(picked)) throw cancelled();
        kind = picked as string;
      }

      if (kind === KIND_POOL) {
        const picked = await clack.select({
          message: "Select a pool",
          options: pools.map((pool) => ({
            value: pool.name,
            label: pool.label,
            hint: `${poolMembers(pool).length} accounts, active: ${labelOfName(active, pool.swapPool?.active)}`,
          })),
          initialValue: rememberedPool?.name ?? pools[0]!.name,
          signal: controller.signal,
        });
        if (clack.isCancel(picked)) {
          if (timedOut || !showChooser) throw cancelled();
          continue;
        }
        const pool = pools.find((p) => p.name === picked);
        if (!pool) throw new InvalidIdentitiesFileError(`selected pool "${String(picked)}" vanished`);
        await deps.writeLast(cfg.toolName, pool.name).catch(() => undefined);
        clack.outro(`Using identity "${pool.name}"`);
        return { identity: pool, created: false };
      }

      const choice = await clack.select({
        message: "Select an identity",
        options: [
          ...plain.map((identity) => ({
            value: identity.name,
            label: `${identity.label}${tagFor(identity.name)}`,
            hint: identity.description,
          })),
          { value: CREATE_NEW, label: "+ Create new identity" },
        ],
        initialValue: rememberedIdentity ?? plain[0]?.name ?? CREATE_NEW,
        signal: controller.signal,
      });

      if (clack.isCancel(choice)) {
        if (showChooser && !timedOut) continue;
        throw cancelled();
      }

      if (choice === CREATE_NEW) {
        const created = await createIdentityFlow(
          identitiesFile,
          cfg,
          controller.signal,
          () => timedOut,
          timeoutMs,
        );
        await deps.writeLast(cfg.toolName, created.name).catch(() => undefined);
        clack.outro(`Created identity "${created.name}"`);
        return { identity: created, created: true };
      }

      const identity = plain.find((i) => i.name === choice);
      if (!identity) {
        // Shouldn't happen — choice came from the options list above.
        throw new InvalidIdentitiesFileError(`selected identity "${String(choice)}" vanished`);
      }
      await deps.writeLast(cfg.toolName, identity.name).catch(() => undefined);
      clack.outro(`Using identity "${identity.name}"`);
      return { identity, created: false };
    }
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
  // Retired identities still count: unretiring must never collide.
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
  if (cfg.toolName === "claude") await ensureClaudeTranscriptRetention(configDir);

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
