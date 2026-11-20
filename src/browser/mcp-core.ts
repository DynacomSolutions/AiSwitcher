// Parts of the browser MCP server that the stdio shim and the gateway endpoint share.
// Keep free of Node and Bun imports (no file system): the gateway loads this file.
import type { CallResult } from "./protocol.ts";

export const STOPPED_BY_USER_NOTE = "The user stopped browser control. Do not retry unless the user asks.";
export const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
export const LATEST_VERSION = "2025-06-18";

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export const errorResult = (text: string): { isError: true; content: McpContent[] } => ({ isError: true, content: [{ type: "text", text }] });

export function mapCallResult(result: CallResult): { isError?: true; content: McpContent[] } {
  if (result.ok) {
    return { content: result.content.map((c): McpContent => (c.type === "image" ? { type: "image", data: c.data, mimeType: c.mimeType } : { type: "text", text: c.text })) };
  }
  const note = result.error === "stopped_by_user" ? ` ${STOPPED_BY_USER_NOTE}` : "";
  return errorResult(`${result.error}: ${result.message}${note}`);
}

/** Server instructions sent in the initialize reply. Keep in step with docs/agents/browser.md, "When to close a tab". */
export const BROWSER_INSTRUCTIONS = "Tabs open in the user's own Chrome window, in this session's tab group. Do not call close_tab on a tab while a step in it waits for the user: a sign-in, 2FA, \"Verify that it's you\", a CAPTCHA, a consent or payment page, a manual review, or a question to the user about that page. Leave the tab open on the page the user must use. Before you ask the user to act, make sure the tab shows that page, and give the browser profile (profileLabel from list_browsers) and the tab title in the question. If you closed the tab by mistake, open it again on the correct page before you ask. Close a tab only when the work in it is finished and verified, and neither you nor the user needs it again. A move to a different step is not the end of the work in the tab. At the true end of the task, close the tabs this session opened.";
