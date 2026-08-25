import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import {
  isSyntheticLegacySessionContainer,
  mergeRegistryConflict,
  portableIdentitiesFile,
} from "../../src/sync/registry.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const cfg: ToolConfig = {
  toolName: "codex",
  realBinaryName: "codex",
  envVarName: "CODEX_HOME",
  identitiesJsonPath: "/Users/alice/.codex/identities.json",
  identitiesRootDir: "/Users/alice/.codex/identities",
};

describe("portableIdentitiesFile", () => {
  test("rebases standard macOS profile and project paths to tilde form", () => {
    const result = portableIdentitiesFile(
      {
        version: 1,
        identities: [
          {
            name: "identity-a",
            label: "Identity A",
            configDir: "/Users/alice/.codex/identities/identity-a",
            directories: ["/Users/alice/Projects/*", "/srv/shared"],
          },
        ],
        chromeProfileOverrides: [
          { directories: ["/Users/alice/Projects/Client/*"], targetIdentity: "identity-a" },
        ],
      },
      cfg,
      "/Users/alice",
    );

    expect(result.identities[0]?.configDir).toBe("~/.codex/identities/identity-a");
    expect(result.identities[0]?.directories).toEqual(["~/Projects/*", "/srv/shared"]);
    expect(result.chromeProfileOverrides?.[0]?.directories).toEqual(["~/Projects/Client/*"]);
  });

  test("rebases a pulled Linux registry while preserving a custom configDir", () => {
    const result = portableIdentitiesFile(
      {
        version: 1,
        identities: [
          {
            name: "identity-a",
            label: "Identity A",
            configDir: "/home/bob/.codex/identities/identity-a",
            directories: ["/home/bob/Projects/*"],
          },
          { name: "custom", label: "Custom", configDir: "/srv/ais/custom" },
        ],
      },
      cfg,
      "/Users/alice",
    );

    expect(result.identities[0]).toMatchObject({
      configDir: "~/.codex/identities/identity-a",
      directories: ["~/Projects/*"],
    });
    expect(result.identities[1]?.configDir).toBe("/srv/ais/custom");
  });
});

describe("isSyntheticLegacySessionContainer", () => {
  test("matches the exact pre-AIS archive marker, not an ordinary legacy-named identity", () => {
    expect(isSyntheticLegacySessionContainer({
      name: "remote1-legacy",
      label: "HQ0 Legacy",
      description: "Preserved pre-AIS Codex sessions from remote1",
      configDir: "~/.codex/identities/remote1-legacy",
    })).toBe(true);
    expect(isSyntheticLegacySessionContainer({
      name: "customer-legacy",
      label: "Customer Legacy",
      configDir: "~/.codex/identities/customer-legacy",
    })).toBe(false);
  });
});

describe("mergeRegistryConflict", () => {
  test("unions identities and list fields while retaining newer scalar values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ais-registry-merge-"));
    tempDirs.push(dir);
    const livePath = join(dir, "live.json");
    const previousPath = join(dir, "previous.json");
    await Bun.write(
      livePath,
      JSON.stringify({
        version: 1,
        identities: [
          { name: "shared", label: "Remote", configDir: "~/.codex/identities/shared", aliases: ["remote"] },
          { name: "remote-only", label: "Remote only", configDir: "~/.codex/identities/remote-only" },
          {
            name: "remote1-legacy",
            label: "HQ0 Legacy",
            description: "Preserved pre-AIS Codex sessions from remote1",
            configDir: "~/.codex/identities/remote1-legacy",
          },
        ],
      }),
    );
    await Bun.write(
      previousPath,
      JSON.stringify({
        version: 1,
        identities: [
          {
            name: "shared",
            label: "Local",
            configDir: "~/.codex/identities/shared",
            aliases: ["local"],
            directories: ["~/Projects/Local/*"],
          },
          { name: "local-only", label: "Local only", configDir: "~/.codex/identities/local-only" },
        ],
      }),
    );
    await utimes(previousPath, new Date(1_000), new Date(1_000));
    await utimes(livePath, new Date(2_000), new Date(2_000));

    expect(await mergeRegistryConflict(livePath, previousPath)).toBe(true);
    const merged = await Bun.file(livePath).json();
    expect(merged.identities.map((identity: { name: string }) => identity.name)).toEqual([
      "shared",
      "remote-only",
      "local-only",
    ]);
    expect(merged.identities[0]).toMatchObject({
      label: "Remote",
      aliases: ["remote", "local"],
      directories: ["~/Projects/Local/*"],
    });
  });
});
