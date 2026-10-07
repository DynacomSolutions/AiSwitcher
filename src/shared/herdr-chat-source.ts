import { Database } from "bun:sqlite";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export type HerdrChatTool = "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "opencode";
export interface HerdrAgentSession {
  agent: string;
  kind: "id" | "path";
  value: string;
}

const MAX_TAIL_BYTES = 512 * 1024;
const MAX_PROJECTS_BYTES = 256 * 1024;
const MAX_CANDIDATE_FILES = 4_096;
const MAX_CRUSH_PROJECTS = 128;
const CACHE_GUARD_MS = 1_500;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const ACKNOWLEDGEMENT = /^(?:yes|yep|yeah|ok|okay|sure|continue|go ahead|proceed|do it|sounds good|thanks|thank you|no|nope|right|correct|exactly)[.!?,\s]*$/i;
const SYNTHETIC = /^(?:<environment_context\b|<system\b|<instructions\b|\[system\b|system:\s|you are |current date:|working directory:|#\s+agents\.md instructions\b|#.*\binstructions\b)/i;
const titleCache = new Map<string, { checkedAt: number; stamp: string; title: string | null }>();
const sourceLocations = new Map<string, string>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const texts = value.flatMap((item) => {
    const obj = record(item);
    return obj && (obj.type === "text" || obj.type === "input_text") && typeof obj.text === "string" ? [obj.text] : [];
  });
  return texts.length ? texts.join("\n") : undefined;
}

function meaningful(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\u0000/g, "").trim();
  if (text.length < 4 || /^(?:untitled session|new session|\(no summary\))$/i.test(text) || ACKNOWLEDGEMENT.test(text) || SYNTHETIC.test(text)) return null;
  if (/^(?:<environment_context|<task>|<system-reminder|<instructions>|<task-notification|<command-|<bash-|<local-command-)/i.test(text)) return null;
  return text.slice(0, 240).replace(/\s+/g, " ");
}

async function tailLines(path: string): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    const size = Math.min(info.size, MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, info.size - size);
    const text = buffer.toString("utf8");
    return text.split("\n").filter(Boolean).slice(-4_096);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sourceStamp(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    let stamp = `${info.mtimeMs}:${info.size}`;
    if (path.endsWith(".db")) {
      try {
        const wal = await stat(`${path}-wal`);
        stamp += `:${wal.mtimeMs}:${wal.size}`;
      } catch { stamp += ":no-wal"; }
    }
    return stamp;
  } catch { return null; }
}

async function cachedTitle(key: string, path: string, read: () => Promise<string | null>): Promise<string | null> {
  const now = Date.now();
  const previous = titleCache.get(key);
  if (previous && now - previous.checkedAt < CACHE_GUARD_MS) return previous.title;
  const stamp = await sourceStamp(path);
  if (stamp === null) {
    titleCache.delete(key);
    sourceLocations.delete(key);
    return null;
  }
  if (previous?.stamp === stamp) {
    titleCache.set(key, { ...previous, checkedAt: now });
    return previous.title;
  }
  const title = await read();
  titleCache.set(key, { checkedAt: now, stamp, title });
  return title;
}

async function boundedJson(path: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return record(JSON.parse(buffer.toString("utf8")));
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

async function firstLine(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(line)); } catch { return undefined; }
}

function claudeHumanPrompt(row: Record<string, unknown>): string | null {
  if (row.type !== "user" || row.isMeta === true || row.isSidechain === true || row.promptSource === "system") return null;
  const origin = record(row.origin);
  if (origin && origin.kind !== "human") return null;
  return meaningful(contentText(record(row.message)?.content));
}

function claudeAiTitle(row: Record<string, unknown>): string | null {
  return row.type === "ai-title" && typeof row.aiTitle === "string" ? meaningful(row.aiTitle) : null;
}

function codexPrompt(row: Record<string, unknown>): string | null {
  const payload = record(row.payload);
  if (!payload) return null;
  if (row.type === "event_msg" && payload.type === "user_message") return meaningful(payload.message);
  if (row.type === "response_item" && payload.type === "message" && payload.role === "user") {
    const text = contentText(payload.content);
    return text?.startsWith("<environment_context") ? null : meaningful(text);
  }
  return null;
}

function grokPrompt(row: Record<string, unknown>): string | null {
  return row.type === "user" ? meaningful(contentText(row.content)) : null;
}

function kimiPrompt(row: Record<string, unknown>): string | null {
  if (row.type !== "turn.prompt") return null;
  const origin = record(row.origin);
  if (origin?.kind === "system_trigger") return null;
  return meaningful(contentText(row.input));
}

function crushText(parts: unknown): string | null {
  let parsed = parts;
  if (typeof parts === "string") {
    try { parsed = JSON.parse(parts); } catch { return null; }
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed.flatMap((part) => {
    const p = record(part);
    const data = record(p?.data);
    return p?.type === "text" && typeof data?.text === "string" ? [data.text] : [];
  }).join("\n");
  return meaningful(text);
}

async function lastJsonlPrompt(path: string, parser: (row: Record<string, unknown>) => string | null): Promise<string | null> {
  const lines = await tailLines(path);
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = parseLine(lines[i]!);
    const title = row && parser(row);
    if (title) return title;
  }
  return null;
}

async function firstJsonlPrompt(path: string, parser: (row: Record<string, unknown>) => string | null): Promise<string | null> {
  for (const line of await tailLines(path)) {
    const row = parseLine(line);
    const title = row && parser(row);
    if (title) return title;
  }
  return null;
}

async function directFile(value: string, tool?: HerdrChatTool, id?: string): Promise<string | null> {
  try {
    const info = await stat(value);
    if (info.isFile()) return value;
    if (info.isDirectory()) {
      const names = tool === "kimi" ? ["agents/main/wire.jsonl"] : tool === "grok" ? ["chat_history.jsonl"] : [basename(value) + ".jsonl"];
      for (const name of names) {
        try { if ((await stat(join(value, name))).isFile()) return join(value, name); } catch { /* try next exact candidate */ }
      }
    }
  } catch { /* invalid/stale pane path */ }
  return null;
}

function projectBucket(cwd: string): string {
  return encodeURIComponent(cwd);
}

async function findCodexRollout(configDir: string, id: string): Promise<string | null> {
  const root = join(configDir, "sessions");
  let years: string[];
  try { years = (await readdir(root)).filter((x) => /^\d{4}$/.test(x)).sort().reverse().slice(0, 3); } catch { return null; }
  let visited = 0;
  for (const year of years) {
    let months: string[];
    try { months = (await readdir(join(root, year))).sort().reverse(); } catch { continue; }
    for (const month of months) {
      let days: string[];
      try { days = (await readdir(join(root, year, month))).sort().reverse(); } catch { continue; }
      for (const day of days) {
        let names: string[];
        try { names = (await readdir(join(root, year, month, day))).sort().reverse(); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith(".jsonl") || !name.includes(id)) continue;
          if (++visited > MAX_CANDIDATE_FILES) return null;
          const path = join(root, year, month, day, name);
          const header = parseLine((await firstLine(path)) ?? "");
          const payload = record(header?.payload);
          if (header?.type === "session_meta" && (payload?.id === id || payload?.session_id === id)) return path;
        }
      }
    }
  }
  return null;
}

async function findKimiSession(configDir: string, id: string): Promise<string | null> {
  let text: string;
  try {
    const path = join(configDir, "session_index.jsonl");
    const info = await stat(path);
    if (info.size > MAX_INDEX_BYTES) return null;
    const fh = await open(path, "r");
    try {
      const size = Math.min(info.size, MAX_TAIL_BYTES);
      const buffer = Buffer.alloc(size);
      await fh.read(buffer, 0, size, info.size - size);
      text = buffer.toString("utf8");
    } finally { await fh.close(); }
  } catch { return null; }
  for (const line of text.split("\n")) {
    const row = parseLine(line);
    if (row?.sessionId === id && typeof row.sessionDir === "string") return row.sessionDir;
  }
  return null;
}

async function crushDatabase(configDir: string, tool: "zai" | "ali", id: string): Promise<string | null> {
  const projectsDoc = await boundedJson(join(configDir, "data", "projects.json"), MAX_PROJECTS_BYTES);
  const projects = Array.isArray(projectsDoc?.projects) ? projectsDoc.projects as { data_dir?: string }[] : [];
  const provider = tool === "zai" ? "zai" : "alibaba";
  for (const project of projects.slice(0, MAX_CRUSH_PROJECTS)) {
    if (typeof project.data_dir !== "string") continue;
    const dbPath = join(project.data_dir, "crush.db");
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, create: false });
      const rows = db.query("SELECT 1 FROM sessions WHERE id = ? AND (EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND provider = ?) OR NOT EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND provider IS NOT NULL)) LIMIT 1").all(id, provider);
      if (rows.length) return dbPath;
    } catch { /* another project db may own the exact id */ }
    finally { db?.close(); }
  }
  return null;
}

async function crushTitle(dbPath: string, tool: "zai" | "ali", id: string): Promise<string | null> {
  const provider = tool === "zai" ? "zai" : "alibaba";
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, create: false });
      const rows = db.query("SELECT title FROM sessions WHERE id = ? AND (EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND provider = ?) OR NOT EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id AND provider IS NOT NULL)) LIMIT 1").all(id, provider) as { title: string }[];
      if (!rows.length) return null;
    const messages = db.query("SELECT parts FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 64").all(id) as { parts: string }[];
    for (const message of messages) {
      const title = crushText(message.parts);
      if (title) return title;
    }
    return meaningful(rows[0]?.title);
  } catch { return null; }
  finally { db?.close(); }
}

async function openCodeTitle(configDir: string, id: string): Promise<string | null> {
  const candidates = [join(configDir, "data", "opencode", "opencode.db")];
  for (const path of candidates) {
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true, create: false });
      const rows = db.query("SELECT title FROM session WHERE id = ? LIMIT 1").all(id) as { title: string | null }[];
      const messages = db.query("SELECT id, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 64").all(id) as { id: string; data: string }[];
      for (const message of messages) {
        const parts = db.query("SELECT data FROM part WHERE message_id = ? AND session_id = ? AND json_extract(data, '$.type') = 'text' ORDER BY time_created").all(message.id, id) as { data: string }[];
        const title = meaningful(parts.map((part) => record(JSON.parse(part.data))?.text).filter((x): x is string => typeof x === "string").join("\n"));
        if (title) return title;
      }
      return meaningful(rows[0]?.title);
    } catch { /* database not present or older schema */ }
    finally { db?.close(); }
  }
  return null;
}

/** Read the newest meaningful user prompt (or a native title) for the exact Herdr pane session.
 * JSONL reads are capped at the final 512 KiB. ID lookup never substitutes a newest/cwd guess. */
export async function readHerdrChatTitle(
  tool: HerdrChatTool,
  configDir: string,
  cwd: string,
  session: HerdrAgentSession,
): Promise<string | null> {
  if (!session.value || (session.agent !== tool && !(session.agent === "crush" && (tool === "zai" || tool === "ali")))) return null;
  const cacheKey = `${tool}\0${configDir}\0${session.agent}\0${session.kind}\0${session.value}`;
  if (tool === "opencode" && session.kind === "id") {
    const path = join(configDir, "data", "opencode", "opencode.db");
    return cachedTitle(cacheKey, path, async () => { const title = await openCodeTitle(configDir, session.value); if (title) sourceLocations.set(cacheKey, path); return title; });
  }
  if ((tool === "zai" || tool === "ali") && session.kind === "id") {
    const path = sourceLocations.get(cacheKey) ?? await crushDatabase(configDir, tool, session.value);
    if (!path) return null;
    sourceLocations.set(cacheKey, path);
    return cachedTitle(cacheKey, path, () => crushTitle(path, tool, session.value));
  }
  let path: string | null = session.kind === "path" ? await directFile(session.value, tool, session.value) : null;
  if (!path && session.kind === "id") {
    if (tool === "claude") path = join(configDir, "projects", cwd.replaceAll("/", "-"), `${session.value}.jsonl`);
    if (tool === "codex") path = sourceLocations.get(cacheKey) ?? await findCodexRollout(configDir, session.value);
    if (tool === "grok") path = join(configDir, "sessions", projectBucket(cwd), session.value, "chat_history.jsonl");
    if (tool === "kimi") {
      path = sourceLocations.get(cacheKey) ?? null;
      if (!path) {
        const dir = await findKimiSession(configDir, session.value);
        if (dir) path = join(dir, "agents", "main", "wire.jsonl");
      }
    }
  }
  if (!path) return null;
  if (tool === "codex" || tool === "kimi") sourceLocations.set(cacheKey, path);
  const reader = async (): Promise<string | null> => {
  if (tool === "claude") return await lastJsonlPrompt(path!, claudeAiTitle) ?? firstJsonlPrompt(path!, claudeHumanPrompt);
  if (tool === "codex") return lastJsonlPrompt(path!, codexPrompt);
  if (tool === "grok") {
    const summaryPath = join(path!, "..", "summary.json");
    if (session.kind === "id") {
      try {
        const summary = await boundedJson(summaryPath, MAX_INDEX_BYTES);
        const native = meaningful(summary?.session_summary) ?? meaningful(summary?.generated_title);
        if (native) return await lastJsonlPrompt(path!, grokPrompt) ?? native;
      } catch { /* session may have no summary yet */ }
    }
    return lastJsonlPrompt(path!, grokPrompt);
  }
  if (tool === "kimi") {
    const statePath = join(path!, "..", "..", "..", "state.json");
    try {
      const state = await boundedJson(statePath, MAX_INDEX_BYTES);
      const native = state?.title === "New Session" ? null : meaningful(state?.title);
      if (native) return await lastJsonlPrompt(path!, kimiPrompt) ?? native;
    } catch { /* prompt can still be read */ }
    return lastJsonlPrompt(path!, kimiPrompt);
  }
  if (tool === "zai" || tool === "ali") {
    const line = await lastJsonlPrompt(path!, (row) => row.type === "user" ? crushText(row.parts) : null);
    return line;
  }
  return null;
  };
  return cachedTitle(cacheKey, path, reader);
}
