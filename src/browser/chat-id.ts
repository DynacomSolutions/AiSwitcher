/**
 * The stable id of the chat this process runs in, or undefined. It must stay the same when the agent compacts its context and gets a new session id.
 * Only the T3 Code thread id qualifies. The Claude and Codex session ids change on compaction, so no other source is used.
 */
export function stableChatId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.T3CODE_THREAD_ID?.trim();
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : undefined;
}
