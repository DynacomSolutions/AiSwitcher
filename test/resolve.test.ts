import { describe, expect, test } from "bun:test";
import { resolveIdentity, type ResolveDeps } from "../src/identities/resolve.ts";
import { matchDirectory } from "../src/identities/match.ts";
import { NonInteractiveResolutionError, UnknownIdentityError } from "../src/identities/errors.ts";
import type { Identity, IdentitiesFile, ToolConfig } from "../src/identities/types.ts";

const CFG: ToolConfig = {
  toolName: "claude",
  realBinaryName: "claude",
  envVarName: "CLAUDE_CONFIG_DIR",
  globalMemoryProjection: "claude-append-file",
  identitiesJsonPath: "/tmp/does-not-exist/identities.json",
  identitiesRootDir: "/tmp/does-not-exist/identities",
};

const IDENTITIES: Identity[] = [
  {
    name: "work",
    label: "Work",
    configDir: "/tmp/does-not-exist/work",
    directories: ["/tmp/does-not-exist/proj/*"],
    aliases: ["w"],
  },
  { name: "personal", label: "Personal", configDir: "/tmp/does-not-exist/personal" },
];

function fakeDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  const file: IdentitiesFile = { version: 1, identities: IDENTITIES };
  return {
    loadIdentitiesFile: async () => file,
    saveIdentitiesFile: async () => {},
    matchDirectory,
    promptForIdentity: async () => {
      throw new Error("promptForIdentity should not be called in this test");
    },
    isInteractive: () => false,
    ...overrides,
  };
}

describe("resolveIdentity precedence chain", () => {
  test("(a) explicit --identity flag wins outright", async () => {
    const result = await resolveIdentity(
      CFG,
      { explicitIdentityFlag: "personal", cwd: "/tmp/does-not-exist/proj/anything", env: {} },
      fakeDeps(),
    );
    expect(result.source).toBe("flag");
    expect(result.identity?.name).toBe("personal");
  });

  test("(a) explicit --identity flag resolves via alias", async () => {
    const result = await resolveIdentity(
      CFG,
      { explicitIdentityFlag: "w", cwd: "/tmp/does-not-exist/unrelated", env: {} },
      fakeDeps(),
    );
    expect(result.source).toBe("flag");
    expect(result.identity?.name).toBe("work");
  });

  test("(a) unknown --identity flag throws UnknownIdentityError", async () => {
    await expect(
      resolveIdentity(CFG, { explicitIdentityFlag: "nope", cwd: "/x", env: {} }, fakeDeps()),
    ).rejects.toThrow(UnknownIdentityError);
  });

  test("(b) a preset env var wins over directory match, skipping lookup entirely", async () => {
    const deps = fakeDeps({
      loadIdentitiesFile: async () => {
        throw new Error("should not load identities.json when env var is already set");
      },
    });
    const result = await resolveIdentity(
      CFG,
      { cwd: "/tmp/does-not-exist/proj/anything", env: { CLAUDE_CONFIG_DIR: "/some/inherited/dir" } },
      deps,
    );
    expect(result.source).toBe("env");
    expect(result.configDirValue).toBe("/some/inherited/dir");
    expect(result.identity).toBeUndefined();
  });

  test("(c) unique directory match resolves silently, no prompt", async () => {
    const result = await resolveIdentity(
      CFG,
      { cwd: "/tmp/does-not-exist/proj/nested/deep", env: {} },
      fakeDeps(),
    );
    expect(result.source).toBe("directory-match");
    expect(result.identity?.name).toBe("work");
  });

  test("(d) no match, non-interactive -> throws NonInteractiveResolutionError, never prompts", async () => {
    await expect(
      resolveIdentity(
        CFG,
        { cwd: "/tmp/does-not-exist/unrelated", env: {}, nonInteractiveHint: true },
        fakeDeps({ isInteractive: () => true }),
      ),
    ).rejects.toThrow(NonInteractiveResolutionError);
  });

  test("(d) no match, non-interactive via TTY check alone -> throws", async () => {
    await expect(
      resolveIdentity(CFG, { cwd: "/tmp/does-not-exist/unrelated", env: {} }, fakeDeps({ isInteractive: () => false })),
    ).rejects.toThrow(NonInteractiveResolutionError);
  });

  test("(d) no match, interactive -> falls through to the prompt", async () => {
    const picked = IDENTITIES[1]!;
    const result = await resolveIdentity(
      CFG,
      { cwd: "/tmp/does-not-exist/unrelated", env: {} },
      fakeDeps({
        isInteractive: () => true,
        promptForIdentity: async () => ({ identity: picked, created: false }),
      }),
    );
    expect(result.source).toBe("interactive-existing");
    expect(result.identity?.name).toBe("personal");
  });

  test("(d) prompt reports a freshly created identity as interactive-created", async () => {
    const created: Identity = { name: "new-one", label: "New One", configDir: "/tmp/does-not-exist/new-one" };
    const result = await resolveIdentity(
      CFG,
      { cwd: "/tmp/does-not-exist/unrelated", env: {} },
      fakeDeps({
        isInteractive: () => true,
        promptForIdentity: async () => ({ identity: created, created: true }),
      }),
    );
    expect(result.source).toBe("interactive-created");
  });
});
