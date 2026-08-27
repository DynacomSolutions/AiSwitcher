import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadIdentitiesFile } from "../identities/store.ts";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../identities/tool-configs.ts";
import type { SyncScope } from "./types.ts";

const PROFILE_TOOL_CONFIGS = [CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, ZAI_CONFIG, ALI_CONFIG, PI_CONFIG, OPENCODE_CONFIG];
const PROFILE_COMMAND_FILES = ["hooks.json", "settings.json"];
const STANDARD_HOME_AT_START =
  /^(?:\/Users\/[^/\\\s"'`$;&|<>(){}\[\]]+|\/home\/[^/\\\s"'`$;&|<>(){}\[\]]+|\/root)(?=\/|[\\\s"'`$;&|<>(){}\[\]]|$)/;
const SYMBOLIC_HOME_PREFIXES = ["${HOME}", "$HOME", "~"];

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function homePrefixAt(
  text: string,
  index: number,
  home: string,
  includeSymbolicPrefixes = true,
): { length: number; canonicalHookRoot: boolean } | undefined {
  const rest = text.slice(index);
  const candidates = (includeSymbolicPrefixes ? [home, ...SYMBOLIC_HOME_PREFIXES] : [home]).sort(
    (a, b) => b.length - a.length,
  );
  for (const candidate of candidates) {
    if (!rest.startsWith(candidate)) continue;
    const boundary = rest[candidate.length];
    if (boundary !== undefined && boundary !== "/" && !/[\s"'`$;&|<>(){}\[\]]/.test(boundary)) continue;
    const hookSuffix = "/.claude/hooks";
    return {
      length: candidate.length + (rest.startsWith(candidate + hookSuffix) ? hookSuffix.length : 0),
      canonicalHookRoot: rest.startsWith(candidate + hookSuffix),
    };
  }

  const standard = rest.match(STANDARD_HOME_AT_START)?.[0];
  if (!standard) return undefined;
  const hookSuffix = "/.claude/hooks";
  return {
    length: standard.length + (rest.startsWith(standard + hookSuffix) ? hookSuffix.length : 0),
    canonicalHookRoot: rest.startsWith(standard + hookSuffix),
  };
}

function portablePathText(text: string, home: string): string {
  const match = homePrefixAt(text, 0, home);
  if (!match) return text;
  const replacement = "~" + (match.canonicalHookRoot ? "/.ais/hooks" : "");
  return replacement + text.slice(match.length);
}

/** Rewrites shell-visible home paths without embedding a machine username.
 * The old ~/.claude/hooks compatibility location is canonicalised to the
 * real shared hook tree at ~/.ais/hooks so remote hosts need no symlink. */
export function portableShellText(
  text: string,
  home: string = homedir(),
  includeSymbolicPrefixes = true,
): string {
  let result = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quote !== "'" && index + 1 < text.length) {
      result += char + text[++index]!;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = undefined;
      else if (!quote) quote = char;
      result += char;
      continue;
    }

    const match = homePrefixAt(text, index, home, includeSymbolicPrefixes);
    if (!match) {
      result += char;
      continue;
    }

    const replacement = "${HOME}" + (match.canonicalHookRoot ? "/.ais/hooks" : "");
    // A variable does not expand inside single quotes. Close the quote,
    // concatenate a double-quoted HOME expansion, then reopen it.
    result += quote === "'" ? "'\"" + replacement + "\"'" : replacement;
    index += match.length - 1;
  }
  return result;
}

function portableProfileValues(value: unknown, home: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const transformed = portableProfileValues(item, home);
      changed ||= transformed.changed;
      return transformed.value;
    });
    return { value: next, changed };
  }
  if (typeof value !== "object" || value === null) return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "command" && typeof item === "string") {
      const command = portableShellText(item, home);
      next[key] = command;
      changed ||= command !== item;
      continue;
    }
    if (key === "path" && typeof item === "string") {
      const path = portablePathText(item, home);
      next[key] = path;
      changed ||= path !== item;
      continue;
    }
    const transformed = portableProfileValues(item, home);
    next[key] = transformed.value;
    changed ||= transformed.changed;
  }
  return { value: next, changed };
}

export function portableProfileCommandConfig(value: unknown, home: string = homedir()): unknown {
  return portableProfileValues(value, home).value;
}

async function replaceFileAtomic(path: string, content: string): Promise<void> {
  const metadata = await stat(path);
  const temporary = path + ".ais-portable-" + process.pid + "-" + crypto.randomUUID();
  try {
    await writeFile(temporary, content, { mode: metadata.mode });
    await chmod(temporary, metadata.mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function makeJsonCommandsPortable(path: string, home: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const original = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    throw new Error(path + ": cannot make hook commands portable because the JSON is invalid", { cause: error });
  }
  const transformed = portableProfileValues(parsed, home);
  if (!transformed.changed) return false;
  await replaceFileAtomic(path, JSON.stringify(transformed.value, null, 2) + "\n");
  return true;
}

/** Makes direct per-identity hook/status commands and filesystem paths
 * portable before transport.
 * Plugin caches are intentionally not scanned; rsync excludes those trees. */
export async function makeProfileHookConfigsPortable(
  scope: SyncScope = { kind: "all" },
  home: string = homedir(),
): Promise<number> {
  const configs = scope.kind === "all" ? PROFILE_TOOL_CONFIGS : [scope.cfg];
  let changed = 0;
  for (const cfg of configs) {
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
    const identities =
      scope.kind === "identity" ? file.identities.filter((identity) => identity.name === scope.identityName) : file.identities;
    for (const identity of identities) {
      const configDir = expandHome(identity.configDir, home);
      for (const filename of PROFILE_COMMAND_FILES) {
        if (await makeJsonCommandsPortable(join(configDir, filename), home)) changed++;
      }
    }
  }
  return changed;
}

/** Shared hook scripts travel with a full-profile sync because every synced
 * hooks.json references them. Python and opaque files remain byte-identical. */
export async function makeSharedHookScriptsPortable(home: string = homedir()): Promise<number> {
  const hooksDir = join(home, ".ais", "hooks");
  const hooksDirectory = await stat(hooksDir).catch(() => undefined);
  if (!hooksDirectory?.isDirectory()) return 0;
  const glob = new Bun.Glob("*");
  let changed = 0;
  for await (const path of glob.scan({ cwd: hooksDir, absolute: true, onlyFiles: true })) {
    const original = await readFile(path, "utf8").catch(() => undefined);
    if (original === undefined || !/^#!.*\b(?:bash|sh|zsh|ksh)\b/.test(original.split("\n", 1)[0] ?? "")) continue;
    // Existing $HOME/${HOME}/~ shell syntax is already portable and may be
    // part of case patterns or parameter expansion. Only absolute home paths
    // are safe to rewrite across an opaque script.
    const portable = portableShellText(original, home, false);
    if (portable === original) continue;
    await replaceFileAtomic(path, portable);
    changed++;
  }
  return changed;
}
