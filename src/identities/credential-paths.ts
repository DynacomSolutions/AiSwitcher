import { join } from "node:path";
import type { ToolConfig } from "./types.ts";

/** Every on-disk file that constitutes "credentials" for a tool identity.
 * The single source of truth shared by the status probes, the login flow
 * manager's callback detection and retirement's credential purge, so they
 * can never drift. */
export function credentialPathsForTool(toolName: ToolConfig["toolName"], configDir: string): string[] {
  switch (toolName) {
    case "claude":
      return [join(configDir, ".credentials.json")];
    case "codex":
      return [join(configDir, "auth.json")];
    case "grok":
      return ["credentials.json", "auth.json", "auth.toml"].map((name) => join(configDir, name));
    case "kimi":
      return [join(configDir, "credentials", "kimi-code.json")];
    case "pi":
      return [join(configDir, "auth.json")];
    case "opencode":
      // XDG_DATA_HOME points at <configDir>/data (tool-configs.ts), and
      // opencode appends its own /opencode segment: auth.json lives under
      // data/opencode/.
      return [join(configDir, "data", "opencode", "auth.json"), join(configDir, "opencode", "auth.json")];
    default:
      // zai (crush.json provider key) and ali (console-cookie.txt) are
      // handled by their own probes; nothing else to watch.
      return [];
  }
}
