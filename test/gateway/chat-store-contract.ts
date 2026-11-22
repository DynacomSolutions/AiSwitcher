import { expect, test } from "bun:test";
import type { ChatBody } from "../../src/browser/chat-protocol.ts";
import {
  ChatClosedError,
  ChatExistsError,
  ChatLeaseLostError,
  type ChatCreate,
  type ChatStore,
  type LeaseFence,
} from "../../src/gateway/chat/types.ts";

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
const user = (text: string): ChatBody => ({ k: "user", text }) satisfies ChatBody;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Creates a chat and takes a long lease on it for replica r1. */
async function owned(s: ChatStore, over: Partial<ChatCreate> = {}): Promise<{ id: string; fence: LeaseFence }> {
  const c = (await s.create(mk(over), 6)) as { id: string };
  const epoch = await s.acquireLease(c.id, "r1", 60_000, Date.now());
  expect(epoch).toBeNumber();
  return { id: c.id, fence: { replica: "r1", epoch: epoch as number } };
}

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
    const epoch = (await s.acquireLease(ids[0] as string, "r1", 60_000, Date.now())) as number;
    const closed = await s.update(ids[0] as string, { state: "closed" }, { replica: "r1", epoch });
    expect(closed?.closedAt).toBeNumber();
    expect(await s.create(mk(), 6)).not.toBe("cap");
    expect(await s.listByBinding("b1", { windowId: 1 })).toHaveLength(6);
    expect(await s.listByBinding("b1", { windowId: 1, includeClosed: true })).toHaveLength(7);
  });

  test("10 concurrent creates for one window with cap 6 give exactly 6 successes", async () => {
    const s = await make();
    const results = await Promise.all(Array.from({ length: 10 }, () => s.create(mk({ binding: "b-race", windowId: 7 }), 6)));
    expect(results.filter((r) => r !== "cap")).toHaveLength(6);
    expect(results.filter((r) => r === "cap")).toHaveLength(4);
    expect(await s.listByBinding("b-race", { windowId: 7 })).toHaveLength(6);
  });

  test("a create with an existing id fails and keeps the first chat and its events", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    await s.appendEvent(id, user("keep"), fence);
    const first = await s.get(id);
    const err = await s.create(mk({ id, name: "Other" }), 6).then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(ChatExistsError);
    expect(await s.get(id)).toEqual(first);
    expect(await s.events(id, 0, 10)).toHaveLength(1);
  });

  test("appendEvent returns 1, 2, 3 under 20 concurrent appends with no duplicate", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    expect(await s.appendEvent(id, user("a"), fence)).toBe(1);
    expect(await s.appendEvent(id, user("b"), fence)).toBe(2);
    expect(await s.appendEvent(id, user("c"), fence)).toBe(3);
    const seqs = await Promise.all(Array.from({ length: 20 }, (_, i) => s.appendEvent(id, user(`n${i}`), fence)));
    expect(new Set(seqs).size).toBe(20);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    expect((await s.get(id))?.lastSeq).toBe(23);
  });

  test("events(afterSeq) returns the rest in order and honours limit", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    for (let i = 1; i <= 5; i += 1) await s.appendEvent(id, user(`m${i}`), fence);
    expect((await s.events(id, 2, 100)).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((await s.events(id, 0, 2)).map((e) => e.seq)).toEqual([1, 2]);
    const first = (await s.events(id, 0, 1))[0];
    expect(first?.body).toEqual(user("m1"));
    expect(first?.ts).toBeNumber();
  });

  test("a second replica cannot acquire a live lease", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    const e1 = await s.acquireLease(c.id, "r1", 60_000, Date.now());
    expect(e1).toBeNumber();
    expect(await s.acquireLease(c.id, "r2", 60_000, Date.now())).toBeUndefined();
    expect(await s.acquireLease(c.id, "r1", 60_000, Date.now())).toBeGreaterThan(e1 as number);
    expect((await s.get(c.id))?.ownerReplica).toBe("r1");
  });

  test("an expired lease can be taken and the epoch grows", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    const e1 = (await s.acquireLease(c.id, "r1", 40, Date.now())) as number;
    await sleep(120);
    const e2 = await s.acquireLease(c.id, "r2", 60_000, Date.now());
    expect(e2).toBeGreaterThan(e1);
    expect((await s.get(c.id))?.ownerReplica).toBe("r2");
    expect((await s.ownedBy("r2")).map((r) => r.id)).toEqual([c.id]);
    expect(await s.ownedBy("r1")).toEqual([]);
  });

  test("renewLease fails for a non-owner, a stale epoch and an expired lease", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    expect(await s.renewLease(id, { replica: "r2", epoch: fence.epoch }, 1_000, Date.now()).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
    expect(await s.renewLease(id, { replica: "r1", epoch: fence.epoch + 1 }, 1_000, Date.now()).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
    await s.renewLease(id, fence, 60_000, Date.now());
    const c = (await s.create(mk(), 6)) as { id: string };
    const epoch = (await s.acquireLease(c.id, "r1", 30, Date.now())) as number;
    await sleep(100);
    expect(await s.renewLease(c.id, { replica: "r1", epoch }, 1_000, Date.now()).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
  });

  test("releaseLease frees it", async () => {
    const s = await make();
    const { id } = await owned(s);
    await s.releaseLease(id, "r2");
    expect(await s.acquireLease(id, "r2", 60_000, Date.now())).toBeUndefined();
    await s.releaseLease(id, "r1");
    expect(await s.acquireLease(id, "r2", 60_000, Date.now())).toBeNumber();
  });

  test("a replaced owner cannot append or update", async () => {
    const s = await make();
    const c = (await s.create(mk(), 6)) as { id: string };
    const e1 = (await s.acquireLease(c.id, "r1", 40, Date.now())) as number;
    const old: LeaseFence = { replica: "r1", epoch: e1 };
    await s.appendEvent(c.id, user("before"), old);
    await sleep(120);
    // Expired, and nobody took it yet: the old owner already fails.
    expect(await s.appendEvent(c.id, user("late"), old).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
    const e2 = (await s.acquireLease(c.id, "r2", 60_000, Date.now())) as number;
    expect(await s.appendEvent(c.id, user("stale"), old).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
    expect(await s.update(c.id, { name: "stale" }, old).then(() => "ok", (e) => e)).toBeInstanceOf(ChatLeaseLostError);
    await s.appendEvent(c.id, user("new"), { replica: "r2", epoch: e2 });
    expect((await s.get(c.id))?.name).toBe("Chat");
    expect((await s.events(c.id, 0, 10)).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("update refuses a move from closed to an open state", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    await s.update(id, { state: "closed" }, fence);
    expect(await s.update(id, { state: "idle" }, fence).then(() => "ok", (e) => e)).toBeInstanceOf(ChatClosedError);
    expect((await s.update(id, { state: "closed", name: "Done" }, fence))?.name).toBe("Done");
    expect((await s.get(id))?.state).toBe("closed");
  });

  test("update copies only the named patch keys", async () => {
    const s = await make();
    const { id, fence } = await owned(s);
    await s.appendEvent(id, user("x"), fence);
    const patch = { name: "Named", lastSeq: 99, ownerReplica: "evil", id: "other", epoch: 99 } as unknown as Parameters<ChatStore["update"]>[1];
    const u = await s.update(id, patch, fence);
    expect(u?.name).toBe("Named");
    expect(u?.lastSeq).toBe(1);
    expect(u?.ownerReplica).toBe("r1");
    expect(u?.id).toBe(id);
    expect(u?.epoch).toBe(fence.epoch);
  });

  test("pruneClosed removes events of chats closed before the cut-off and keeps open chats", async () => {
    const s = await make();
    const open = await owned(s);
    const shut = await owned(s);
    await s.appendEvent(open.id, user("x"), open.fence);
    await s.appendEvent(shut.id, user("y"), shut.fence);
    await s.update(shut.id, { state: "closed" }, shut.fence);
    expect(await s.pruneClosed(0)).toBe(0);
    expect(await s.pruneClosed(Date.now() + 60_000)).toBe(1);
    expect(await s.get(shut.id)).toBeUndefined();
    expect(await s.events(shut.id, 0, 10)).toEqual([]);
    expect(await s.get(open.id)).toBeDefined();
    expect(await s.events(open.id, 0, 10)).toHaveLength(1);
  });

  test("pruneIdle deletes open chats idle before the cut and keeps active ones", async () => {
    const s = await make();
    const idle = await owned(s, { binding: "b-idle", createdAt: 5_000 });
    await s.appendEvent(idle.id, user("old"), idle.fence);
    const fresh = await owned(s, { binding: "b-idle", createdAt: 5_000 });
    await s.appendEvent(fresh.id, user("new"), fresh.fence);
    // An append moves updatedAt to now, so only the untouched chat is idle.
    const quiet = (await s.create(mk({ binding: "b-idle", createdAt: 5_000 }), 6)) as { id: string };
    expect(await s.pruneIdle(6_000)).toBe(1);
    expect(await s.get(quiet.id)).toBeUndefined();
    expect(await s.get(idle.id)).toBeDefined();
    expect(await s.get(fresh.id)).toBeDefined();
    expect(await s.pruneIdle(Date.now() + 60_000)).toBeGreaterThanOrEqual(2);
    expect(await s.get(idle.id)).toBeUndefined();
    expect(await s.events(idle.id, 0, 10)).toEqual([]);
  });

  test("prunes work through more than one batch of 500", async () => {
    const s = await make();
    for (let i = 0; i < 1_100; i += 1) await s.create(mk({ binding: "b-batch", windowId: i, createdAt: 2_000 }), 6);
    expect(await s.pruneIdle(3_000)).toBeGreaterThanOrEqual(1_100);
    for (let i = 0; i < 1_100; i += 1) {
      const c = (await s.create(mk({ binding: "b-batch2", windowId: i, createdAt: 2_000 }), 6)) as { id: string };
      const epoch = (await s.acquireLease(c.id, "r1", 60_000, Date.now())) as number;
      await s.update(c.id, { state: "closed" }, { replica: "r1", epoch });
    }
    expect(await s.pruneClosed(Date.now() + 60_000)).toBeGreaterThanOrEqual(1_100);
    expect(await s.listByBinding("b-batch2", { includeClosed: true })).toEqual([]);
  }, 120_000);

  test("tabIds round-trip", async () => {
    const s = await make();
    const { id, fence } = await owned(s, { tabIds: [3, 9] });
    expect((await s.get(id))?.tabIds).toEqual([3, 9]);
    const u = await s.update(id, { tabIds: [4, 5, 6], acpSessionId: "acp1", canLoad: true, name: "New" }, fence);
    expect(u?.tabIds).toEqual([4, 5, 6]);
    expect(u?.acpSessionId).toBe("acp1");
    expect(u?.canLoad).toBe(true);
    expect(u?.name).toBe("New");
    expect((await s.get(id))?.selection).toEqual({ provider: "claude", identity: "id1" });
    expect(await s.update("missing", { name: "x" }, fence)).toBeUndefined();
  });
}
