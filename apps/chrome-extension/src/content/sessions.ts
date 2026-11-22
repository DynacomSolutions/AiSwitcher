// Pure bookkeeping for the sessions that show on one page. The overlay goes away only when the last session leaves.

export interface SessionTracker {
  /** Adds a session, or updates its colour and tag. */
  add(sessionId: string, colour: string, tag: string): void;
  /** Removes one session. Returns true when no session is left. */
  remove(sessionId: string): boolean;
  info(sessionId: string): { colour: string; tag: string } | undefined;
  size(): number;
  clear(): void;
}

export function createSessionTracker(): SessionTracker {
  const all = new Map<string, { colour: string; tag: string }>();
  return {
    add(id, colour, tag) { all.set(id, { colour, tag }); },
    remove(id) { all.delete(id); return all.size === 0; },
    info: id => all.get(id),
    size: () => all.size,
    clear() { all.clear(); },
  };
}
