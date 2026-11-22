import { expect, test } from "bun:test";
import type { ChatCreate, ChatStore } from "../../src/gateway/chat/types.ts";

let counter = 0;
const mk = (over: Partial<ChatCreate> = {}): ChatCreate => {
  counter += 1;
  return {
    id: `chat-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    binding: "b1",
    windowId: 1,
    name: "Chat",
    color: "#336699",
    selection: { provider: "claude", identity: "id1" },
    tabIds: [],
    createdAt: 1_000 + counter,
    ...over,
  };
};

export function chatStoreContract(make: () => Promise<ChatStore>): void {
  test("create refuses the seventh open chat of one window and counts closed ones out", async () => {
    const s = await make();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await s.create(mk(), 6);
      expect(r).not.toBe("cap");
      ids.push((r as { id: string }).id);
    }
    expect(await s.create(mk(), 6)).toBe("cap");
    expect(await s.create(mk({ windowId: 2 }), 6)).not.toBe("cap");
    const closed = await s.update(ids[0] as string, { state: "closed" });
    expect(closed?.closedAt).toBeNumber();
    expect(await s.create(mk(), 6)).not.toBe("cap");
    expect(await s.listByBinding("b1", { windowId: 1 })).toHaveLength(6);
    expect(await s.listByBinding("b1", { windowId: 1, includeClosed: true })).toHaveLength(7);
  });

  test("appendEvent returns 1, 2, 3 under 20 concurrent appends with no duplicate", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    expect(await s.appendEvent(c.id, { t: "user", text: "a" } as never)).toBe(1);
    expect(await s.appendEvent(c.id, { t: "user", text: "b" } as never)).toBe(2);
    expect(await s.appendEvent(c.id, { t: "user", text: "c" } as never)).toBe(3);
    const seqs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.appendEvent(c.id, { t: "user", text: `n${i}` } as never)));
    expect(new Set(seqs).size).toBe(20);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    expect((await s.get(c.id))?.lastSeq).toBe(23);
  });

  test("events(afterSeq) returns the rest in order and honours limit", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    for (let i = 1; i <= 5; i += 1) await s.appendEvent(c.id, { t: "user", text: `m${i}` } as never);
    expect((await s.events(c.id, 2, 100)).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((await s.events(c.id, 0, 2)).map((e) => e.seq)).toEqual([1, 2]);
    const first = (await s.events(c.id, 0, 1))[0];
    expect(first?.body).toEqual({ t: "user", text: "m1" } as never);
    expect(first?.ts).toBeNumber();
  });

  test("a second replica cannot acquire a live lease", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    expect(await s.acquireLease(c.id, "r1", 1_000, 10_000)).toBe(true);
    expect(await s.acquireLease(c.id, "r2", 1_000, 10_500)).toBe(false);
    expect(await s.acquireLease(c.id, "r1", 1_000, 10_500)).toBe(true);
    expect((await s.get(c.id))?.ownerReplica).toBe("r1");
  });

  test("an expired lease can be taken", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    expect(await s.acquireLease(c.id, "r1", 1_000, 10_000)).toBe(true);
    expect(await s.acquireLease(c.id, "r2", 1_000, 11_001)).toBe(true);
    const got = await s.get(c.id);
    expect(got?.ownerReplica).toBe("r2");
    expect(got?.leaseUntil).toBe(12_001);
    expect((await s.ownedBy("r2")).map((r) => r.id)).toEqual([c.id]);
    expect(await s.ownedBy("r1")).toEqual([]);
  });

  test("renewLease fails for a non-owner", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    await s.acquireLease(c.id, "r1", 1_000, 10_000);
    expect(await s.renewLease(c.id, "r2", 1_000, 10_100)).toBe(false);
    expect(await s.renewLease(c.id, "r1", 5_000, 10_100)).toBe(true);
    expect((await s.get(c.id))?.leaseUntil).toBe(15_100);
  });

  test("releaseLease frees it", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    await s.acquireLease(c.id, "r1", 60_000, 10_000);
    await s.releaseLease(c.id, "r2");
    expect(await s.acquireLease(c.id, "r2", 1_000, 10_100)).toBe(false);
    await s.releaseLease(c.id, "r1");
    expect(await s.acquireLease(c.id, "r2", 1_000, 10_100)).toBe(true);
  });

  test("pruneClosed removes events of chats closed before the cut-off and keeps open chats", async () => {
    const s = await make();
    const open = (await s.create(mk(), 6)) as { id: string };
    const shut = (await s.create(mk(), 6)) as { id: string };
    await s.appendEvent(open.id, { t: "user", text: "x" } as never);
    await s.appendEvent(shut.id, { t: "user", text: "y" } as never);
    await s.update(shut.id, { state: "closed" });
    expect(await s.pruneClosed(0)).toBe(0);
    expect(await s.pruneClosed(Date.now() + 60_000)).toBe(1);
    expect(await s.get(shut.id)).toBeUndefined();
    expect(await s.events(shut.id, 0, 10)).toEqual([]);
    expect(await s.get(open.id)).toBeDefined();
    expect(await s.events(open.id, 0, 10)).toHaveLength(1);
  });

  test("tabIds round-trip", async () => {
    const s = await make();
    const c = (await s.create(mk({ tabIds: [3, 9] }), 6)) as { id: string };
    expect((await s.get(c.id))?.tabIds).toEqual([3, 9]);
    const u = await s.update(c.id, { tabIds: [4, 5, 6], acpSessionId: "acp1", canLoad: true, name: "New" });
    expect(u?.tabIds).toEqual([4, 5, 6]);
    expect(u?.acpSessionId).toBe("acp1");
    expect(u?.canLoad).toBe(true);
    expect(u?.name).toBe("New");
    expect((await s.get(c.id))?.selection).toEqual({ provider: "claude", identity: "id1" });
    expect(await s.update("missing", { name: "x" })).toBeUndefined();
  });
}
