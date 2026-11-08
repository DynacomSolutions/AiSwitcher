/** Random UUIDs keep 6 chars; human-chosen ids show up to 12. */
export function shortSessionId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 6) : id.slice(0, 12);
}

/**
 * The name an agent session shows in its tab group and on the page pill: the chat/session name the
 * launcher passes in AIS_SESSION_NAME, else the short session id. Never the identity.
 */
export function sessionName(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.AIS_SESSION_NAME ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return name || shortSessionId(id);
}
