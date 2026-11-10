import type { ApiStyle } from "./types.ts";

/**
 * The tools the local gateway proxy (127.0.0.1:<port>/<tool>) serves today, with the gateway app whose token each uses.
 * A tool absent here has no local route: nothing may be pointed at `/<tool>` for it.
 */
export const LOCAL_GATEWAY_ROUTES: Record<string, { tool: "claude" | "codex"; app: string; style: ApiStyle }> = {
  claude: { tool: "claude", app: "agents-claude", style: "anthropic" },
  codex: { tool: "codex", app: "agents-codex", style: "openai" },
};
