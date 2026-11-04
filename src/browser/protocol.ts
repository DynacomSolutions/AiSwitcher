// Shared with the Chrome extension: keep free of Node and Bun imports.
import type { BrowserTarget } from "./types.ts";

export const BROWSER_TOOLS = ["list_browsers", "tabs_context", "tabs_create", "adopt_tab", "navigate", "screenshot", "read_page", "find", "click", "type", "key", "scroll", "hover", "form_input", "javascript", "get_console", "get_network", "wait", "upload_file", "resize", "close_tab"] as const;
export type BrowserTool = (typeof BROWSER_TOOLS)[number];

export type BrowserErrorCode = "paused_by_user" | "stopped_by_user" | "no_browser" | "ambiguous_browser" | "forbidden_tab" | "tab_closed" | "timeout" | "browser_disconnected" | "bad_args" | "internal";

export interface CallRequest {
  id: string;
  session: { id: string; identity: string; label: string };
  tool: BrowserTool;
  args: Record<string, unknown>;
}

export type CallResult =
  | { id: string; ok: true; content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: "image/jpeg" | "image/png"; data: string }> }
  | { id: string; ok: false; error: BrowserErrorCode; message: string };

export type ExtToGateway = { t: "hello"; token: string; version: string } | { t: "ping" } | { t: "result"; result: CallResult } | { t: "state"; paused: boolean };

export type GatewayToExt = { t: "welcome"; binding: string; target: BrowserTarget } | { t: "pong" } | { t: "call"; req: CallRequest } | { t: "abort"; id: string };

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const WAIT_CALL_TIMEOUT_MS = 120_000;
