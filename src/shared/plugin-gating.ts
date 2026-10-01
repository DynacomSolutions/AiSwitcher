import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A Claude Code plugin that is only enabled when the launch directory looks
 * like a project that uses it. Add entries here to gate further plugins. */
export interface PluginGate {
  /** Plugin id as it appears in `enabledPlugins` (`name@marketplace`). */
  pluginId: string;
  /** Paths, relative to a directory, whose presence marks a project. */
  markers: readonly string[];
}

export const PLUGIN_GATES: readonly PluginGate[] = [
  {
    pluginId: "vercel@claude-plugins-official",
    markers: ["vercel.json", "vercel.ts", join(".vercel", "project.json")],
  },
];

/** Directories from `cwd` upwards, stopping after the git root (the first
 * directory containing `.git`). With no git root, only `cwd` is checked so
 * an unrelated parent such as the home directory can never match. */
export function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return [resolve(cwd)];
    dir = parent;
  }
}

export function hasMarker(cwd: string, markers: readonly string[]): boolean {
  return projectDirs(cwd).some((dir) => markers.some((m) => existsSync(join(dir, m))));
}

export function detectGatedPlugins(cwd: string, gates: readonly PluginGate[] = PLUGIN_GATES): string[] {
  return gates.filter((g) => hasMarker(cwd, g.markers)).map((g) => g.pluginId);
}

function readSettingsValue(value: string): Record<string, unknown> | undefined {
  try {
    const text = value.trimStart().startsWith("{")
      ? value
      : statSync(value).isFile() ? readFileSync(value, "utf8") : undefined;
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function withEnabled(base: Record<string, unknown>, pluginIds: readonly string[]): string {
  const existing = base.enabledPlugins;
  const plugins: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  // An explicit user choice in their own --settings always wins.
  for (const id of pluginIds) if (!(id in plugins)) plugins[id] = true;
  return JSON.stringify({ ...base, enabledPlugins: plugins });
}

/** Returns argv with a `--settings` overlay enabling `pluginIds`. A
 * user-supplied `--settings` (file or JSON, either `--settings X` or
 * `--settings=X`) is merged into rather than duplicated; if it cannot be
 * read the argv is returned unchanged so the user's intent is never clobbered. */
export function composeSettingsArgs(argv: readonly string[], pluginIds: readonly string[]): string[] {
  if (pluginIds.length === 0) return [...argv];
  const out = [...argv];
  const stop = out.indexOf("--");
  const limit = stop === -1 ? out.length : stop;
  for (let i = 0; i < limit; i++) {
    const arg = out[i]!;
    if (arg === "--settings" && i + 1 < limit) {
      const base = readSettingsValue(out[i + 1]!);
      if (!base) return [...argv];
      out[i + 1] = withEnabled(base, pluginIds);
      return out;
    }
    if (arg.startsWith("--settings=")) {
      const base = readSettingsValue(arg.slice("--settings=".length));
      if (!base) return [...argv];
      out[i] = `--settings=${withEnabled(base, pluginIds)}`;
      return out;
    }
  }
  const overlay = withEnabled({}, pluginIds);
  return stop === -1 ? [...out, "--settings", overlay] : [...out.slice(0, stop), "--settings", overlay, ...out.slice(stop)];
}

/** Claude only: enable each gated plugin whose project marker is present. */
export function gatePluginArgs(toolName: string, argv: readonly string[], cwd: string): string[] {
  if (toolName !== "claude") return [...argv];
  return composeSettingsArgs(argv, detectGatedPlugins(cwd));
}
