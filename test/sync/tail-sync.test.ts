import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeJsonlTail } from "../../src/sync/dedupe.ts";
import { hashPrefix } from "../../src/sync/tail-sync.ts";
import { setDirectOwnerProbe } from "../../src/sync/tree-merge.ts";

const dirs: string[] = [];
afterEach(async () => {
  setDirectOwnerProbe();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture(live: string, sender: string, offset: number) {
  const dir = await mkdtemp(join(tmpdir(), "ais-tail-"));
  dirs.push(dir);
  const path = join(dir, "h.jsonl");
  await writeFile(path, live);
  setDirectOwnerProbe(async () => false);
  const senderFile = join(dir, "s.jsonl");
  await writeFile(senderFile, sender);
  return { path, prefix: (await hashPrefix(senderFile, offset))!, tail: Buffer.from(sender).subarray(offset) };
}

test("a matching prefix appends only the missing complete lines", async () => {
  const base = "a\nb\n";
  const f = await fixture(`${base}x\n`, `${base}c\nd\n`, base.length);
  expect(await mergeJsonlTail(f.path, base.length, f.prefix, f.tail)).toBe("merged");
  expect(await readFile(f.path, "utf8")).toBe("a\nb\nx\nc\nd\n");
});

test("lines already present after the prefix are not duplicated", async () => {
  const f = await fixture("a\nc\n", "a\nc\n", 2);
  expect(await mergeJsonlTail(f.path, 2, f.prefix, f.tail)).toBe("unchanged");
  expect(await readFile(f.path, "utf8")).toBe("a\nc\n");
});

test("a diverged prefix is reported and nothing is written", async () => {
  const f = await fixture("a\nZ\n", "a\nb\nc\n", 4);
  expect(await mergeJsonlTail(f.path, 4, f.prefix, f.tail)).toBe("diverged");
  expect(await readFile(f.path, "utf8")).toBe("a\nZ\n");
});

test("an incomplete sender tail is never appended", async () => {
  const f = await fixture("a\n", "a\nb\n{\"half", 2);
  expect(await mergeJsonlTail(f.path, 2, f.prefix, f.tail)).toBe("merged");
  expect(await readFile(f.path, "utf8")).toBe("a\nb\n");
});

import { mkdir, rename, utimes } from "node:fs/promises";
import { planTails, restrictTo, setBeforeTailCopyHook, TAIL_DEFERRED_FILE, TAIL_PLAN_FILE, tailExcludeFilters, type HistoryManifest } from "../../src/sync/tail-sync.ts";
import { mergeIncomingProfileTree } from "../../src/sync/tree-merge.ts";

const REL = ".claude/identities/a/projects/p/h.jsonl";
const line = (n: number) => `${JSON.stringify({ n, pad: "x".repeat(990) })}\n`;
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => line(from + i)).join("");

async function homes() {
  const root = await mkdtemp(join(tmpdir(), "ais-tail-merge-"));
  dirs.push(root);
  const [home, tails] = [join(root, "home"), join(root, "tails")];
  await mkdir(join(home, ".claude/identities/a/projects/p"), { recursive: true });
  await mkdir(join(tails, ".claude/identities/a/projects/p"), { recursive: true });
  await mkdir(join(root, "incoming"), { recursive: true });
  return { root, home, tails, incoming: join(root, "incoming") };
}
const noPurge = async () => ({ removed: [], warnings: [] });
const all = { kind: "all" } as const;

test("a file replaced between hashing and copying is deferred, not planned or sent whole", async () => {
  const { home, tails } = await homes();
  const base = lines(0, 1200);
  await writeFile(join(home, REL), base + lines(1200, 1300));
  const listing: HistoryManifest = { [REL]: { size: base.length + lines(1200, 1300).length, mtimeMs: 0 } };
  const receiver: HistoryManifest = { [REL]: { size: base.length, mtimeMs: 1 } };
  // Control: undisturbed, the same call plans the tail.
  expect(Object.keys(await planTails(home, all, receiver, join(tails, "ok"), new Set(), listing))).toEqual([REL]);
  setBeforeTailCopyHook(async () => {
    await writeFile(join(home, "swap"), "Z".repeat(base.length) + lines(0, 100));
    await rename(join(home, "swap"), join(home, REL));
  });
  try {
    const deferred: string[] = [];
    const plan = await planTails(home, all, receiver, join(tails, "swapped"), new Set(), listing, deferred);
    expect(plan).toEqual({});
    expect(await Bun.file(join(tails, "swapped", REL)).exists()).toBe(false);
    // The bulk transfer must leave it out too, or it is staged whole (the intermittent full re-pull).
    expect(deferred).toEqual([REL]);
    expect(JSON.parse(await readFile(join(tails, "swapped", TAIL_DEFERRED_FILE), "utf8"))).toEqual([REL]);
    expect(tailExcludeFilters(plan, deferred)).toEqual([`--exclude=/${REL}`]);
  } finally { setBeforeTailCopyHook(); }
});

test("a history equal at plan time is held back from the bulk transfer", async () => {
  const { home, tails } = await homes();
  const body = lines(0, 1300);
  await writeFile(join(home, REL), body);
  await utimes(join(home, REL), 5000, 5000);
  const listing: HistoryManifest = { [REL]: { size: body.length, mtimeMs: 5_000_000 } };
  // The receiver may append to its live copy after this plan; rsync's quick check must not then resend it whole.
  const deferred: string[] = [];
  expect(await planTails(home, all, { [REL]: { size: body.length, mtimeMs: 5_000_400 } }, join(tails, "equal"), new Set(), listing, deferred)).toEqual({});
  expect(deferred).toEqual([REL]);
});

test("restrictTo drops paths the peer was never offered", () => {
  expect(restrictTo([REL, ".ssh/id_ed25519", "../x"], [REL])).toEqual([REL]);
  expect(restrictTo(undefined, [REL])).toEqual([]);
});

test("a crafted plan cannot touch unlisted histories or use a forged offset", async () => {
  const { home, tails, incoming } = await homes();
  const live = join(home, REL);
  const base = lines(0, 1200);
  await writeFile(live, base);
  const other = ".claude/identities/a/projects/p/other.jsonl";
  await writeFile(join(home, other), "keep\n");
  const prefix = (await hashPrefix(live, base.length))!;
  const plan = {
    [REL]: { offset: base.length - 10, size: base.length + 4, mtimeMs: 0, prefix },
    [other]: { offset: 0, size: 4, mtimeMs: 0, prefix: "x" },
    ".ssh/x.jsonl": { offset: 0, size: 4, mtimeMs: 0, prefix: "x" },
  };
  await writeFile(join(tails, TAIL_PLAN_FILE), JSON.stringify(plan));
  await writeFile(join(tails, REL), "abcd");
  const manifest: HistoryManifest = { [REL]: { size: base.length, mtimeMs: 0 } };
  const result = await mergeIncomingProfileTree(incoming, all, { home, tailsDir: tails, tailsManifest: manifest, purgeRetired: noPurge });
  expect([...(result.needsFull ?? [])].sort()).toEqual([".ssh/x.jsonl", other, REL].sort());
  expect(await readFile(live, "utf8")).toBe(base);
  expect(await readFile(join(home, other), "utf8")).toBe("keep\n");
});

test("an unreadable plan sends every negotiated history to the full path", async () => {
  const { home, tails, incoming } = await homes();
  await writeFile(join(tails, TAIL_PLAN_FILE), "{not json");
  const result = await mergeIncomingProfileTree(incoming, all, { home, tailsDir: tails, tailsManifest: { [REL]: { size: 1, mtimeMs: 0 } }, purgeRetired: noPurge });
  expect(result.needsFull).toEqual([REL]);
});

test("equal size but different bytes (P+abc against P+xyz) is not adopted as equal", async () => {
  const { home, tails, incoming } = await homes();
  const live = join(home, REL);
  const base = lines(0, 1200);
  // Sender P+"abc" (no newline) against receiver P+"xyz": equal size, different bytes.
  await writeFile(live, `${base}xyz`);
  await utimes(live, 1_000, 1_000);
  const prefix = (await hashPrefix(live, base.length))!;
  await writeFile(join(tails, TAIL_PLAN_FILE), JSON.stringify({ [REL]: { offset: base.length, size: base.length + 3, mtimeMs: 5_000_000, prefix } }));
  await writeFile(join(tails, REL), "abc");
  const result = await mergeIncomingProfileTree(incoming, all, { home, tailsDir: tails, tailsManifest: { [REL]: { size: base.length, mtimeMs: 0 } }, purgeRetired: noPurge });
  expect(result.preservedConflictPaths).toEqual([REL]);
  expect(await readFile(live, "utf8")).toBe(`${base}xyz`);
  expect(Math.floor((await Bun.file(live).stat()).mtimeMs / 1000)).toBe(1000);
});

test("a sender's unfinished last line is reported and its mtime not adopted", async () => {
  const { home, tails, incoming } = await homes();
  const live = join(home, REL);
  const base = lines(0, 1200);
  await writeFile(live, base);
  await utimes(live, 1_000, 1_000);
  const prefix = (await hashPrefix(live, base.length))!;
  await writeFile(join(tails, TAIL_PLAN_FILE), JSON.stringify({ [REL]: { offset: base.length, size: base.length + 4, mtimeMs: 5_000_000, prefix } }));
  await writeFile(join(tails, REL), "abcd");
  const result = await mergeIncomingProfileTree(incoming, all, { home, tailsDir: tails, tailsManifest: { [REL]: { size: base.length, mtimeMs: 0 } }, purgeRetired: noPurge });
  expect(result.preservedConflictPaths).toEqual([REL]);
  expect(await readFile(live, "utf8")).toBe(base);
  expect(Math.floor((await Bun.file(live).stat()).mtimeMs / 1000)).toBe(1000);
});
