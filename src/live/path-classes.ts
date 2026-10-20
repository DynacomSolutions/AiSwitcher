/** Portable paths in an AIS live-drive bundle are relative to the user's home. */
import pathRules from "./path-classes.json" with { type: "json" };

export type LivePathClass = "auth" | "logs" | "config:settings" | "config:plugins" | "config:identity" | "ssh" | "ignore";

const TOOL_ROOTS: readonly string[] = pathRules.toolRoots;
const AUTH_NAMES = new Set(pathRules.authNames);
const LOG_DIRS = pathRules.logDirectories;

function cleanPath(path: string): string | undefined {
  if (!path || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

/** Classifies only known profile roots and their registered-identity layouts. */
export function classify(path: string): LivePathClass {
  const normal = cleanPath(path);
  if (!normal) return "ignore";
  if (pathRules.protectedPaths.includes(normal)) return "ignore";
  if (normal === pathRules.sshRoot || normal.startsWith(`${pathRules.sshRoot}/`)) return "ssh";
  if (pathRules.identityRegistryPaths.includes(normal)) return "config:identity";
  const directConfigClass = pathRules.configPaths[normal as keyof typeof pathRules.configPaths] as LivePathClass | undefined;
  if (directConfigClass) return directConfigClass;
  if (pathRules.sharedLogDirectories.some((directory) => normal.startsWith(`${directory}/`))) return "logs";
  if (pathRules.sharedConfigDirectories.some((directory) => normal.startsWith(`${directory}/`))) return "config:settings";
  if (pathRules.authPaths.includes(normal)) return "auth";
  const rootConfigClass = pathRules.rootConfigPaths[normal as keyof typeof pathRules.rootConfigPaths] as LivePathClass | undefined;
  if (rootConfigClass) return rootConfigClass;

  const root = TOOL_ROOTS.find((candidate) => normal.startsWith(`${candidate}/`));
  if (!root) return "ignore";
  const relative = normal.slice(root.length + 1);
  const parts = relative.split("/");
  const identityRoot = parts[0] === "identities" && parts.length >= 3;
  const configDirRelative = identityRoot ? parts.slice(2) : parts;
  const leaf = parts.at(-1)!;

  if (AUTH_NAMES.has(leaf) && (identityRoot || parts.length <= 2)) return "auth";
  if (root === ".opencode" && (relative === "data/opencode/auth.json" || relative === "opencode/auth.json")) return "auth";
  if (root === ".kimi-code" && identityRoot && relative.endsWith("/credentials/kimi-code.json")) return "auth";
  if (root === ".zai" && leaf === "crush.json" && (identityRoot || parts.length <= 2)) return "auth";
  if (root === ".ali" && leaf === "console-cookie.txt" && (identityRoot || parts.length <= 2)) return "auth";

  if (identityRoot && leaf === "identities.json") return "config:identity";
  if (identityRoot && pathRules.identityConfigNames.includes(leaf)) return leaf === "identities.json" ? "config:identity" : "config:settings";
  if (identityRoot && (relative.includes("/plugins/") || relative.startsWith("plugins/"))) return "config:plugins";
  if (pathRules.pluginDirectories.some((directory) => (identityRoot && configDirRelative.includes(directory)) || relative.startsWith(`${directory}/`))) return "config:plugins";

  const sessionStart = configDirRelative.findIndex((part) => LOG_DIRS.includes(part));
  if (sessionStart >= 0 && (identityRoot || [".claude", ".codex", ".grok", ".kimi-code", ".pi"].includes(root))) {
    return "logs";
  }
  if (root === ".pi" && relative.startsWith("agent/sessions/")) return "logs";
  return "ignore";
}

export const LIVE_PATH_CLASSES = ["auth", "logs", "config:settings", "config:plugins", "config:identity", "ssh"] as const;
