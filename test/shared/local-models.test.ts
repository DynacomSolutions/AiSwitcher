import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverLocalModels,
  localModelArgs,
  localModelDirs,
  resolveLlamaRunner,
} from "../../src/shared/local-models";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ais-local-models-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("finds non-empty .gguf files only, sorted by name", async () => {
  writeFileSync(join(tmp, "b.gguf"), "abc");
  writeFileSync(join(tmp, "a.gguf"), "abc");
  writeFileSync(join(tmp, "empty.gguf"), "");
  writeFileSync(join(tmp, "notes.txt"), "abc");
  mkdirSync(join(tmp, "sub.gguf"));
  const env = { AIS_LOCAL_MODELS_DIR: tmp };
  const found = await discoverLocalModels({ env });
  expect(found.map((m) => m.name)).toEqual(["a", "b"]);
  expect(found[0]).toEqual({ name: "a", path: join(tmp, "a.gguf"), sizeBytes: 3 });
});

test("AIS_LOCAL_MODELS_DIR replaces the default directories", () => {
  expect(localModelDirs({ env: { AIS_LOCAL_MODELS_DIR: "/x" }, home: "/h" })).toEqual(["/x"]);
  expect(localModelDirs({ env: {}, home: "/h" })).toEqual(["/h/.ais/models", "/opt/ais/models"]);
});

test("a missing directory yields no models and does not throw", async () => {
  expect(await discoverLocalModels({ env: { AIS_LOCAL_MODELS_DIR: join(tmp, "nope") } })).toEqual([]);
});

test("first directory wins on a name clash", async () => {
  const one = join(tmp, "one");
  const two = join(tmp, "two");
  mkdirSync(one);
  mkdirSync(two);
  writeFileSync(join(one, "m.gguf"), "1");
  writeFileSync(join(two, "m.gguf"), "22");
  const found = await discoverLocalModels({ dirs: [one, two] });
  expect(found).toEqual([{ name: "m", path: join(one, "m.gguf"), sizeBytes: 1 }]);
});

test("runner: AIS_LLAMA_BIN wins when executable, else which('llama-cli'), else undefined", () => {
  const bin = join(tmp, "llama");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  expect(resolveLlamaRunner({ env: { AIS_LLAMA_BIN: bin }, which: () => "/usr/bin/llama-cli" })).toBe(bin);
  const plain = join(tmp, "plain");
  writeFileSync(plain, "x");
  chmodSync(plain, 0o644);
  expect(resolveLlamaRunner({ env: { AIS_LLAMA_BIN: plain }, which: () => "/usr/bin/llama-cli" })).toBe(
    "/usr/bin/llama-cli",
  );
  expect(resolveLlamaRunner({ env: {}, which: () => "/usr/bin/llama-cli" })).toBe("/usr/bin/llama-cli");
  expect(resolveLlamaRunner({ env: {}, which: () => null })).toBeUndefined();
});

test("localModelArgs", () => {
  expect(localModelArgs({ name: "m", path: "/p/m.gguf", sizeBytes: 1 })).toEqual(["-m", "/p/m.gguf", "-cnv"]);
});
