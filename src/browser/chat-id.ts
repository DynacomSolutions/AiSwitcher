import { createHash } from "node:crypto";

const FITS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The stable id of the chat this process runs in, or undefined. It must stay the same when the agent compacts its context and gets a new session id.
 * Only the T3 Code thread id qualifies. The Claude and Codex session ids change on compaction, so no other source is used.
 * An id that fits the gateway form is sent as it is. Any other non-empty id (a delegated child thread id is long and holds `%`) is sent as a stable digest.
 */
export function stableChatId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.T3CODE_THREAD_ID?.trim();
  if (!id) return undefined;
  if (FITS.test(id)) return id;
  return `t3h:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}
