import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { expandPath, isValidIdentityKey } from "../../identities/match.ts";
import { writeZaiAuthFile } from "../../identities/zai-auth.ts";
import { writeAliAuthFile } from "../../identities/ali-auth.ts";
import type { ParsedArgs } from "../args.ts";
import { listFlag, stringFlag } from "../args.ts";
import { bold, green } from "../colors.ts";
import { createIdentity } from "./actions.ts";
import { loadOne, persist, requireToolConfigFromFlag } from "./resolve-tool.ts";

function exitOnCancel(value: unknown): asserts value is string {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
}

async function promptText(
  message: string,
  opts?: { initialValue?: string; validate?: (value: string | undefined) => string | undefined },
): Promise<string> {
  const result = await clack.text({ message, ...opts });
  exitOnCancel(result);
  return result;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Each field falls back to its own interactive clack prompt independently
 * when its flag was omitted — an explicit but empty flag value (e.g.
 * "--description=") still counts as "supplied" and skips that field's
 * prompt, same as everywhere else in this CLI. This mirrors
 * identities/prompt.ts's createIdentityFlow one-for-one (same questions,
 * same order) but without its AbortController/60s-timeout machinery, which
 * exists specifically to bound the "no identity resolved, fall back to a
 * picker" path and has no equivalent need here — this is a deliberate,
 * single `ais identities create` invocation, not a fallback.
 */
export async function runCreate(flags: ParsedArgs["flags"]): Promise<void> {
  const cfg = requireToolConfigFromFlag(flags);

  const nameFlag = stringFlag(flags, "name");
  const labelFlag = stringFlag(flags, "label");
  const descriptionFlag = stringFlag(flags, "description");
  const directoriesFlag = listFlag(flags, "directories");
  const aliasesFlag = listFlag(flags, "aliases");
  const apiKeyFlag = stringFlag(flags, "api-key");
  // zai and ali both proxy `crush` and both need this same non-interactive
  // API-key writer (see identities/zai-auth.ts / identities/ali-auth.ts):
  // neither has a real login flow of its own to fall back on the way
  // claude/codex/grok/kimi do.
  const isZai = cfg.toolName === "zai";
  const isAli = cfg.toolName === "ali";
  const needsApiKey = isZai || isAli;

  const willPrompt = [nameFlag, labelFlag, descriptionFlag, directoriesFlag, aliasesFlag].some(
    (v) => v === undefined,
  ) || (needsApiKey && apiKeyFlag === undefined);
  if (willPrompt) clack.intro("Create a new identity");

  const name =
    nameFlag ??
    (await promptText("Identity name (kebab-case, e.g. identity-a)", {
      validate: (value) => {
        if (!value) return "Name is required";
        if (!isValidIdentityKey(value)) {
          return "Use lowercase letters, digits, and single hyphens only (e.g. identity-a)";
        }
        return undefined;
      },
    }));

  const label = labelFlag ?? (await promptText("Display label", { initialValue: name }));
  const description = descriptionFlag ?? (await promptText("Description (optional)"));
  const directories =
    directoriesFlag ??
    splitList(
      await promptText("Directories to auto-match on cwd (optional, comma-separated, end with /* for recursive)"),
    );
  const aliases = aliasesFlag ?? splitList(await promptText("Aliases (optional, comma-separated, e.g. wk)"));

  // Neither zai nor ali has a real login flow of its own to fall back on the
  // way the other four tools do; their real binary (crush) needs this key
  // written into its own config before it can do anything, so it's worth
  // asking for even though it's still optional (blank means "set it up
  // manually later", see identities/zai-auth.ts / identities/ali-auth.ts
  // for what this closes: no interactive `crush login` is ever needed once
  // this is written).
  const apiKey = needsApiKey
    ? (apiKeyFlag ??
        (await promptText(
          isZai
            ? "Z.ai API key (optional, leave blank to configure Crush manually later)"
            : "Alibaba Cloud Model Studio API key (optional, leave blank to configure Crush manually later)",
        )))
    : undefined;

  if (willPrompt) clack.outro(`Ready to create "${name}".`);

  const configDir = join(cfg.identitiesRootDir, name);
  const loaded = await loadOne(cfg);
  const identity = createIdentity(loaded.file, {
    name,
    label,
    ...(description ? { description } : {}),
    configDir,
    ...(directories.length ? { directories } : {}),
    ...(aliases.length ? { aliases } : {}),
  });

  await mkdir(expandPath(configDir), { recursive: true });
  if (apiKey) {
    if (isZai) await writeZaiAuthFile(configDir, apiKey);
    else if (isAli) await writeAliAuthFile(configDir, apiKey);
  }
  await persist(loaded);

  console.log(
    `${green("✔")} Created identity ${bold(identity.name)} in ${cfg.toolName}'s registry (configDir: ${configDir}).`,
  );
}
