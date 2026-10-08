import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetiredIdentityError } from "../src/identities/errors.ts";
import { matchDirectory } from "../src/identities/match.ts";
import { resolveChromeMcpTarget } from "../src/identities/chrome-profile.ts";
import { reconcileNativeProviderStores, reconcilePiOAuthStores } from "../src/identities/oauth-reconcile.ts";
import { refreshIdentityOAuthGrant, writeGrantThroughStores } from "../src/identities/oauth-refresh.ts";
import { resolveIdentity, resolveSingleInstanceIdentity, type ResolveDeps } from "../src/identities/resolve.ts";
import type { IdentitiesFile, Identity, ToolConfig } from "../src/identities/types.ts";
import { resolveSyncSources } from "../src/cli/auth/pi-sync.ts";
import { collectDoctorTargets } from "../src/cli/doctor/collect.ts";
import { collectLimitTargets } from "../src/cli/limits/collect.ts";
import { CliUsageError } from "../src/cli/errors.ts";
import { collectResumeTargets } from "../src/cli/resume/collect.ts";
import { launchResume } from "../src/cli/resume/launch.ts";
import { AuthRefreshScheduler } from "../src/server/auth-refresh.ts";
import { resolveGuardAccounts } from "../src/spend/accounts.ts";
import { buildIdentityListings, matchIdentityForCwd, parseRegistryIdentities, pickDefaultIdentityName } from "../src/pi-extension/ais-identity-extension.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CFG: ToolConfig = {
  toolName: "claude",
  realBinaryName: "claude",
  envVarName: "CLAUDE_CONFIG_DIR",
  globalMemoryProjection: "claude-append-file",
  identitiesJsonPath: "/tmp/does-not-exist/identities.json",
  identitiesRootDir: "/tmp/does-not-exist/identities",
};

const RETIRED_AT = "2026-10-01T00:00:00.000Z";

const IDENTITIES: Identity[] = [
  { name: "active", label: "Active", configDir: "/tmp/does-not-exist/active" },
  {
    name: "gone",
    label: "Gone",
    configDir: "/tmp/does-not-exist/gone",
    directories: ["/tmp/does-not-exist/gone-proj/*"],
    aliases: ["g"],
    retired: true,
    retiredAt: RETIRED_AT,
  },
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

async function makeRegistry(toolName: ToolConfig["toolName"], identities: unknown[]): Promise<ToolConfig> {
  const dir = await mkdtemp(join(tmpdir(), "ais-retired-test-"));
  tempDirs.push(dir);
  const identitiesJsonPath = join(dir, "identities.json");
  await writeFile(identitiesJsonPath, JSON.stringify({ version: 1, identities }));
  return { ...CFG, toolName, identitiesJsonPath, identitiesRootDir: join(dir, "identities") };
}

const REGISTRY_ENTRIES = [
  { name: "active", label: "Active", configDir: "/tmp/does-not-exist/active" },
  { name: "gone", label: "Gone", configDir: "/tmp/does-not-exist/gone", retired: true, retiredAt: RETIRED_AT },
];

describe("resolveIdentity refuses retired identities", () => {
  test("--identity naming a retired identity throws RetiredIdentityError", async () => {
    await expect(
      resolveIdentity(CFG, { explicitIdentityFlag: "gone", cwd: "/x", env: {} }, fakeDeps()),
    ).rejects.toThrow(RetiredIdentityError);
  });

  test("an alias of a retired identity is refused too, and the message names the unretire command", async () => {
    await expect(
      resolveIdentity(CFG, { explicitIdentityFlag: "g", cwd: "/x", env: {} }, fakeDeps()),
    ).rejects.toThrow('ais identities unretire gone --tool=claude');
  });

  test("a preset env var pointing at a retired configDir is refused", async () => {
    await expect(
      resolveIdentity(CFG, { cwd: "/x", env: { CLAUDE_CONFIG_DIR: "/tmp/does-not-exist/gone/" } }, fakeDeps()),
    ).rejects.toThrow(RetiredIdentityError);
  });

  test("a preset env var pointing elsewhere still passes through, even if the registry is unreadable", async () => {
    const result = await resolveIdentity(
      CFG,
      { cwd: "/x", env: { CLAUDE_CONFIG_DIR: "/tmp/does-not-exist/other" } },
      fakeDeps({
        loadIdentitiesFile: async () => {
          throw new Error("registry unreadable");
        },
      }),
    );
    expect(result.source).toBe("env");
  });

  test("a retired identity tying with an active one does not make the directory ambiguous", async () => {
    const identities: Identity[] = [
      { name: "active", label: "Active", configDir: "/tmp/does-not-exist/active", directories: ["/tmp/does-not-exist/shared/*"] },
      {
        name: "gone",
        label: "Gone",
        configDir: "/tmp/does-not-exist/gone",
        directories: ["/tmp/does-not-exist/shared/*"],
        retired: true,
        retiredAt: RETIRED_AT,
      },
    ];
    const file: IdentitiesFile = { version: 1, identities };
    const result = await resolveIdentity(
      CFG,
      { cwd: "/tmp/does-not-exist/shared/sub", env: {}, nonInteractiveHint: true },
      fakeDeps({ loadIdentitiesFile: async () => file }),
    );
    expect(result.identity?.name).toBe("active");
    expect(result.source).toBe("directory-match");
  });

  test("a directory match on a retired identity is refused, never silently switched", async () => {
    await expect(
      resolveIdentity(CFG, { cwd: "/tmp/does-not-exist/gone-proj/sub", env: {} }, fakeDeps()),
    ).rejects.toThrow(RetiredIdentityError);
  });

  test("activeIdentities (the picker filter) drops retired identities", async () => {
    const { activeIdentities } = await import("../src/identities/retired.ts");
    expect(activeIdentities(IDENTITIES).map((i) => i.name)).toEqual(["active"]);
  });
});

describe("resolveSingleInstanceIdentity (pi) and retired identities", () => {
  const piCfg: ToolConfig = { ...CFG, toolName: "pi", envVarName: "PI_CODING_AGENT_DIR", singleInstanceDir: "/tmp/does-not-exist/pi" };

  test("--identity naming a retired identity is refused", async () => {
    await expect(
      resolveSingleInstanceIdentity(piCfg, { explicitIdentityFlag: "gone", cwd: "/x", env: {} }, fakeDeps()),
    ).rejects.toThrow(RetiredIdentityError);
  });

  test("a retired directory match is ignored: the shared instance launches unseeded", async () => {
    const result = await resolveSingleInstanceIdentity(
      piCfg,
      { cwd: "/tmp/does-not-exist/gone-proj/sub", env: {} },
      fakeDeps(),
    );
    expect(result.identity).toBeUndefined();
    expect(result.source).toBe("single-instance");
  });
});

describe("chrome profile resolution", () => {
  const file: IdentitiesFile = {
    version: 1,
    identities: IDENTITIES,
    chromeProfileOverrides: [{ directories: ["/tmp/does-not-exist/gone-proj/*"], targetIdentity: "gone" }],
  };

  test("an override whose target is retired resolves to null (plain open)", () => {
    expect(resolveChromeMcpTarget("/tmp/does-not-exist/gone-proj/a", "/tmp/does-not-exist/active", file)).toBeNull();
  });

  test("a retired active identity resolves to null", () => {
    expect(resolveChromeMcpTarget("/tmp/does-not-exist/elsewhere", "/tmp/does-not-exist/gone", file)).toBeNull();
  });

  test("an active identity still resolves", () => {
    expect(resolveChromeMcpTarget("/tmp/does-not-exist/elsewhere", "/tmp/does-not-exist/active", file)).toMatchObject({
      identityName: "active",
    });
  });
});

describe("collectors skip retired identities", () => {
  test("limits: retired identity is not a target; naming it explicitly gives a clear retired error", async () => {
    const cfg = await makeRegistry("claude", REGISTRY_ENTRIES);
    expect((await collectLimitTargets(undefined, {}, [cfg])).map((t) => t.identity.name)).toEqual(["active"]);
    const err = await collectLimitTargets("gone", {}, [cfg]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliUsageError);
    expect((err as Error).message).toContain("retired");
  });

  test("doctor: retired identity is not probed", async () => {
    const cfg = await makeRegistry("claude", REGISTRY_ENTRIES);
    expect((await collectDoctorTargets({}, [cfg])).map((t) => t.identity.name)).toEqual(["active"]);
    await expect(collectDoctorTargets({ identity: "gone" }, [cfg])).rejects.toThrow("retired");
  });

  test("resume: retired sessions are excluded, and launchResume refuses as a safety net", async () => {
    const cfg = await makeRegistry("claude", REGISTRY_ENTRIES);
    expect((await collectResumeTargets({}, [cfg])).map((t) => t.identity.name)).toEqual(["active"]);
    await expect(collectResumeTargets({ identity: "gone" }, [cfg])).rejects.toThrow("retired");
    // History viewers opt in: the retired identity's sessions stay listable.
    expect((await collectResumeTargets({}, [cfg], { includeRetired: true })).map((t) => t.identity.name)).toEqual([
      "active",
      "gone",
    ]);
    expect(
      (await collectResumeTargets({ identity: "gone" }, [cfg], { includeRetired: true })).map((t) => t.identity.name),
    ).toEqual(["gone"]);
    await expect(
      launchResume({
        toolName: "claude",
        identity: IDENTITIES[1]!,
        sessionId: "s1",
        cwd: "/tmp/does-not-exist",
        lastActive: new Date(),
      } as unknown as Parameters<typeof launchResume>[0]),
    ).rejects.toThrow(RetiredIdentityError);
  });
});

describe("auth refresh", () => {
  test("daemon targets exclude retired identities and refreshNow refuses them", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "ais-retired-refresh-"));
    tempDirs.push(stateHome);
    let calls = 0;
    const scheduler = new AuthRefreshScheduler(
      0,
      {
        ali: async () => {
          calls += 1;
          return "ok";
        },
      },
      async () => IDENTITIES,
      stateHome,
    );
    expect((await scheduler.targets()).map((t) => t.identity.name)).toEqual(["active"]);
    await scheduler.tick();
    expect(calls).toBe(1);
    await expect(scheduler.refreshNow("ali", "gone")).rejects.toThrow("retired");
    expect(calls).toBe(1);
  });

  test("refreshIdentityOAuthGrant never calls the token endpoint for a retired identity", async () => {
    let fetched = false;
    const result = await refreshIdentityOAuthGrant("claude", IDENTITIES[1]!, {
      force: true,
      fetchImpl: (async () => {
        fetched = true;
        return new Response("{}");
      }) as never,
    });
    expect(fetched).toBe(false);
    expect(result.outcome).toBe("no-grant");
    expect(result.detail).toContain("retired");
  });

  test("writeGrantThroughStores writes nothing for a retired identity", async () => {
    const report = await writeGrantThroughStores("claude", IDENTITIES[1]!, { access_token: "x", refresh_token: "y" });
    expect(report).toEqual({ written: [], failed: [] });
  });
});

describe("oauth reconcile and pi credential sync", () => {
  const PI_GRANT = { anthropic: { type: "oauth", access: "synthetic-access-token", refresh: "synthetic-refresh-token", expires: 4_102_444_800_000 } };

  async function reconcileFixture(retired: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "ais-retired-reconcile-"));
    tempDirs.push(dir);
    const piDir = join(dir, "pi", "gone");
    const claudeDir = join(dir, "claude", "gone");
    await mkdir(piDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(piDir, "auth.json"), JSON.stringify(PI_GRANT));
    const mark = retired ? { retired: true, retiredAt: RETIRED_AT } : {};
    const piIdentity: Identity = { name: "gone", label: "Gone", configDir: piDir, ...mark };
    const claudeIdentity: Identity = { name: "gone", label: "Gone", configDir: claudeDir, ...mark };
    const registryPaths = { pi: join(dir, "pi.json"), claude: join(dir, "claude.json") };
    await writeFile(registryPaths.pi, JSON.stringify({ version: 1, identities: [piIdentity] }));
    await writeFile(registryPaths.claude, JSON.stringify({ version: 1, identities: [claudeIdentity] }));
    return { piIdentity, claudeIdentity, registryPaths, nativeCredentials: join(claudeDir, ".credentials.json") };
  }

  test("a retired pi identity has no pairings, though a same-named native identity exists", async () => {
    const control = await reconcileFixture(false);
    const active = await reconcilePiOAuthStores(control.piIdentity, { registryPaths: control.registryPaths });
    expect(active.entries.length).toBeGreaterThan(0);

    const retired = await reconcileFixture(true);
    const report = await reconcilePiOAuthStores(retired.piIdentity, { write: true, registryPaths: retired.registryPaths });
    expect(report.entries).toEqual([]);
  });

  test("a retired native identity is not restored from a same-named pi copy", async () => {
    const retired = await reconcileFixture(true);
    const entry = await reconcileNativeProviderStores("claude", retired.claudeIdentity, {
      write: true,
      registryPaths: retired.registryPaths,
    });
    expect(entry.status).toBe("single-copy");
    expect(entry.detail).toContain("retired");
    expect(await Bun.file(retired.nativeCredentials).exists()).toBe(false);

    // Control: the same setup, active, is paired with pi (not the retired short-circuit).
    const control = await reconcileFixture(false);
    const live = await reconcileNativeProviderStores("claude", control.claudeIdentity, { registryPaths: control.registryPaths });
    expect(live.detail ?? "").not.toContain("retired");
  });

  test("resolveSyncSources skips a retired flagged source and ignores retired same-named/only identities", async () => {
    const claude = await makeRegistry("claude", REGISTRY_ENTRIES);
    const codex = await makeRegistry("codex", [REGISTRY_ENTRIES[1]]);
    const out = await resolveSyncSources("gone", { claude: "gone" }, [
      ["claude", claude],
      ["codex", codex],
    ]);
    expect(out.resolved).toEqual([]);
    expect(out.skipped.join("\n")).toContain('claude identity "gone" is retired');
    expect(out.skipped.join("\n")).toContain("codex:");
  });

  test("resolveSyncSources still picks active sources", async () => {
    const claude = await makeRegistry("claude", REGISTRY_ENTRIES);
    const out = await resolveSyncSources("active", {}, [["claude", claude]]);
    expect(out.resolved.map((r) => r.via)).toEqual(["same-named identity"]);
  });
});

describe("spend guard accounts", () => {
  test("retired identities stay in their account so their local spend still counts", async () => {
    const cfg = await makeRegistry("codex", [
      { name: "mapped-one", label: "m", configDir: "/id/m" },
      { name: "mapped-two", label: "m2", configDir: "/id/m2", retired: true, retiredAt: RETIRED_AT },
    ]);
    const { accounts } = await resolveGuardAccounts([cfg], {
      readText: (path: string) => {
        if (path.endsWith("aws-profiles.json")) {
          return JSON.stringify({
            version: 1,
            identities: { "mapped-one": { profile: "p-one" }, "mapped-two": { profile: "p-two" } },
          });
        }
        if (path.endsWith("config")) {
          return "[profile p-one]\nsso_account_id = 123456789012\n[profile p-two]\nsso_account_id = 210987654321\n";
        }
        throw new Error(`unexpected ${path}`);
      },
      awsProfilesPath: "/x/aws-profiles.json",
      awsConfigPath: "/x/config",
    });
    expect(accounts).toHaveLength(2);
    const names = accounts.flatMap((a) => a.identities.map((i) => i.identity.name)).sort();
    expect(names).toEqual(["mapped-one", "mapped-two"]);
  });

  test("a shared account sums retired local spend; an all-retired account makes no live calls", async () => {
    const { runSpendGuardCycle } = await import("../src/spend/compute.ts");
    const mk = (name: string, retired: boolean): Identity => ({
      name,
      label: name,
      configDir: `/tmp/does-not-exist/${name}`,
      ...(retired ? { retired: true, retiredAt: RETIRED_AT } : {}),
    });
    let budgetCalls = 0;
    const budgets = {
      listBudgets: async (accountId: string) => {
        budgetCalls += 1;
        expect(accountId).toBe("111111111111");
        return [];
      },
      describeBudget: async () => {
        throw new Error("unexpected describeBudget");
      },
    };
    const result = await runSpendGuardCycle({
      accounts: [
        { accountId: "111111111111", profile: "p", identities: [
          { toolName: "claude", identity: mk("live", false) },
          { toolName: "claude", identity: mk("old", true) },
        ] },
        { accountId: "222222222222", profile: "q", identities: [{ toolName: "claude", identity: mk("old-two", true) }] },
      ],
      localEstimate: (_tool: string, configDir: string) => ({ usd: configDir.endsWith("/old") ? 7 : 3 }),
      budgets,
      costExplorer: { getCostAndUsage: async () => ({ ResultsByTime: [] }) } as never,
    } as never);
    expect(Object.keys(result.states)).toEqual(["111111111111"]);
    expect(result.states["111111111111"]?.localEstimateUsd).toBe(10);
    expect(budgetCalls).toBe(1);
  });
});

describe("pi in-app switcher", () => {
  const registry = {
    version: 1,
    identities: [
      { name: "gone", label: "Gone", configDir: "/tmp/does-not-exist/gone", directories: ["/tmp/does-not-exist/p/*"], retired: true },
      { name: "active", label: "Active", configDir: "/tmp/does-not-exist/active" },
    ],
  };

  test("parseRegistryIdentities carries the retired flag", () => {
    expect(parseRegistryIdentities(registry)?.map((i) => i.retired === true)).toEqual([true, false]);
  });

  test("listings, directory matching and default selection exclude retired identities", () => {
    const parsed = parseRegistryIdentities(registry)!;
    expect(buildIdentityListings(registry, undefined).listings.map((l) => l.name)).toEqual(["active"]);
    expect(matchIdentityForCwd(parsed, "/tmp/does-not-exist/p/x", "/tmp/does-not-exist/home")).toBeUndefined();
    expect(
      pickDefaultIdentityName({ identities: parsed, envMarker: "gone", persisted: "gone", cwdMatch: "gone" }),
    ).toBe("active");
  });
});
