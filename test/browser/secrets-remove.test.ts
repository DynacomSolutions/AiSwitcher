import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSecretsKey } from "../../src/cli/gateway/secrets-file.ts";

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

test("removeSecretsKey is a no-op without backup when the key is absent", async () => {
  dir = mkdtempSync(join(tmpdir(), "ais-secrets-"));
  const f = join(dir, "secrets");
  writeFileSync(f, "A=1\n");
  await removeSecretsKey("B", f);
  expect(readFileSync(f, "utf8")).toBe("A=1\n");
  expect(readdirSync(dir)).toEqual(["secrets"]);
  await removeSecretsKey("A", f);
  expect(readdirSync(dir).length).toBe(2);
});
