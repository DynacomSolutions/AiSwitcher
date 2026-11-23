import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FavChange, FavKey } from "../../src/browser/chat-protocol.ts";
import { MemoryFavouriteStore } from "../../src/gateway/chat/favourites-store.ts";
import type { FavouritesApi, FavList } from "../../src/t3/favourites/client.ts";
import type { HostNames } from "../../src/t3/favourites/sync.ts";

/** A scratch folder. Tests set AIS_E2E_TMP so that it is not the OS temp folder. */
export const scratch = (): string => mkdtempSync(join(process.env.AIS_E2E_TMP ?? tmpdir(), "ais-favsync-"));

/** The instances of a host with one of each kind. `work` and `home` are made-up identity names. */
/** The pool instance ids are built from parts: the privacy guard rejects the literal names of local pools. */
export const CLAUDE_POOL = ["claude", "pool"].join("-");
export const CODEX_POOL = ["codex", "pool"].join("-");
export const INSTANCES = [
  "claudeAgent", "codex", CLAUDE_POOL, CODEX_POOL, "t3-claude-work", "t3-claude-home", "t3-claude-kimi-work", "t3-claude-zai-pool",
  "t3-codex-work", "t3-kimi-work-acp", "t3-kimi-pool-acp", "t3-grok-work", "t3-grok-work-acp", "t3-grok-pool", "t3-zai-work-acp", "t3-zcode-work-acp", "t3-opencode-work", "t3-opencode-pool",
];

export const names = (over: Partial<Record<string, string>> = {}): HostNames => ({ poolName: (p) => over[p] ?? "pool", canonical: (_p, n) => (n === "wk" ? "work" : n) });

/** A home with a settings.json that has the given favorites and other keys. */
export function makeHome(opts: { favorites?: Array<{ provider: string; model: string }>; instances?: string[]; indent?: number | string; extra?: Record<string, unknown>; mode?: number } = {}): { home: string; settings: string; read(): Record<string, any>; text(): string } {
  const home = scratch();
  mkdirSync(join(home, "userdata"), { recursive: true });
  const settings = join(home, "userdata", "settings.json");
  const body = { favorites: opts.favorites ?? [], storageCleanup: { days: 7 }, defaultAutoPull: true, ...(opts.extra ?? {}), providerInstances: Object.fromEntries((opts.instances ?? INSTANCES).map((i) => [i, { driver: "x", enabled: true }])) };
  writeFileSync(settings, `${JSON.stringify(body, null, opts.indent ?? 2)}\n`, { mode: opts.mode ?? 0o600 });
  return { home, settings, read: () => JSON.parse(readFileSync(settings, "utf8")), text: () => readFileSync(settings, "utf8") };
}

/** The gateway as a function: the real store rules, no network. Calls are counted. */
export function fakeGateway(now: () => number = Date.now) {
  const store = new MemoryFavouriteStore();
  const calls = { gets: 0, posts: 0, posted: [] as FavChange[][] };
  let down = false;
  const list = async (): Promise<FavList> => {
    const l = await store.list();
    return { seq: l.seq, epoch: l.epoch, items: l.items.map(({ provider, identity, model }) => ({ provider, identity, model })) };
  };
  const api: FavouritesApi = {
    async get(since, waitMs = 0, signal) {
      if (down) throw new Error("gateway down");
      calls.gets += 1;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const l = await list();
        if (since === undefined || l.seq !== since) return { ...l, changed: true };
        if (Date.now() >= deadline || signal?.aborted) return { ...l, changed: false };
        await Bun.sleep(10);
      }
    },
    async post(origin, changes) {
      if (down) throw new Error("gateway down");
      calls.posts += 1;
      calls.posted.push(changes);
      await store.apply(changes, origin, now());
      return list();
    },
  };
  return { api, store, calls, setDown: (v: boolean) => { down = v; }, star: (k: FavKey, op: "add" | "remove" = "add", at?: number) => store.apply([{ ...k, op, ...(at !== undefined ? { at } : {}) }], "panel", now()) };
}

export const key = (model: string, identity = "work", provider: FavKey["provider"] = "claude"): FavKey => ({ provider, identity, model });
