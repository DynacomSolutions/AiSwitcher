import { describe, expect, test } from "bun:test";
import { PgHomeStore } from "../../src/gateway/home-store.ts";

/** The shared LISTEN: starts and stops run one at a time, and a late joiner never holds a dead LISTEN. */

interface FakeListen {
  started: number;
  unlistened: number;
  live: Set<number>;
  emit(payload: string): void;
}

function fakeStore(slowMs = 0): { store: PgHomeStore; fake: FakeListen } {
  const store = new PgHomeStore("postgres://u@db.example.test/x", Buffer.alloc(32, 1));
  const handlers = new Map<number, (p: string) => void>();
  const fake: FakeListen = { started: 0, unlistened: 0, live: new Set(), emit: (p) => handlers.forEach((h) => h(p)) };
  (store as unknown as { sql: unknown }).sql = {
    close: async () => undefined,
    listen: async (_channel: string, cb: (p: string) => void) => {
      const id = ++fake.started;
      await Bun.sleep(slowMs);
      handlers.set(id, cb);
      fake.live.add(id);
      return {
        unlisten: async () => {
          await Bun.sleep(slowMs);
          handlers.delete(id);
          fake.live.delete(id);
          fake.unlistened += 1;
        },
      };
    },
  };
  return { store, fake };
}

describe("PgHomeStore shared LISTEN", () => {
  test("A leaves while B joins and D joins later: every live subscriber still hears changes and nothing leaks", async () => {
    const { store, fake } = fakeStore(15);
    const heard: Record<string, string[]> = { A: [], B: [], D: [] };
    const leaveA = await store.listen((p) => heard.A!.push(p));
    // B starts to join while A, the last subscriber, is leaving.
    const leaving = leaveA();
    const joiningB = store.listen((p) => heard.B!.push(p));
    const [, leaveB] = await Promise.all([leaving, joiningB]);
    expect(fake.live.size).toBe(1); // B has a live LISTEN, not the one A ended
    fake.emit("one");
    expect(heard.B).toEqual(["one"]);
    expect(heard.A).toEqual([]);
    const leaveD = await store.listen((p) => heard.D!.push(p));
    expect(fake.started).toBe(2); // D shares B's LISTEN
    fake.emit("two");
    expect(heard.B).toEqual(["one", "two"]);
    expect(heard.D).toEqual(["two"]);
    await leaveB();
    await leaveB(); // leaving twice is harmless
    expect(fake.live.size).toBe(1); // D is still subscribed
    fake.emit("three");
    expect(heard.D).toEqual(["two", "three"]);
    await leaveD();
    expect(fake.live.size).toBe(0);
    expect(fake.started).toBe(fake.unlistened);
  });

  test("a subscriber that joins while the last one leaves gets a fresh LISTEN; many parallel joins and leaves end with none left", async () => {
    const { store, fake } = fakeStore(5);
    const first = await store.listen(() => undefined);
    const ops: Array<Promise<unknown>> = [first()];
    const joined: Array<() => Promise<void>> = [];
    for (let i = 0; i < 6; i++) ops.push(store.listen(() => undefined).then((u) => void joined.push(u)));
    await Promise.all(ops);
    expect(fake.live.size).toBe(1);
    await Promise.all(joined.map((u) => u()));
    expect(fake.live.size).toBe(0);
    expect(fake.started).toBe(fake.unlistened);
  });

  test("a failed LISTEN start leaves no subscriber behind and a later listen starts again", async () => {
    const store = new PgHomeStore("postgres://u@db.example.test/x", Buffer.alloc(32, 1));
    let fail = true;
    let started = 0;
    (store as unknown as { sql: unknown }).sql = {
      close: async () => undefined,
      listen: async () => {
        if (fail) throw new Error("no listen");
        started += 1;
        return { unlisten: async () => undefined };
      },
    };
    await expect(store.listen(() => undefined)).rejects.toThrow("no listen");
    fail = false;
    const u = await store.listen(() => undefined);
    expect(started).toBe(1);
    await u();
  });
});
