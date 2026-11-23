// The favourites sync of one T3 home: T3 Code's settings.json on one side, the gateway list on the other.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_PROVIDERS, favId, MAX_FAVOURITES, parseChatToExt, type ChatProvider, type FavKey } from "../../browser/chat-protocol.ts";
import type { FavouritesApi } from "./client.ts";
import { applyGateway, localChanges, sameFavs } from "./merge.ts";
import { mappedKeys, type MapContext, type T3Fav } from "./mapping.ts";
import { favouritesStateDir, type FavSyncMetrics, type FavSyncRole } from "./metrics.ts";
import { readT3Settings, settingsPathOf, writeT3Favourites } from "./settings.ts";

/** The name context of the host: the canonical name of an identity. The instances come from settings.json. A pool needs no name: it maps to POOL_IDENTITY. */
export type HostNames = Pick<MapContext, "canonical">;

export interface FavSyncDeps {
  t3Home: string;
  client: FavouritesApi;
  /** A short label the gateway keeps with each change. Default: `t3:` and the home key. */
  origin?: string;
  /** Tells apart sync processes that share one T3 home path (pods). It is part of the home key, so of the origin, the state file and the metric label. */
  label?: string;
  names: () => Promise<HostNames>;
  /** Where the state of the last sync is kept. Default: the AIS state folder. */
  stateDir?: string;
  metrics?: FavSyncMetrics;
  log?: (message: string) => void;
}

/** A change found in T3 that the gateway has not confirmed yet. `at` is the settings.json time of the read that first found it. */
export interface PendingChange { op: "add" | "remove"; at: number }
/**
 * `epoch` is the gateway store the list came from. Absent in a file from before the epoch existed.
 * `pending` holds the T3 changes that wait for the gateway, by star id. Absent in a file from before it existed.
 */
export interface SyncState { version: 1; seq: number; epoch?: string; synced: FavKey[]; pending?: Record<string, PendingChange> }

/** A short label that tells apart sync processes of one T3 home path: letters, digits, `_` and `-`, at most 40 characters. */
export const ORIGIN_LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * A short, stable name of a T3 home. It is used in file names, in the origin label and in metric labels, so no path leaks.
 * Pods share one home path, so an optional label (`--origin`) is added after the hash.
 */
export const homeKey = (t3Home: string, label?: string): string => `${createHash("sha256").update(t3Home).digest("hex").slice(0, 8)}${label ? `-${label}` : ""}`;
const statePath = (d: Pick<FavSyncDeps, "t3Home" | "stateDir" | "label">): string => join(d.stateDir ?? favouritesStateDir(), `${homeKey(d.t3Home, d.label)}.json`);
/** The counters file of one process: the role and the pid are in the name, so two processes of one home never share a file. */
export const metricsPathOf = (t3Home: string, stateDir = favouritesStateDir(), role: FavSyncRole = "cli", pid: number = process.pid, label?: string): string => join(stateDir, `${homeKey(t3Home, label)}.${role}-${pid}.metrics.json`);

/** A bad entry is skipped: it only costs the original time of one change. */
function cleanPending(raw: unknown): Record<string, PendingChange> {
  const out: Record<string, PendingChange> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    const o = e as { op?: unknown; at?: unknown } | null;
    if (o && (o.op === "add" || o.op === "remove") && typeof o.at === "number" && Number.isFinite(o.at)) out[id] = { op: o.op, at: o.at };
  }
  return out;
}

export async function readState(d: Pick<FavSyncDeps, "t3Home" | "stateDir" | "label">): Promise<SyncState | undefined> {
  try {
    const v = JSON.parse(await readFile(statePath(d), "utf8")) as { version?: unknown; seq?: unknown; epoch?: unknown; synced?: unknown; pending?: unknown };
    const seq = parseChatToExt({ t: "chat.fav.list", seq: v.seq, epoch: v.epoch, items: [] });
    if (v.version !== 1 || seq?.t !== "chat.fav.list" || !Array.isArray(v.synced)) return undefined;
    // One bad entry is skipped: it must not make the whole list unreadable.
    const synced: FavKey[] = [];
    for (const item of v.synced) {
      const one = parseChatToExt({ t: "chat.fav.list", seq: 0, items: [item] });
      if (one?.t === "chat.fav.list" && one.items[0]) synced.push(one.items[0]);
    }
    const pending = cleanPending(v.pending);
    return { version: 1, seq: seq.seq, ...(seq.epoch !== undefined ? { epoch: seq.epoch } : {}), synced, ...(Object.keys(pending).length > 0 ? { pending } : {}) };
  } catch {
    return undefined;
  }
}

async function writeState(d: Pick<FavSyncDeps, "t3Home" | "stateDir" | "label">, s: SyncState): Promise<void> {
  const path = statePath(d);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(s), { mode: 0o600 });
  await rename(temp, path);
}

const samePending = (a: Record<string, PendingChange>, b: Record<string, PendingChange>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((id) => b[id]?.op === a[id]!.op && b[id]?.at === a[id]!.at);
};

/** The differences between T3 and the last sync, each with the time of the read that first found it. A difference that is gone (T3 undid it, or the sync caught up) is dropped. */
function pendingOf(t3: readonly T3Fav[], ctx: MapContext, state: SyncState | undefined, readAt: number): Record<string, PendingChange> {
  const local = new Set(mappedKeys(t3, ctx).map(favId));
  const synced = state?.synced ?? [];
  const syncedIds = new Set(synced.map(favId));
  const out: Record<string, PendingChange> = {};
  const note = (id: string, op: PendingChange["op"]): void => {
    const prev = state?.pending?.[id];
    out[id] = prev?.op === op ? prev : { op, at: readAt };
  };
  for (const id of local) if (!syncedIds.has(id)) note(id, "add");
  for (const k of synced) if (!local.has(favId(k))) note(favId(k), "remove");
  return out;
}

export type RoundResult =
  | { status: "no-settings" }
  /** T3 Code wrote its settings while this round worked. Nothing was written, run again. */
  | { status: "retry" }
  | { status: "ok"; seq: number; pushed: number; wrote: boolean };

/**
 * One round. It reads the gateway list, sends the stars made in T3 since the last round, makes T3's mapped favourites equal to the
 * gateway list, and remembers the result. A round that finds nothing to change writes nothing, so the file event that follows a
 * write of this code ends the loop.
 */
export async function syncOnce(d: FavSyncDeps): Promise<RoundResult> {
  const m = d.metrics;
  const settings = await readT3Settings(d.t3Home);
  if (!settings) return { status: "no-settings" };
  const ctx: MapContext = { ...(await d.names()), instances: settings.instances };
  const state = await readState(d);
  // T3 does not date its stars, so the first read that shows a change dates it. A later read must not move that time: an unrelated save of
  // settings.json while the change waits (gateway down, failed rounds) would make an old removal look newer than a panel add.
  // It is stored before the gateway is asked, so a round that fails on the gateway keeps it.
  const pending = pendingOf(settings.favorites, ctx, state, settings.mtimeMs);
  if (!samePending(pending, state?.pending ?? {})) await writeState(d, { version: 1, seq: state?.seq ?? 0, ...(state?.epoch !== undefined ? { epoch: state.epoch } : {}), synced: state?.synced ?? [], ...(Object.keys(pending).length > 0 ? { pending } : {}) });
  let gateway = await d.client.get();
  m && (m.s.pulls += 1);
  // A new epoch, or a list version below the remembered one, means the gateway lost its data. Every star of T3 goes up again, and nothing is removed.
  // The version alone is not enough: a rebuilt store may already be past the old version when the host reads it.
  const reset = state !== undefined && (gateway.seq < state.seq || (gateway.epoch !== undefined && state.epoch !== undefined && gateway.epoch !== state.epoch));
  const last = state && !reset ? state.synced : undefined;
  const changes = localChanges(settings.favorites, ctx, last, gateway.items, settings.mtimeMs).map((c) => {
    const p = pending[favId(c)];
    return p && p.op === c.op ? { ...c, at: p.at } : c;
  });
  // An add that the gateway refused because the list is full (`cap`) stays in T3 and is sent again next round.
  // An add that lost to a newer change (`stale`) is dead: the newer change wins everywhere, so T3 follows the gateway list and the add is not kept or sent again.
  const keep = new Set<string>();
  // The gateway confirms a change when it lists it with that op, and a `stale` refusal ends it. Only a `cap` add stays pending, with its first time.
  const waiting: Record<string, PendingChange> = {};
  if (changes.length > 0) {
    const posted = await d.client.post(d.origin ?? `t3:${homeKey(d.t3Home, d.label)}`, changes);
    m && (m.s.pushes += 1);
    const adds = new Set(changes.filter((c) => c.op === "add").map(favId));
    for (const k of posted.refused ?? []) {
      m && (m.s.refused += 1);
      if (k.reason === "cap" && adds.has(favId(k))) {
        keep.add(favId(k));
        const c = changes.find((x) => x.op === "add" && favId(x) === favId(k));
        if (c?.at !== undefined) waiting[favId(k)] = { op: "add", at: c.at };
      }
    }
    gateway = posted;
  }
  const applied = applyGateway(settings.favorites, ctx, gateway.items, keep);
  let wrote = false;
  if (!sameFavs(applied.next, settings.favorites)) {
    const r = await writeT3Favourites(settings, applied.next);
    if (r === "changed") return { status: "retry" };
    wrote = r === "written";
    if (wrote && m) {
      m.s.writes += 1;
      m.s.lastWrite = Math.floor(Date.now() / 1000);
    }
  }
  await writeState(d, { version: 1, seq: gateway.seq, ...(gateway.epoch !== undefined ? { epoch: gateway.epoch } : {}), synced: applied.synced.slice(0, MAX_FAVOURITES), ...(Object.keys(waiting).length > 0 ? { pending: waiting } : {}) });
  if (m) m.s.lastSuccess = Math.floor(Date.now() / 1000);
  return { status: "ok", seq: gateway.seq, pushed: changes.length, wrote };
}

export interface RunOptions {
  signal?: AbortSignal;
  /** The slow poll that backs up the file watch and the gateway wait. Default 60 s. */
  fallbackMs?: number;
  /** How long the gateway holds a wait for a change. Default 25 s. */
  waitMs?: number;
  /** Pause after a failed round, growing to `maxBackoffMs`. Default 2 s. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Time to let the file settle after an event (T3 writes settings.json after 100 ms). Default 150 ms. */
  settleMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * The long-running mode. A round runs at the start, when the settings file changes (a watch on its folder), when the gateway reports
 * a new list version (a held request), and at least every `fallbackMs`. A failed round is logged once per message and tried again with a growing pause.
 */
export async function runFavouritesSync(d: FavSyncDeps, o: RunOptions = {}): Promise<void> {
  const log = d.log ?? ((m: string) => console.error(`ais: ${m}`));
  const signal = o.signal;
  const fallbackMs = o.fallbackMs ?? 60_000;
  const waitMs = o.waitMs ?? 25_000;
  const minBackoff = o.backoffMs ?? 2_000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;
  const settleMs = o.settleMs ?? 150;
  let wake: (() => void) | undefined;
  let kicked = false;
  const kick = (): void => {
    kicked = true;
    wake?.();
  };

  // The settings file is replaced by a rename, so the watch is on the folder and filters by name.
  let watcher: FSWatcher | undefined;
  const watchFolder = (): void => {
    if (watcher) return;
    try {
      watcher = watch(dirname(settingsPathOf(d.t3Home)), (_event, name) => {
        if (name === null || name === "settings.json") kick();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch { /* the folder is not there yet: the fallback poll runs the round, and the next one tries again */ }
  };

  // The held request to the gateway: it ends when the list version differs from the one this loop last saw.
  let seen: number | undefined;
  const follow = (async () => {
    let pause = minBackoff;
    while (!signal?.aborted) {
      try {
        const r = await d.client.get(seen, waitMs, signal);
        pause = minBackoff;
        if (seen === undefined || r.changed === true || r.seq !== seen) {
          const first = seen === undefined;
          seen = r.seq;
          if (!first) kick();
        }
        // A gateway without the wait answers at once: never spin.
        await sleep(r.changed === true ? 250 : 1_000, signal);
      } catch {
        await sleep(pause, signal);
        pause = Math.min(pause * 2, maxBackoff);
      }
    }
  })();

  let failures = 0;
  let lastMessage: string | undefined;
  try {
    while (!signal?.aborted) {
      watchFolder();
      kicked = false;
      let retry = false;
      try {
        const r = await syncOnce(d);
        retry = r.status === "retry";
        if (r.status === "ok") seen = r.seq;
        failures = 0;
        if (lastMessage !== undefined) log(`t3 favourites sync: working again`);
        lastMessage = undefined;
      } catch (err) {
        failures += 1;
        if (d.metrics) d.metrics.s.errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastMessage) log(`t3 favourites sync: ${msg}`);
        lastMessage = msg;
      }
      d.metrics?.persist();
      if (retry) {
        await sleep(settleMs, signal);
        continue;
      }
      const wait = failures > 0 ? Math.min(minBackoff * 2 ** (failures - 1), maxBackoff) : fallbackMs;
      if (!kicked) {
        await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), sleep(wait, signal)]);
        wake = undefined;
      }
      // Let a burst of file events end before the next round.
      if (!signal?.aborted) await sleep(settleMs, signal);
    }
  } finally {
    watcher?.close();
    await Promise.race([follow, sleep(200)]);
  }
}

/** The names of this host: the canonical name of an identity, from the AIS identity registry. A host with no registry (a pod) uses the names as they are. */
export async function hostNames(): Promise<HostNames> {
  const { TOOL_CONFIGS } = await import("../../cli/identities/resolve-tool.ts");
  const { loadIdentitiesFile } = await import("../../identities/store.ts");
  const canon = new Map<ChatProvider, Array<{ name: string; aliases: string[] }>>();
  for (const p of CHAT_PROVIDERS) {
    const cfg = (TOOL_CONFIGS as Record<string, { identitiesJsonPath: string } | undefined>)[p];
    if (!cfg) continue;
    try {
      const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
      canon.set(p, file.identities.map((i) => ({ name: i.name, aliases: i.aliases ?? [] })));
    } catch { /* a tool with no registry (a pod): its names are used as they are */ }
  }
  return {
    canonical: (p, name) => {
      const hit = canon.get(p)?.find((i) => i.name === name || i.aliases.includes(name));
      return hit?.name ?? name;
    },
  };
}
