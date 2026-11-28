/**
 * Metadata of a request body, read without keeping any content. Only block types and the `is_error` flag are looked at;
 * no prompt, tool input or tool result text leaves this function.
 */

/** Largest body scanned to count tool errors. A bigger body is not read (the count stays unknown). */
export const MAX_TOOL_ERROR_SCAN_BYTES = 16 * 1024 * 1024;

const MARKER = Buffer.from("is_error");
const MESSAGES_KEY = Buffer.from('"messages"');

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function ws(b: Uint8Array, from: number): number {
  let i = from;
  while (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09) i++;
  return i;
}

/** Index just after the string that opens at `from`, or -1. */
function skipString(b: Uint8Array, from: number): number {
  let j = from + 1;
  while (j < b.length) {
    const c = b[j];
    if (c === BACKSLASH) j += 2;
    else if (c === QUOTE) return j + 1;
    else j++;
  }
  return -1;
}

/** Index just after the JSON value that starts at `from` (string, object, array, number or literal), or -1. No allocation. */
function skipValue(b: Uint8Array, from: number): number {
  let i = ws(b, from);
  const c = b[i];
  if (c === QUOTE) return skipString(b, i);
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    while (i < b.length) {
      const d = b[i];
      if (d === QUOTE) {
        i = skipString(b, i);
        if (i < 0) return -1;
        continue;
      }
      if (d === 0x7b || d === 0x5b) depth++;
      else if (d === 0x7d || d === 0x5d) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }
  const start = i;
  while (i < b.length && b[i] !== 0x2c && b[i] !== 0x7d && b[i] !== 0x5d && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x09) i++;
  return i > start ? i : -1;
}

/**
 * The byte range of the last element of the top-level `messages` array (the last duplicate key wins, as in JSON.parse).
 * `null` when the body has no `messages` array, `[0, 0]` when the array is empty, `undefined` when the bytes are not an object.
 */
function lastMessageRange(b: Uint8Array): [number, number] | null | undefined {
  let i = ws(b, 0);
  if (b[i] !== 0x7b) return undefined;
  i++;
  let found: [number, number] | null = null;
  for (;;) {
    i = ws(b, i);
    if (b[i] === 0x7d) return found;
    if (b[i] !== QUOTE) return undefined;
    const keyEnd = skipString(b, i);
    if (keyEnd < 0) return undefined;
    const isMessages = keyEnd - i === MESSAGES_KEY.length && Buffer.from(b.buffer, b.byteOffset + i, keyEnd - i).equals(MESSAGES_KEY);
    i = ws(b, keyEnd);
    if (b[i] !== 0x3a) return undefined;
    i = ws(b, i + 1);
    if (isMessages && b[i] === 0x5b) {
      let range: [number, number] = [0, 0];
      let j = i + 1;
      for (;;) {
        j = ws(b, j);
        if (b[j] === 0x5d) {
          j++;
          break;
        }
        const end = skipValue(b, j);
        if (end < 0) return undefined;
        range = [j, end];
        j = ws(b, end);
        if (b[j] === 0x2c) j++;
        else if (b[j] !== 0x5d) return undefined;
      }
      found = range;
      i = j;
    } else {
      if (isMessages) found = null; // a later non-array `messages` replaces the array, as in JSON.parse
      const end = skipValue(b, i);
      if (end < 0) return undefined;
      i = end;
    }
    i = ws(b, i);
    if (b[i] === 0x2c) i++;
    else if (b[i] !== 0x7d) return undefined;
  }
}

/**
 * Number of `tool_result` blocks with `is_error: true` in the LAST message of an Anthropic Messages request: the results
 * the client just sent back for the tool calls of the previous answer. Older messages repeat on every turn, so counting
 * them would count each failure again on every later request.
 *
 * The scan walks the body bytes to the last element of `messages` without building objects, then parses only that
 * element, and only when it mentions `is_error`. A long session therefore costs a byte walk, never a parse of the whole
 * history. Returns 0 for a request without errors, and undefined when the body is not a JSON object, has no `messages`
 * array, or is too large.
 */
export function countToolErrors(bytes: Uint8Array): number | undefined {
  try {
    if (bytes.length === 0 || bytes.length > MAX_TOOL_ERROR_SCAN_BYTES) return undefined;
    const range = lastMessageRange(bytes);
    if (!range) return undefined;
    const [start, end] = range;
    if (end <= start) return 0;
    const slice = Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start);
    if (!slice.includes(MARKER)) return 0;
    const last: unknown = JSON.parse(slice.toString("utf8"));
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
