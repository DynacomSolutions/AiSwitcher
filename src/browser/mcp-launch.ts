/**
 * Session headers that `ais browser headers` sends to the gateway MCP endpoint (`src/gateway/browser/mcp.ts`).
 * Light imports only.
 */

export interface LaunchHeaderInput {
  /** Claude only: the transcript id of the session. Others get a session id from the gateway. */
  sessionId?: string | undefined;
  /** Readable session name. Sent percent-encoded, so any text is a valid header value. */
  label?: string | undefined;
  /** Stable chat id (T3 thread id): the same across context compaction. */
  chatId?: string | undefined;
  /** Pool name when the session runs in a swap pool. */
  pool?: string | undefined;
}

/** The session description sent with every request. The caller adds the bearer token. */
export function launchHeaders(i: LaunchHeaderInput): Record<string, string> {
  const h: Record<string, string> = {};
  if (i.sessionId) h["X-AIS-Session-Id"] = i.sessionId;
  if (i.label) h["X-AIS-Session-Label"] = encodeURIComponent(i.label.slice(0, 80));
  if (i.chatId) h["X-AIS-Chat-Id"] = i.chatId.slice(0, 128);
  if (i.pool) h["X-AIS-Pool"] = i.pool;
  return h;
}
