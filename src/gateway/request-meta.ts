/**
 * Metadata of a request body, read without keeping any content. Only block types and the `is_error` flag are looked at;
 * no prompt, tool input or tool result text leaves this function.
 */

/** Largest body parsed to count tool errors. A bigger body is not read (the count stays unknown). */
export const MAX_TOOL_ERROR_SCAN_BYTES = 16 * 1024 * 1024;

const MARKER = Buffer.from("is_error");

/**
 * Number of `tool_result` blocks with `is_error: true` in the LAST message of an Anthropic Messages request: the results
 * the client just sent back for the tool calls of the previous answer. Older messages repeat on every turn, so counting
 * them would count each failure again on every later request.
 *
 * The body is parsed only when its bytes mention `is_error` at all, which most requests never do. Returns 0 for a body
 * without errors, and undefined when the body is not a JSON object, too large, or has no `messages` array.
 */
export function countToolErrors(bytes: Uint8Array): number | undefined {
  try {
    if (bytes.length === 0 || bytes.length > MAX_TOOL_ERROR_SCAN_BYTES) return undefined;
    if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(MARKER)) return hasMessages(bytes) ? 0 : undefined;
    const root: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof root !== "object" || root === null || Array.isArray(root)) return undefined;
    const messages = (root as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return undefined;
    const last: unknown = messages[messages.length - 1];
    const content = typeof last === "object" && last !== null ? (last as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const block of content) {
      if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result" && (block as { is_error?: unknown }).is_error === true) n += 1;
    }
    return n;
  } catch {
    return undefined;
  }
}

const MESSAGES_KEY = Buffer.from('"messages"');

/** True when the bytes name a `messages` key: a cheap check that the body is a Messages request without parsing it. */
function hasMessages(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(MESSAGES_KEY);
}
