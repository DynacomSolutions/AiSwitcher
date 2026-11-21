/**
 * The client's own session id, read from a gateway request, so the ledger can show which accounts one session used.
 * The id is whatever the tool already keeps for its session, so a console can match it to a running agent:
 *   - Claude Code sends `x-claude-code-session-id`, and the same id as `session_id` inside `metadata.user_id` of the body
 *     (a JSON string in current versions, a `..._session_<id>` suffix in older ones). The transcript file is named for it.
 *   - Codex sends `session-id` (also `thread-id`). The rollout file name ends with it.
 * Nothing here is a secret: the id names a conversation, never a login. Values are shape-checked and length-bound before
 * they reach the ledger.
 */

const SESSION_HEADERS = ["x-claude-code-session-id", "session-id", "session_id", "x-session-id"] as const;
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
/** How much of the end of a buffered body is searched for `metadata.user_id` (Claude Code puts `metadata` last). */
export const BODY_TAIL_BYTES = 4096;
const BODY_PATTERNS = [/\\?"session_id\\?"\s*:\s*\\?"([A-Za-z0-9][A-Za-z0-9._:-]{7,127})\\?"/, /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/];

/** A header value that looks like a session id, or undefined. */
export function sessionKeyFromHeaders(headers: Pick<Headers, "get">): string | undefined {
  for (const name of SESSION_HEADERS) {
    const v = headers.get(name)?.trim();
    if (v && SHAPE.test(v)) return v;
  }
  return undefined;
}

/** The session id in the end of a buffered request body (Claude Code `metadata.user_id`), or undefined. Cheap: only the last bytes are decoded. */
export function sessionKeyFromBodyTail(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - BODY_TAIL_BYTES)));
  for (const re of BODY_PATTERNS) {
    const m = re.exec(tail);
    if (m?.[1] && SHAPE.test(m[1])) return m[1];
  }
  return undefined;
}

/** The tool family in a user agent, for example `claude-cli` from `claude-cli/2.1.321 (...)`, lower case, or undefined. */
export function clientFamily(userAgent: string | null | undefined): string | undefined {
  const m = /^\s*([A-Za-z][A-Za-z0-9._-]{0,39})/.exec(userAgent ?? "");
  return m ? m[1]!.toLowerCase() : undefined;
}
