import { describe, expect, test } from "bun:test";
import { resolveIdentity, type ResolveDeps } from "../src/identities/resolve.ts";
import { matchDirectory } from "../src/identities/match.ts";
import { NonInteractiveResolutionError, UnknownIdentityError, UnknownPoolError } from "../src/identities/errors.ts";
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

const SINGLE_CFG: ToolConfig = {
  toolName: "pi",
  realBinaryName: "pi",
  envVarName: "PI_CODING_AGENT_DIR",
  globalMemoryProjection: "pi-append-file",
  singleInstanceDir: "/tmp/does-not-exist/pi-agent",
  identitiesJsonPath: "/tmp/does-not-exist/identities.json",
  identitiesRootDir: "/tmp/does-not-exist/identities",
};

describe("single-instance resolution (pi)", () => {
  test("never prompts and never errors on no-match: falls back to the shared instance dir", async () => {
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/tmp/does-not-exist/unrelated", env: {}, nonInteractiveHint: false },
      fakeDeps(),
    );
    expect(result.source).toBe("single-instance");
    expect(result.identity).toBeUndefined();
    expect(result.configDirValue).toBe("/tmp/does-not-exist/pi-agent");
  });

  test("an explicit --identity seeds the in-app default but keeps the shared instance dir", async () => {
    const result = await resolveIdentity(
      SINGLE_CFG,
      { explicitIdentityFlag: "w", cwd: "/x", env: {} },
      fakeDeps(),
    );
    expect(result.source).toBe("flag");
    expect(result.identity?.name).toBe("work");
    expect(result.configDirValue).toBe("/tmp/does-not-exist/pi-agent");
  });

  test("an unknown --identity still throws UnknownIdentityError", async () => {
    await expect(
      resolveIdentity(SINGLE_CFG, { explicitIdentityFlag: "nope", cwd: "/x", env: {} }, fakeDeps()),
    ).rejects.toThrow(UnknownIdentityError);
  });

  test("a preset env var overrides the whole instance dir", async () => {
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/x", env: { PI_CODING_AGENT_DIR: "/custom/instance" } },
      fakeDeps(),
    );
    expect(result.source).toBe("env");
    expect(result.configDirValue).toBe("/custom/instance");
    expect(result.identity).toBeUndefined();
  });

  test("a directory match seeds the default identity without changing the launch dir", async () => {
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/tmp/does-not-exist/proj/anything", env: {} },
      fakeDeps(),
    );
    expect(result.source).toBe("directory-match");
    expect(result.identity?.name).toBe("work");
    expect(result.configDirValue).toBe("/tmp/does-not-exist/pi-agent");
  });

  test("an interactive TTY with no match STILL never prompts (no NonInteractiveResolutionError, no picker)", async () => {
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/tmp/does-not-exist/unrelated", env: {} },
      fakeDeps({ isInteractive: () => true }),
    );
    expect(result.source).toBe("single-instance");
    expect(result.identity).toBeUndefined();
  });

  test("an active pool makes an unresolved interactive pi launch offer pool selection and use its config dir", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/unmatched", env: {} },
      fakeDeps({
        loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
        isInteractive: () => true,
        promptForIdentity: async () => ({ identity: pool, created: false }),
      }),
    );
    expect(result.source).toBe("interactive-existing");
    expect(result.identity?.name).toBe("pi-team-pool");
    expect(result.configDirValue).toBe(pool.configDir);
  });

  test("a pool-enabled pi launch keeps ordinary identities on the shared instance dir", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/unmatched", env: {} },
      fakeDeps({
        loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
        isInteractive: () => true,
        promptForIdentity: async () => ({ identity: IDENTITIES[0]!, created: false }),
      }),
    );
    expect(result.identity?.name).toBe("work");
    expect(result.configDirValue).toBe(SINGLE_CFG.singleInstanceDir!);
  });

  test("an explicit pi pool uses the pool config dir while explicit ordinary identities stay shared", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const deps = fakeDeps({ loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }) });
    const selectedPool = await resolveIdentity(
      SINGLE_CFG,
      { explicitPoolFlag: "pi-team-pool", cwd: "/x", env: {} },
      deps,
    );
    expect(selectedPool.configDirValue).toBe(pool.configDir);

    const selectedPoolAsIdentity = await resolveIdentity(
      SINGLE_CFG,
      { explicitIdentityFlag: "pi-team-pool", cwd: "/x", env: {} },
      deps,
    );
    expect(selectedPoolAsIdentity.configDirValue).toBe(pool.configDir);

    const selectedIdentity = await resolveIdentity(
      SINGLE_CFG,
      { explicitIdentityFlag: "work", cwd: "/x", env: {} },
      deps,
    );
    expect(selectedIdentity.configDirValue).toBe(SINGLE_CFG.singleInstanceDir!);
  });

  test("a duplicate pi pool record resolves to the canonical pool; ordinary identities stay shared", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const duplicate: Identity = {
      name: "pi-team-pool-dup",
      label: "Pi Team Pool Dup",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "personal" },
    };
    const deps = fakeDeps({
      loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool, duplicate] }),
    });
    const selectedPool = await resolveIdentity(
      SINGLE_CFG,
      { explicitPoolFlag: "pi-team-pool-dup", cwd: "/x", env: {} },
      deps,
    );
    expect(selectedPool.source).toBe("flag");
    expect(selectedPool.identity?.name).toBe("pi-team-pool");
    expect(selectedPool.configDirValue).toBe(pool.configDir);
    expect(selectedPool.identity?.swapPool?.active).toBe("work");

    const selectedIdentity = await resolveIdentity(
      SINGLE_CFG,
      { explicitIdentityFlag: "work", cwd: "/x", env: {} },
      deps,
    );
    expect(selectedIdentity.identity?.name).toBe("work");
    expect(selectedIdentity.configDirValue).toBe(SINGLE_CFG.singleInstanceDir!);
  });

  test("a directory match to a pi pool uses its pool config dir", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      directories: ["/tmp/does-not-exist/pi-fixture-dir/*"],
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/tmp/does-not-exist/pi-fixture-dir/subdir", env: {} },
      fakeDeps({
        loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
      }),
    );
    expect(result.identity?.name).toBe("pi-team-pool");
    expect(result.configDirValue).toBe(pool.configDir);
  });

  test("pool presence does not turn unresolved noninteractive Pi launches into errors", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const result = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/unmatched", env: {}, nonInteractiveHint: true },
      fakeDeps({
        loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
        isInteractive: () => true,
      }),
    );
    expect(result.source).toBe("single-instance");
    expect(result.configDirValue).toBe(SINGLE_CFG.singleInstanceDir!);
  });

  test("a bare pool picker bypasses pi env and directory defaults and refuses noninteractive use", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const deps = fakeDeps({
      loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
      isInteractive: () => true,
      promptForIdentity: async () => ({ identity: pool, created: false }),
    });
    const result = await resolveIdentity(
      SINGLE_CFG,
      {
        pickerMode: "pool",
        cwd: "/tmp/does-not-exist/proj/anything",
        env: { PI_CODING_AGENT_DIR: "/custom/instance" },
      },
      deps,
    );
    expect(result.source).toBe("interactive-existing");
    expect(result.identity?.name).toBe("pi-team-pool");
    expect(result.configDirValue).toBe(pool.configDir);

    await expect(
      resolveIdentity(
        SINGLE_CFG,
        { pickerMode: "pool", cwd: "/x", env: {}, nonInteractiveHint: true },
        fakeDeps({
          loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
          isInteractive: () => false,
        }),
      ),
    ).rejects.toThrow(NonInteractiveResolutionError);
  });

  test("a unique directory match and preset instance env keep precedence over pool prompting", async () => {
    const pool: Identity = {
      name: "pi-team-pool",
      label: "Pi Team Pool",
      configDir: "/tmp/does-not-exist/pi-team-pool",
      swapPool: { accounts: ["work", "personal"], active: "work" },
    };
    const deps = fakeDeps({
      loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
      isInteractive: () => true,
      promptForIdentity: async () => {
        throw new Error("a resolved identity must bypass the picker");
      },
    });
    const matched = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/tmp/does-not-exist/proj/anything", env: {} },
      deps,
    );
    expect(matched.identity?.name).toBe("work");
    expect(matched.configDirValue).toBe(SINGLE_CFG.singleInstanceDir!);

    const env = await resolveIdentity(
      SINGLE_CFG,
      { cwd: "/unmatched", env: { PI_CODING_AGENT_DIR: "/custom/instance" } },
      deps,
    );
    expect(env.source).toBe("env");
    expect(env.configDirValue).toBe("/custom/instance");
  });
});

describe("pool flags", () => {
  const pool: Identity = {
    name: "team-pool",
    label: "Team Pool",
    configDir: "/tmp/does-not-exist/team-pool",
    swapPool: { accounts: ["work", "personal"], active: "work" },
  };
  const withPool = (overrides: Partial<ResolveDeps> = {}) =>
    fakeDeps({
      loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool] }),
      ...overrides,
    });

  test("--pool=<name> launches the pool directly without prompting", async () => {
    const result = await resolveIdentity(
      CFG,
      { explicitPoolFlag: "team-pool", cwd: "/x", env: {} },
      withPool(),
    );
    expect(result.source).toBe("flag");
    expect(result.identity?.name).toBe("team-pool");
  });

  test("--pool naming a duplicate record resolves the canonical first pool", async () => {
    const duplicate: Identity = {
      name: "team-pool-dup",
      label: "Team Pool Dup",
      configDir: "/tmp/does-not-exist/team-pool",
      swapPool: { accounts: ["work", "personal"], active: "personal" },
    };
    const result = await resolveIdentity(
      CFG,
      { explicitPoolFlag: "team-pool-dup", cwd: "/x", env: {} },
      withPool({
        loadIdentitiesFile: async () => ({ version: 1, identities: [...IDENTITIES, pool, duplicate] }),
      }),
    );
    expect(result.source).toBe("flag");
    expect(result.identity?.name).toBe("team-pool");
    expect(result.configDirValue).toBe(pool.configDir);
    expect(result.identity?.swapPool?.active).toBe("work");
  });

  test("--pool=<unknown> errors and lists pool names", async () => {
    const run = resolveIdentity(CFG, { explicitPoolFlag: "nope", cwd: "/x", env: {} }, withPool());
    await expect(run).rejects.toThrow(UnknownPoolError);
    await expect(run).rejects.toThrow("Valid pools: team-pool");
  });

  test("bare --pool / --identity prompt with that single list, ignoring env and cwd match", async () => {
    for (const mode of ["pool", "identity"] as const) {
      let seen: unknown;
      const result = await resolveIdentity(
        CFG,
        {
          pickerMode: mode,
          cwd: "/tmp/does-not-exist/proj/anything",
          env: { CLAUDE_CONFIG_DIR: "/preset" },
        },
        withPool({
          isInteractive: () => true,
          promptForIdentity: (async (...args: unknown[]) => {
            seen = args[4];
            return { identity: pool, created: false };
          }) as never,
        }),
      );
      expect(seen).toBe(mode);
      expect(result.source).toBe("interactive-existing");
    }
  });
});
