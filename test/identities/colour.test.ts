import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateIdentity } from "../../src/cli/identities/actions.ts";
import {
  IDENTITY_COLOUR_PALETTE,
  autoIdentityColour,
  effectiveIdentityColour,
  isValidIdentityColour,
  normaliseIdentityColour,
} from "../../src/identities/colour.ts";
import { InvalidIdentitiesFileError } from "../../src/identities/errors.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";
import type { IdentitiesFile } from "../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function emptyFile(): IdentitiesFile {
  return { version: 1, identities: [{ name: "testa", label: "Test A", configDir: "/tmp/testa" }] };
}

describe("identity colour validation + normalisation", () => {
  test("accepts #rgb and #rrggbb, rejects everything else", () => {
    expect(isValidIdentityColour("#22c55e")).toBe(true);
    expect(isValidIdentityColour("#abc")).toBe(true);
    expect(isValidIdentityColour("#ABC")).toBe(true);
    expect(isValidIdentityColour("22c55e")).toBe(false);
    expect(isValidIdentityColour("#12345")).toBe(false);
    expect(isValidIdentityColour("#1234567")).toBe(false);
    expect(isValidIdentityColour("#gggggg")).toBe(false);
    expect(isValidIdentityColour("")).toBe(false);
    expect(isValidIdentityColour(undefined)).toBe(false);
  });

  test("normalises to lowercase six-digit form", () => {
    expect(normaliseIdentityColour("#ABC")).toBe("#aabbcc");
    expect(normaliseIdentityColour("#22C55E")).toBe("#22c55e");
    expect(normaliseIdentityColour("nope")).toBeUndefined();
  });
});

describe("effective identity colour", () => {
  test("explicit colour wins; auto colour is a stable palette member", () => {
    expect(effectiveIdentityColour("claude", "testa", "#f00")).toBe("#ff0000");
    const first = autoIdentityColour("claude", "testa");
    expect(IDENTITY_COLOUR_PALETTE).toContain(first);
    // Stable across calls and machine state: pure function of (tool, name).
    expect(autoIdentityColour("claude", "testa")).toBe(first);
    expect(autoIdentityColour("codex", "testa")).toBe(autoIdentityColour("codex", "testa"));
    // Different keys land somewhere in the palette (very likely distinct).
    expect(effectiveIdentityColour("claude", "testa", undefined)).toBe(first);
    expect(effectiveIdentityColour("claude", "testa", "bogus")).toBe(first); // invalid falls back
  });

  test("palette entries are all normal #rrggbb", () => {
    for (const colour of IDENTITY_COLOUR_PALETTE) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(IDENTITY_COLOUR_PALETTE).size).toBe(IDENTITY_COLOUR_PALETTE.length);
  });
});

describe("registry colour round-trip", () => {
  test("updateIdentity sets, normalises and clears colour", () => {
    const file = emptyFile();
    const set = updateIdentity(file, "testa", { colour: "#ABC" });
    expect(set.colour).toBe("#aabbcc");
    expect(updateIdentity(file, "testa", { colour: "" }).colour).toBeUndefined();
    expect("colour" in file.identities[0]!).toBe(false);
    expect(() => updateIdentity(file, "testa", { colour: "red" })).toThrow(/#rgb or #rrggbb/);
  });

  test("loadIdentitiesFile rejects a registry with a malformed colour", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-colour-"));
    tempDirs.push(dir);
    const path = join(dir, "identities.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      identities: [{ name: "testa", label: "Test A", configDir: "/tmp/testa", colour: "not-a-colour" }],
    }));
    expect(loadIdentitiesFile(path)).rejects.toBeInstanceOf(InvalidIdentitiesFileError);
  });

  test("unknown fields are still preserved through load+save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-colour-"));
    tempDirs.push(dir);
    const path = join(dir, "identities.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      identities: [{ name: "testa", label: "Test A", configDir: "/tmp/testa", colour: "#abc", futureField: 1 }],
    }));
    const loaded = await loadIdentitiesFile(path);
    expect(loaded.identities[0]!.colour).toBe("#abc");
    expect((loaded.identities[0] as unknown as Record<string, unknown>).futureField).toBe(1);
  });
});
