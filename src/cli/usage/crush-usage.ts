import { Database } from "bun:sqlite";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { estimateModelTokenCost } from "../../identities/model-pricing.ts";
import type { Identity } from "../../identities/types.ts";
import type { DateSpan, TokscaleReport } from "./tokscale.ts";

/**
 * Shared reader behind both usage/zai-usage.ts and usage/ali-usage.ts,
 * extracted once both tools turned out to need the identical Crush-local
 * SQLite aggregation (see zai-usage.ts's own history for how this was
 * discovered: "Z.ai's API has no token/cost history" had wrongly been
 * allowed to stand in for "zai has no local logs either", when Crush itself
 * tracks real per-session token/cost data locally regardless of which
 * provider it's pointed at). `dataSubdir` is the identity's own
 * CRUSH_GLOBAL_DATA subdir (both zai's and ali's ToolConfig use "data",
 * see identities/tool-configs.ts), parameterized rather than hardcoded so
 * a future crush-backed tool with a different layout doesn't need its own
 * copy of this SQL.
 *
 * `providerId` filters sessions to only those whose messages belong to the
 * given provider (e.g. "zai" or "alibaba"). This is load-bearing: multiple
 * crush-backed identities can share the same project-local `.crush/crush.db`
 * (e.g. zai and ali both ran in ~/Projects/AiProfileSwitcher), and without
 * this filter each identity would count the other's sessions, inflating
 * totals. Confirmed live: no session ever mixes providers (each session's
 * messages all carry the same `provider` value), so a JOIN on messages is
 * safe and precise.
 *
 * Aggregates EVERY project directory the identity's own `projects.json` has
 * ever recorded, matching how tokscale itself reports a claude/codex/grok/
 * kimi identity's ENTIRE local history, not just the current directory's
 * slice (contrast resume/crush-resume.ts, which scopes to the current cwd:
 * "resume a session here" means something different from "how much have I
 * used, ever").
 */
interface ProjectsJson {
  projects?: Array<{ path?: string; data_dir?: string }>;
}

interface SessionUsageRow {
  messages: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  model: string | null;
  /** UNIX seconds (crush.db's own units, see resume/crush-resume.ts). */
  created_at: number;
  updated_at: number;
}

/** Pre-checks the database path with ASYNC stat before any synchronous
 * bun:sqlite work. A sync open into a hung network mount (observed live
 * with /home/Projects on SeaweedFS) freezes Bun's single event loop and
 * takes the whole console API down; a hanging AWAIT only stalls this one
 * caller on a threadpool thread while every other request keeps flowing.
 * Returns false when the file is missing or unreadable right now. */
export async function crushDbReachable(dbPath: string): Promise<boolean> {
  // The stat itself is raced against a short deadline: an await on a hung
  // network mount never settles, and since the caller proceeds to
  // SYNCHRONOUS sqlite work only on true, a pending stat must count as
  // "unreachable" rather than waiting forever.
  const probe = stat(dbPath)
    .then((info) => info.isFile())
    .catch(() => false);
  return await Promise.race([probe, Bun.sleep(3_000).then(() => false)]);
}

async function sessionsInDb(dbPath: string, providerId: "zai" | "alibaba"): Promise<SessionUsageRow[]> {
  if (!(await crushDbReachable(dbPath))) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT s.message_count AS messages, s.prompt_tokens, s.completion_tokens, s.cost, s.created_at, s.updated_at, " +
          "(SELECT m.model FROM messages m WHERE m.session_id = s.id AND m.provider = $provider AND m.model IS NOT NULL " +
          "ORDER BY m.updated_at DESC, m.rowid DESC LIMIT 1) AS model " +
          "FROM sessions s WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.provider = $provider)",
      )
      .all({ $provider: providerId }) as SessionUsageRow[];
  } finally {
    db.close();
  }
}

/**
 * Aggregates real local token/cost usage for one crush-backed identity
 * (zai or ali) across every project Crush has ever recorded for it. Returns
 * `undefined` when there's simply nothing yet (no `projects.json`, or every
 * registered project has no `crush.db`, the identity has never actually
 * run a session) rather than an error, the same "not used yet" convention
 * every other reader uses. A `crush.db` that exists but fails to open/query
 * is skipped, not fatal to the whole aggregate, so one bad project
 * directory can't hide every other one's real totals.
 */
export async function fetchCrushUsage(
  identity: Identity,
  dataSubdir: string,
  providerId: "zai" | "alibaba",
): Promise<(TokscaleReport & { dateSpan?: DateSpan }) | undefined> {
  const projectsJsonPath = join(identity.configDir, dataSubdir, "projects.json");
  let projectsJson: ProjectsJson;
  try {
    projectsJson = (await Bun.file(projectsJsonPath).json()) as ProjectsJson;
  } catch {
    return undefined;
  }

  const seenDataDirs = new Set<string>();
  let totalMessages = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let foundAny = false;

  for (const entry of projectsJson.projects ?? []) {
    if (!entry.data_dir || seenDataDirs.has(entry.data_dir)) continue;
    seenDataDirs.add(entry.data_dir);

    const dbPath = join(entry.data_dir, "crush.db");
    if (!(await Bun.file(dbPath).exists())) continue;

    try {
      const sessions = await sessionsInDb(dbPath, providerId);
      for (const session of sessions) {
        totalMessages += session.messages;
        totalInput += session.prompt_tokens;
        totalOutput += session.completion_tokens;
        // Crush records a session-level cost using the provider model price
        // configured when it ran. Subscription configs historically set that
        // price to zero, so derive a public-price valuation from the recorded
        // model and token counts whenever possible. The saved value remains a
        // compatibility fallback for old/unknown models.
        // A falsy model (null or "") must fall back to the recorded cost,
        // never short-circuit into concatenating onto the total.
        const estimated = session.model
          ? estimateModelTokenCost(providerId, session.model, session.prompt_tokens, session.completion_tokens)
          : undefined;
        totalCost += estimated ?? session.cost;
        firstTs = firstTs === undefined ? session.created_at : Math.min(firstTs, session.created_at);
        lastTs = lastTs === undefined ? session.updated_at : Math.max(lastTs, session.updated_at);
      }
      foundAny = true;
    } catch {
      // One unreadable/corrupt project db shouldn't sink every other
      // project's real totals.
    }
  }

  if (!foundAny) return undefined;
  return {
    entries: [],
    totalInput,
    totalOutput,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalMessages,
    totalCost,
    dateSpan: firstTs !== undefined && lastTs !== undefined ? { firstMs: firstTs * 1000, lastMs: lastTs * 1000 } : undefined,
  };
}
