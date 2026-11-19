import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProbeLock } from "../../../src/cli/limits/probe-lock.ts";

test("only one holder at a time, and release frees the lock", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ais-lock-")), "x.lock");
  const release = await acquireProbeLock(path, 60_000);
  expect(release).toBeDefined();
  expect(await acquireProbeLock(path, 60_000)).toBeUndefined();
  await release!();
  expect(await acquireProbeLock(path, 60_000)).toBeDefined();
});
