import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentitiesFile, parseIdentitiesFile } from "../src/identities/store.ts";
import { InvalidIdentitiesFileError } from "../src/identities/errors.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseFile(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    identities: [{ name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal", ...extra }],
  };
}

describe("parseIdentitiesFile — chromeProfileOverrides", () => {
  test("accepts a well-formed override list", () => {
    const parsed = parseIdentitiesFile({
      ...baseFile(),
      chromeProfileOverrides: [
        { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a", label: "Client X" },
      ],
    });
    expect(parsed.chromeProfileOverrides).toMatchObject([
      { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a" },
    ]);
  });

  test("rejects a non-array chromeProfileOverrides", () => {
    expect(() => parseIdentitiesFile({ ...baseFile(), chromeProfileOverrides: {} })).toThrow(
      InvalidIdentitiesFileError,
    );
  });

  test("rejects an override with an empty directories list", () => {
    expect(() =>
      parseIdentitiesFile({
        ...baseFile(),
        chromeProfileOverrides: [{ directories: [], targetIdentity: "identity-a" }],
      }),
    ).toThrow(InvalidIdentitiesFileError);
  });

  test("rejects an override with an invalid directory pattern", () => {
    expect(() =>
      parseIdentitiesFile({
        ...baseFile(),
        chromeProfileOverrides: [{ directories: ["/tmp/does-not-exist/fo*o"], targetIdentity: "identity-a" }],
      }),
    ).toThrow(InvalidIdentitiesFileError);
  });

  test("rejects an override missing targetIdentity", () => {
    expect(() =>
      parseIdentitiesFile({
        ...baseFile(),
        chromeProfileOverrides: [{ directories: ["/tmp/does-not-exist/client-x/*"] }],
      }),
    ).toThrow(InvalidIdentitiesFileError);
  });
});

describe("loadIdentitiesFile", () => {
  test("expands a portable configDir before returning it to consumers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-store-"));
    tempDirs.push(dir);
    const path = join(dir, "identities.json");
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        identities: [{ name: "personal", label: "Personal", configDir: "~/.codex/identities/personal" }],
      }),
    );

    const loaded = await loadIdentitiesFile(path);

    expect(loaded.identities[0]?.configDir).not.toContain("~");
    expect(loaded.identities[0]?.configDir).toEndWith("/.codex/identities/personal");
  });

  test("keeps parseIdentitiesFile pure and preserves the portable on-disk value", () => {
    const parsed = parseIdentitiesFile({
      version: 1,
      identities: [{ name: "personal", label: "Personal", configDir: "~/.codex/identities/personal" }],
    });

    expect(parsed.identities[0]?.configDir).toBe("~/.codex/identities/personal");
  });
});

describe("retired identity fields", () => {
  test("round-trips through save and load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-retired-"));
    tempDirs.push(dir);
    const path = join(dir, "identities.json");
    const { saveIdentitiesFile } = await import("../src/identities/store.ts");
    await saveIdentitiesFile(
      path,
      parseIdentitiesFile(
        baseFile({ retired: true, retiredAt: "2026-02-01T00:00:00.000Z", unretiredAt: "2026-01-01T00:00:00.000Z" }),
      ),
    );
    const loaded = await loadIdentitiesFile(path);
    expect(loaded.identities[0]).toMatchObject({
      retired: true,
      retiredAt: "2026-02-01T00:00:00.000Z",
      unretiredAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("absent means active", () => {
    expect(parseIdentitiesFile(baseFile()).identities[0]!.retired).toBeUndefined();
  });

  test("rejects invalid types", () => {
    expect(() => parseIdentitiesFile(baseFile({ retired: "yes" }))).toThrow(InvalidIdentitiesFileError);
    expect(() => parseIdentitiesFile(baseFile({ retiredAt: 5 }))).toThrow(InvalidIdentitiesFileError);
    expect(() => parseIdentitiesFile(baseFile({ retiredAt: "not a date" }))).toThrow(InvalidIdentitiesFileError);
    expect(() => parseIdentitiesFile(baseFile({ unretiredAt: "nope" }))).toThrow(InvalidIdentitiesFileError);
  });
});
