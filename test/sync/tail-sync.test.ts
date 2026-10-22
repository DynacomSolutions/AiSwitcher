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
