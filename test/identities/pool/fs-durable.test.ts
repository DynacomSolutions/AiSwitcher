import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileDurable, writeFileDurable } from "../../../src/identities/pool/fs.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-fs-durable-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("writeFileDurable replaces the file with 0600 content and leaves no temp file", async () => {
  const f = join(dir, "login.json");
  await writeFile(f, "old");
  await writeFileDurable(f, "new");
  expect(await readFile(f, "utf8")).toBe("new");
  expect((await stat(f)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual(["login.json"]);
});

test("createFileDurable never overwrites an existing file", async () => {
  const f = join(dir, "x.bak");
  await createFileDurable(f, "one");
  expect(await readFile(f, "utf8")).toBe("one");
  expect((await stat(f)).mode & 0o777).toBe(0o600);
  await expect(createFileDurable(f, "two")).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(f, "utf8")).toBe("one");
});

test("a failed write leaves the target as it was and removes the temp file", async () => {
  await expect(writeFileDurable(join(dir, "missing-dir", "f"), "x")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(dir)).toEqual([]);
});
