import { expect, test } from "bun:test";
import { MAX_FAVOURITES, type FavChange } from "../../src/browser/chat-protocol.ts";
import { effectiveAt, type FavouriteStore } from "../../src/gateway/chat/favourites-store.ts";

const NOW = 1_800_000_000_000;
const key = (model: string, identity = "work", provider: "claude" | "codex" = "claude") => ({ provider, identity, model });
const add = (model: string, at?: number, identity = "work"): FavChange => ({ ...key(model, identity), op: "add", ...(at !== undefined ? { at } : {}) });
const remove = (model: string, at?: number): FavChange => ({ ...key(model), op: "remove", ...(at !== undefined ? { at } : {}) });
const models = async (s: FavouriteStore): Promise<string[]> => (await s.list()).items.map((i) => `${i.identity}/${i.model}`);

export function favouriteStoreContract(make: () => Promise<FavouriteStore>): void {
  test("an empty store lists nothing at version 0", async () => {
    const s = await make();
    expect(await s.list()).toEqual({ seq: 0, items: [] });
  });

  test("adds are listed oldest first and the version grows only when a star flips", async () => {
    const s = await make();
    const a = await s.apply([add("m1", NOW - 2000), add("m2", NOW - 1000)], "chrome", NOW);
    expect(a.changed).toBe(true);
    expect(await models(s)).toEqual(["work/m1", "work/m2"]);
    const again = await s.apply([add("m1", NOW - 500)], "t3", NOW);
    expect(again.changed).toBe(false);
    expect(again.seq).toBe(a.seq);
    const rm = await s.apply([remove("m1", NOW)], "t3", NOW);
    expect(rm.changed).toBe(true);
    expect(rm.seq).toBeGreaterThan(a.seq);
    expect(await models(s)).toEqual(["work/m2"]);
  });

  test("the newest change of a model wins, whatever the arrival order", async () => {
    const s = await make();
    await s.apply([add("m1", NOW - 3000)], "t3", NOW);
    await s.apply([remove("m1", NOW - 1000)], "t3", NOW);
    // An older add that arrives late does not bring the star back.
    expect((await s.apply([add("m1", NOW - 5000)], "chrome", NOW)).changed).toBe(false);
    expect(await models(s)).toEqual([]);
    // A newer add does.
    expect((await s.apply([add("m1", NOW - 10)], "chrome", NOW)).changed).toBe(true);
    expect(await models(s)).toEqual(["work/m1"]);
    // An older remove after a newer add does not remove it.
    expect((await s.apply([remove("m1", NOW - 500)], "t3", NOW)).changed).toBe(false);
    expect(await models(s)).toEqual(["work/m1"]);
  });

  test("a removal of a model that is not starred changes nothing and does not move the version", async () => {
    const s = await make();
    const a = await s.apply([add("m1", NOW - 100)], "chrome", NOW);
    const gone = await s.apply([remove("never", NOW)], "t3", NOW);
    expect(gone).toMatchObject({ changed: false, seq: a.seq });
    expect((await s.list()).seq).toBe(a.seq);
    // A removal of a star that is already removed does not move it either.
    await s.apply([remove("m1", NOW - 50)], "t3", NOW);
    const seq = (await s.list()).seq;
    expect((await s.apply([remove("m1", NOW - 10)], "t3", NOW)).seq).toBe(seq);
    // The skipped removal left no row: a star made earlier than it is still accepted.
    expect((await s.apply([add("never", NOW - 1000)], "chrome", NOW)).changed).toBe(true);
    expect(await models(s)).toEqual(["work/never"]);
  });

  test("an equal time lets the later call win", async () => {
    const s = await make();
    await s.apply([add("m1", NOW - 100)], "chrome", NOW);
    await s.apply([remove("m1", NOW - 100)], "t3", NOW);
    expect(await models(s)).toEqual([]);
  });

  test("a star in one place and a star in another at the same time both survive", async () => {
    const s = await make();
    await Promise.all([s.apply([add("from-chrome", NOW - 5)], "chrome", NOW), s.apply([add("from-t3", NOW - 4)], "t3", NOW)]);
    expect((await models(s)).sort()).toEqual(["work/from-chrome", "work/from-t3"]);
  });

  test("the same model name under another identity or provider is another star", async () => {
    const s = await make();
    await s.apply([add("m1", NOW - 3), add("m1", NOW - 2, "home"), { ...key("m1", "work", "codex"), op: "add", at: NOW - 1 }], "x", NOW);
    expect((await s.list()).items).toHaveLength(3);
    await s.apply([remove("m1", NOW)], "x", NOW);
    expect((await s.list()).items).toHaveLength(2);
  });

  test("a time far ahead of the gateway, or very old, counts as now", async () => {
    expect(effectiveAt(NOW + 3_600_000, NOW)).toBe(NOW);
    expect(effectiveAt(NOW - 30 * 24 * 3600_000, NOW)).toBe(NOW);
    expect(effectiveAt(undefined, NOW)).toBe(NOW);
    expect(effectiveAt(NOW - 1000, NOW)).toBe(NOW - 1000);
    const s = await make();
    await s.apply([add("m1", NOW + 3_600_000)], "x", NOW);
    // The wrong future time did not lock the star: a real later change still removes it.
    expect((await s.apply([remove("m1", NOW + 1000)], "x", NOW + 2000)).changed).toBe(true);
  });

  test("the list holds at most the cap and refuses the next add", async () => {
    const s = await make();
    const many = Array.from({ length: MAX_FAVOURITES }, (_, i) => add(`m${i}`, NOW - 1000 + i));
    expect((await s.apply(many, "x", NOW)).changed).toBe(true);
    expect((await s.apply([add("one-more", NOW)], "x", NOW)).changed).toBe(false);
    expect((await s.list()).items).toHaveLength(MAX_FAVOURITES);
    // A removal makes room.
    await s.apply([remove("m0", NOW)], "x", NOW);
    expect((await s.apply([add("one-more", NOW)], "x", NOW)).changed).toBe(true);
  });
}
