import { describe, expect, test } from "bun:test";
import {
  addAlias,
  addChromeOverride,
  addDirectory,
  createIdentity,
  deleteIdentity,
  removeAlias,
  removeChromeOverride,
  removeDirectory,
  updateIdentity,
} from "../../src/cli/identities/actions.ts";
import { CliUsageError } from "../../src/cli/errors.ts";
import { InvalidIdentitiesFileError } from "../../src/identities/errors.ts";
import type { IdentitiesFile } from "../../src/identities/types.ts";

function baseFile(): IdentitiesFile {
  return {
    version: 1,
    identities: [
      { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
      { name: "work", label: "Work", configDir: "/tmp/does-not-exist/work", aliases: ["w"] },
    ],
  };
}

describe("createIdentity", () => {
  test("adds a well-formed identity", () => {
    const file = baseFile();
    const identity = createIdentity(file, {
      name: "identity-a",
      label: "Identity A",
      configDir: "/tmp/does-not-exist/identity-a",
      directories: ["/tmp/does-not-exist/identity-a/*"],
      aliases: ["id-a"],
    });
    expect(identity.name).toBe("identity-a");
    expect(file.identities).toHaveLength(3);
    expect(file.identities.at(-1)).toMatchObject({ name: "identity-a", aliases: ["id-a"] });
  });

  test("rejects a non-kebab-case name", () => {
    expect(() =>
      createIdentity(baseFile(), { name: "Identity A", label: "Identity A", configDir: "/tmp/x" }),
    ).toThrow(CliUsageError);
  });

  test("rejects a name that collides with an existing name or alias", () => {
    expect(() => createIdentity(baseFile(), { name: "work", label: "Work 2", configDir: "/tmp/x" })).toThrow(
      CliUsageError,
    );
    expect(() => createIdentity(baseFile(), { name: "w", label: "W", configDir: "/tmp/x" })).toThrow(
      CliUsageError,
    );
  });

  test("rejects an invalid directory pattern", () => {
    expect(() =>
      createIdentity(baseFile(), {
        name: "identity-a",
        label: "Identity A",
        configDir: "/tmp/x",
        directories: ["/tmp/fo*o"],
      }),
    ).toThrow(InvalidIdentitiesFileError);
  });

  test("rejects an empty label or configDir", () => {
    expect(() => createIdentity(baseFile(), { name: "identity-a", label: "", configDir: "/tmp/x" })).toThrow(
      CliUsageError,
    );
    expect(() => createIdentity(baseFile(), { name: "identity-a", label: "Identity A", configDir: "" })).toThrow(
      CliUsageError,
    );
  });

  test("rejects a duplicate alias within the same call, and an alias equal to the new name", () => {
    expect(() =>
      createIdentity(baseFile(), { name: "identity-a", label: "Identity A", configDir: "/tmp/x", aliases: ["a", "a"] }),
    ).toThrow(CliUsageError);
    expect(() =>
      createIdentity(baseFile(), {
        name: "identity-a",
        label: "Identity A",
        configDir: "/tmp/x",
        aliases: ["identity-a"],
      }),
    ).toThrow(CliUsageError);
  });
});

describe("updateIdentity", () => {
  test("updates only the supplied scalar fields", () => {
    const file = baseFile();
    const identity = updateIdentity(file, "personal", { label: "Personal (me)" });
    expect(identity.label).toBe("Personal (me)");
    expect(identity.configDir).toBe("/tmp/does-not-exist/personal");
  });

  test("resolves by alias", () => {
    const file = baseFile();
    const identity = updateIdentity(file, "w", { description: "day job" });
    expect(identity.name).toBe("work");
    expect(identity.description).toBe("day job");
  });

  test("throws on unknown identity", () => {
    expect(() => updateIdentity(baseFile(), "ghost", { label: "x" })).toThrow(CliUsageError);
  });

  test("rejects an explicit empty label or configDir rather than persisting an unloadable identity", () => {
    expect(() => updateIdentity(baseFile(), "personal", { label: "" })).toThrow(CliUsageError);
    expect(() => updateIdentity(baseFile(), "personal", { configDir: "" })).toThrow(CliUsageError);
  });
});

describe("deleteIdentity", () => {
  test("removes the identity from the registry only", () => {
    const file = baseFile();
    deleteIdentity(file, "personal");
    expect(file.identities.map((i) => i.name)).toEqual(["work"]);
  });
});

describe("addDirectory / removeDirectory", () => {
  test("adds a pattern, is idempotent, and validates grammar", () => {
    const file = baseFile();
    addDirectory(file, "personal", "/tmp/does-not-exist/proj/*");
    addDirectory(file, "personal", "/tmp/does-not-exist/proj/*");
    const identity = file.identities.find((i) => i.name === "personal")!;
    expect(identity.directories).toEqual(["/tmp/does-not-exist/proj/*"]);

    expect(() => addDirectory(file, "personal", "/tmp/fo*o")).toThrow(InvalidIdentitiesFileError);
  });

  test("removes a pattern and cleans up an empty array", () => {
    const file = baseFile();
    addDirectory(file, "personal", "/tmp/does-not-exist/proj/*");
    const identity = removeDirectory(file, "personal", "/tmp/does-not-exist/proj/*");
    expect(identity.directories).toBeUndefined();
  });
});

describe("addAlias / removeAlias", () => {
  test("adds an alias and rejects a colliding one", () => {
    const file = baseFile();
    addAlias(file, "personal", "me");
    expect(file.identities.find((i) => i.name === "personal")?.aliases).toEqual(["me"]);
    expect(() => addAlias(file, "personal", "work")).toThrow(CliUsageError);
  });

  test("removes an alias and cleans up an empty array", () => {
    const file = baseFile();
    const identity = removeAlias(file, "work", "w");
    expect(identity.aliases).toBeUndefined();
  });
});

describe("addChromeOverride / removeChromeOverride", () => {
  test("adds an override and validates its directory patterns", () => {
    const file = baseFile();
    addChromeOverride(file, { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "identity-a" });
    expect(file.chromeProfileOverrides).toHaveLength(1);

    expect(() =>
      addChromeOverride(file, { directories: ["/tmp/fo*o"], targetIdentity: "identity-a" }),
    ).toThrow(InvalidIdentitiesFileError);
  });

  test("rejects an empty targetIdentity or an empty directories list", () => {
    const file = baseFile();
    expect(() =>
      addChromeOverride(file, { directories: ["/tmp/does-not-exist/client-x/*"], targetIdentity: "" }),
    ).toThrow(CliUsageError);
    expect(() => addChromeOverride(file, { directories: [], targetIdentity: "identity-a" })).toThrow(CliUsageError);
  });

  test("removes by index and cleans up an empty array", () => {
    const file = baseFile();
    addChromeOverride(file, { directories: ["/tmp/does-not-exist/a/*"], targetIdentity: "personal" });
    addChromeOverride(file, { directories: ["/tmp/does-not-exist/b/*"], targetIdentity: "identity-a" });
    removeChromeOverride(file, 0);
    expect(file.chromeProfileOverrides).toMatchObject([{ targetIdentity: "identity-a" }]);
    removeChromeOverride(file, 0);
    expect(file.chromeProfileOverrides).toBeUndefined();
  });

  test("throws on an out-of-range index", () => {
    const file = baseFile();
    expect(() => removeChromeOverride(file, 0)).toThrow(CliUsageError);
  });
});
