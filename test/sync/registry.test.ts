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
  globalMemoryProjection: "codex-developer-instructions",
  identitiesJsonPath: "/Users/example/.codex/identities.json",
  identitiesRootDir: "/Users/example/.codex/identities",
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
            configDir: "/Users/example/.codex/identities/identity-a",
            directories: ["/Users/example/Projects/*", "/srv/shared"],
          },
        ],
        chromeProfileOverrides: [
          { directories: ["/Users/example/Projects/Client/*"], targetIdentity: "identity-a" },
        ],
      },
      cfg,
      "/Users/example",
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
            configDir: "/home/example/.codex/identities/identity-a",
            directories: ["/home/example/Projects/*"],
          },
          { name: "custom", label: "Custom", configDir: "/srv/ais/custom" },
        ],
      },
      cfg,
      "/Users/example",
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
      name: "host-a-legacy",
      label: "Host A Legacy",
      description: "Preserved pre-AIS Codex sessions from host-a",
      configDir: "~/.codex/identities/host-a-legacy",
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
            name: "host-a-legacy",
            label: "Host A Legacy",
            description: "Preserved pre-AIS Codex sessions from host-a",
            configDir: "~/.codex/identities/host-a-legacy",
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

describe("mergeRegistryConflict retirement", () => {
  async function merge(
    live: Record<string, unknown>,
    previous: Record<string, unknown>,
    liveIsNewer: boolean,
  ): Promise<Record<string, unknown>> {
    const dir = await mkdtemp(join(tmpdir(), "ais-registry-retire-"));
    tempDirs.push(dir);
    const livePath = join(dir, "live.json");
    const previousPath = join(dir, "previous.json");
    const wrap = (identity: Record<string, unknown>) =>
      JSON.stringify({ version: 1, identities: [{ name: "old-team", label: "Old", configDir: "~/.codex/identities/old-team", ...identity }] });
    await Bun.write(livePath, wrap(live));
    await Bun.write(previousPath, wrap(previous));
    await utimes(previousPath, new Date(liveIsNewer ? 1_000 : 2_000), new Date(liveIsNewer ? 1_000 : 2_000));
    await utimes(livePath, new Date(liveIsNewer ? 2_000 : 1_000), new Date(liveIsNewer ? 2_000 : 1_000));
    await mergeRegistryConflict(livePath, previousPath);
    return (await Bun.file(livePath).json()).identities[0];
  }

  const retired = { retired: true, retiredAt: "2026-03-01T00:00:00.000Z" };

  test("a retirement on the older file is not resurrected by a newer unrelated edit", async () => {
    const merged = await merge({ label: "Renamed" }, retired, true);
    expect(merged).toMatchObject({ label: "Renamed", retired: true, retiredAt: retired.retiredAt });
    const reverse = await merge(retired, { label: "Renamed" }, false);
    expect(reverse).toMatchObject({ retired: true, retiredAt: retired.retiredAt });
  });

  test("a newer unretire wins and removes the retired fields", async () => {
    const unretired = { unretiredAt: "2026-04-01T00:00:00.000Z" };
    // Primary (newer file) holds the older retirement; secondary holds the newer unretire.
    const merged = await merge(retired, unretired, true);
    expect(merged.retired).toBeUndefined();
    expect(merged.retiredAt).toBeUndefined();
    expect(merged.unretiredAt).toBe(unretired.unretiredAt);
  });

  test("a newer retire after an older unretire wins and drops unretiredAt", async () => {
    const merged = await merge(
      { unretiredAt: "2026-02-01T00:00:00.000Z" },
      { retired: true, retiredAt: "2026-05-01T00:00:00.000Z" },
      true,
    );
    expect(merged).toMatchObject({ retired: true, retiredAt: "2026-05-01T00:00:00.000Z" });
    expect(merged.unretiredAt).toBeUndefined();
  });

  test("with no events on either side nothing is added", async () => {
    const merged = await merge({}, {}, true);
    expect(merged.retired).toBeUndefined();
    expect(merged.retiredAt).toBeUndefined();
    expect(merged.unretiredAt).toBeUndefined();
  });
});

