import { describe, expect, test } from "bun:test";
import { activeParentSession, detectNonInteractiveHint, parseCliArgs, resolveNestedIdentity, resolveParentLaunchContext, stripOwnFlags } from "../src/shared/cli-args.ts";
import { resolveIdentity, type ResolveDeps } from "../src/identities/resolve.ts";
import { matchDirectory } from "../src/identities/match.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../src/identities/tool-configs.ts";
import type { IdentitiesFile } from "../src/identities/types.ts";

describe("stripOwnFlags", () => {
  test("--identity=<name> is stripped and captured", () => {
    const result = stripOwnFlags(["--identity=work", "--print", "hello"]);
    expect(result.identityFlag).toBe("work");
    expect(result.cleanedArgv).toEqual(["--print", "hello"]);
  });

  test("--id=<name> shorthand is equivalent to --identity=<name>", () => {
    const result = stripOwnFlags(["--id=work", "--print", "hello"]);
    expect(result.identityFlag).toBe("work");
    expect(result.cleanedArgv).toEqual(["--print", "hello"]);
  });

  test("--desktop is stripped and flagged", () => {
    const result = stripOwnFlags(["--id=work", "--desktop"]);
    expect(result.desktopFlag).toBe(true);
    expect(result.cleanedArgv).toEqual([]);
  });

  test("codex's native -i/--image is left untouched (only --id is ours)", () => {
    const result = stripOwnFlags(["-i", "photo.png", "describe this"]);
    expect(result.identityFlag).toBeUndefined();
    expect(result.cleanedArgv).toEqual(["-i", "photo.png", "describe this"]);
  });

  test("after a bare -- end-of-options token, our flags are forwarded literally", () => {
    const result = stripOwnFlags(["--", "--identity=foo", "--id=bar"]);
    expect(result.identityFlag).toBeUndefined();
    expect(result.cleanedArgv).toEqual(["--", "--identity=foo", "--id=bar"]);
  });
});

describe("stripOwnFlags pool and bare picker flags", () => {
  test("--pool=<name> is stripped for claude and carries the name", () => {
    const r = stripOwnFlags(["--pool=team", "hello"], { pools: true });
    expect(r.poolFlag).toBe("team");
    expect(r.cleanedArgv).toEqual(["hello"]);
  });

  test("bare --pool and bare --identity select a single list", () => {
    expect(stripOwnFlags(["--pool", "x"], { pools: true }).pickerMode).toBe("pool");
    expect(stripOwnFlags(["--pool", "x"], { pools: true }).cleanedArgv).toEqual(["x"]);
    expect(stripOwnFlags(["--identity"]).pickerMode).toBe("identity");
    expect(stripOwnFlags(["--identity"]).cleanedArgv).toEqual([]);
  });

  test("--identity=<name> behaves as before; --pool is forwarded when pools are off", () => {
    const r = stripOwnFlags(["--identity=work", "--pool=a"]);
    expect(r.identityFlag).toBe("work");
    expect(r.pickerMode).toBeUndefined();
    expect(r.cleanedArgv).toEqual(["--pool=a"]);
  });
});

describe("detectNonInteractiveHint", () => {
  test("claude: -p/--print is non-interactive", () => {
    expect(detectNonInteractiveHint("claude", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("claude", ["--print", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("claude", ["hello"])).toBe(false);
  });

  test("codex: a leading `exec` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("codex", ["exec", "do the thing"])).toBe(true);
    expect(detectNonInteractiveHint("codex", ["app", "."])).toBe(false);
  });

  test("grok: -p/--single is non-interactive", () => {
    expect(detectNonInteractiveHint("grok", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("grok", ["--single", "hello"])).toBe(true);
  });

  test("grok: a leading `agent` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("grok", ["agent", "stdio"])).toBe(true);
    expect(detectNonInteractiveHint("grok", ["dashboard"])).toBe(false);
  });

  test("grok: a plain prompt is interactive", () => {
    expect(detectNonInteractiveHint("grok", ["fix the bug"])).toBe(false);
  });

  test("kimi: -p/--prompt is non-interactive", () => {
    expect(detectNonInteractiveHint("kimi", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["--prompt", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["--prompt=hello"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["hello"])).toBe(false);
  });

  test("kimi: a leading `acp` subcommand is non-interactive", () => {
    expect(detectNonInteractiveHint("kimi", ["acp"])).toBe(true);
    expect(detectNonInteractiveHint("kimi", ["web"])).toBe(false);
  });

  test("zai: a leading `run` subcommand is non-interactive (zai's real binary is crush)", () => {
    expect(detectNonInteractiveHint("zai", ["run", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("zai", ["hello"])).toBe(false);
    expect(detectNonInteractiveHint("zai", ["-p", "hello"])).toBe(false);
  });

  test("ali: a leading `run` subcommand is non-interactive (ali's real binary is also crush)", () => {
    expect(detectNonInteractiveHint("ali", ["run", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("ali", ["hello"])).toBe(false);
    expect(detectNonInteractiveHint("ali", ["-p", "hello"])).toBe(false);
  });

  test("pi: print mode and package commands are non-interactive", () => {
    expect(detectNonInteractiveHint("pi", ["-p", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("pi", ["install", "npm:extension"])).toBe(true);
    expect(detectNonInteractiveHint("pi", [])).toBe(false);
  });

  test("opencode: run, ACP and headless server modes are non-interactive", () => {
    expect(detectNonInteractiveHint("opencode", ["run", "hello"])).toBe(true);
    expect(detectNonInteractiveHint("opencode", ["acp"])).toBe(true);
    expect(detectNonInteractiveHint("opencode", ["serve", "--port", "4096"])).toBe(true);
    expect(detectNonInteractiveHint("opencode", ["providers", "list"])).toBe(false);
  });
});

describe("resolveNestedIdentity", () => {
  test("top-level and legacy-marker invocations pass the requested identity through unchanged", () => {
    expect(resolveNestedIdentity("claude", undefined, undefined)).toBeUndefined();
    expect(resolveNestedIdentity("claude", undefined, "work")).toBe("work");
    expect(resolveNestedIdentity("claude", "1", undefined)).toBeUndefined();
    expect(resolveNestedIdentity("claude", "1", "work")).toBe("work");
  });

  test("a nested launch with no --id auto-inherits the parent's identity", () => {
    expect(resolveNestedIdentity("grok", "identity-a", undefined)).toBe("identity-a");
  });

  test("a nested launch with the matching canonical identity resolves to it (no throw)", () => {
    expect(resolveNestedIdentity("codex", "identity-a", "identity-a")).toBe("identity-a");
  });

  test("rejects a nested launch that EXPLICITLY requests a different identity", () => {
    expect(() => resolveNestedIdentity("claude", "identity-a", "personal")).toThrow(
      "active identity is 'identity-a'",
    );
  });

  test("works the same for zai as every other tool", () => {
    expect(resolveNestedIdentity("zai", "identity-a", undefined)).toBe("identity-a");
    expect(() => resolveNestedIdentity("zai", "identity-a", "personal")).toThrow("active identity is 'identity-a'");
  });

  test("works the same for ali as every other tool", () => {
    expect(resolveNestedIdentity("ali", "identity-a", undefined)).toBe("identity-a");
    expect(() => resolveNestedIdentity("ali", "identity-a", "personal")).toThrow("active identity is 'identity-a'");
  });

  test("works the same for pi as every other tool", () => {
    expect(resolveNestedIdentity("pi", "all", undefined)).toBe("all");
    expect(() => resolveNestedIdentity("pi", "all", "personal")).toThrow("active identity is 'all'");
  });

  test("works the same for opencode as every other tool", () => {
    expect(resolveNestedIdentity("opencode", "all", undefined)).toBe("all");
    expect(() => resolveNestedIdentity("opencode", "all", "personal")).toThrow("active identity is 'all'");
  });
});

describe("provider-aware parent sessions", () => {
  const claudeParent = {
    AI_PROFILE_SWITCHER_SESSION: "pool-a",
    AI_PROFILE_SWITCHER_TOOL: "claude",
    CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
  };
  const codexParent = {
    AI_PROFILE_SWITCHER_SESSION: "pool-a",
    AI_PROFILE_SWITCHER_TOOL: "codex",
    CODEX_HOME: "/synthetic/codex/pool-a",
  };

  test("cross-provider launches resolve their own identity in both directions", () => {
    const fromClaude = activeParentSession("codex", claudeParent);
    const fromCodex = activeParentSession("claude", codexParent);
    expect(fromClaude).toEqual({ toolName: "claude", identity: "pool-a" });
    expect(fromCodex).toEqual({ toolName: "codex", identity: "pool-a" });
    expect(resolveParentLaunchContext("codex", claudeParent, "member-b")).toMatchObject({
      parentSession: { toolName: "claude", identity: "pool-a" },
      identityFlag: "member-b",
    });
    expect(resolveParentLaunchContext("claude", codexParent, "pool-b")).toMatchObject({
      parentSession: { toolName: "codex", identity: "pool-a" },
      identityFlag: "pool-b",
    });
  });

  test("different pool and member names remain valid across providers", () => {
    expect(activeParentSession("codex", {
      ...claudeParent,
      AI_PROFILE_SWITCHER_SESSION: "member-a",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/member-a",
    })).toEqual({ toolName: "claude", identity: "member-a" });
    expect(resolveParentLaunchContext("codex", {
      ...claudeParent,
      AI_PROFILE_SWITCHER_SESSION: "member-a",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/member-a",
    }, "member-b").identityFlag).toBe("member-b");
  });

  test("same-provider launches keep inheritance and explicit mismatch rejection", () => {
    const parent = activeParentSession("claude", claudeParent);
    expect(parent).toEqual({ toolName: "claude", identity: "pool-a" });
    expect(resolveParentLaunchContext("claude", claudeParent, undefined).identityFlag).toBe("pool-a");
    expect(() => resolveParentLaunchContext("claude", claudeParent, "pool-b")).toThrow("active identity is 'pool-a'");
  });

  test("cross-provider pool selection is preserved without inheriting the parent identity", () => {
    const args = parseCliArgs("claude", ["--pool=pool-a", "synthetic prompt"]);
    expect(resolveParentLaunchContext("claude", codexParent, args.identityFlag).parentSession?.toolName).toBe("codex");
    expect(resolveParentLaunchContext("claude", codexParent, args.identityFlag).identityFlag).toBeUndefined();
    expect(args.poolFlag).toBe("pool-a");
    expect(args.cleanedArgv).toEqual(["synthetic prompt"]);
  });

  test("legacy marker remains target-scoped and stale or mismatched marker pairs are ignored", () => {
    expect(activeParentSession("claude", {
      AI_PROFILE_SWITCHER_SESSION: "legacy-a",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/legacy-a",
    })).toEqual({ toolName: "claude", identity: "legacy-a" });
    expect(activeParentSession("codex", {
      AI_PROFILE_SWITCHER_SESSION: "stale-a",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/stale-a",
    })).toBeUndefined();
    expect(activeParentSession("codex", {
      AI_PROFILE_SWITCHER_SESSION: "stale-a",
      AI_PROFILE_SWITCHER_TOOL: "claude",
      CODEX_HOME: "/synthetic/codex/member-b",
    })).toBeUndefined();
  });
});

describe("provider-aware wrapper identity resolution", () => {
  const codexRegistry: IdentitiesFile = {
    version: 1,
    identities: [
      { name: "pool-a", label: "Synthetic pool A", configDir: "/synthetic/codex/pool-a", swapPool: { accounts: ["member-a", "member-b"], active: "member-a" } },
      { name: "member-a", label: "Synthetic member A", configDir: "/synthetic/codex/member-a" },
      { name: "member-b", label: "Synthetic member B", configDir: "/synthetic/codex/member-b", directories: ["/synthetic/projects/codex/*"] },
    ],
  };
  const claudeRegistry: IdentitiesFile = {
    version: 1,
    identities: [
      { name: "pool-a", label: "Synthetic pool A", configDir: "/synthetic/claude/pool-a", swapPool: { accounts: ["member-a", "member-b"], active: "member-a" } },
      { name: "member-a", label: "Synthetic member A", configDir: "/synthetic/claude/member-a" },
      { name: "member-b", label: "Synthetic member B", configDir: "/synthetic/claude/member-b" },
    ],
  };
  const deps: ResolveDeps = {
    loadIdentitiesFile: async (path) => path === CODEX_CONFIG.identitiesJsonPath ? codexRegistry : claudeRegistry,
    saveIdentitiesFile: async () => {},
    matchDirectory,
    promptForIdentity: async () => { throw new Error("unexpected prompt"); },
    isInteractive: () => false,
  };

  test("cross-provider explicit identities and directory matches resolve in the target registry", async () => {
    const codexContext = resolveParentLaunchContext("codex", {
      AI_PROFILE_SWITCHER_SESSION: "pool-a",
      AI_PROFILE_SWITCHER_TOOL: "claude",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
      CODEX_HOME: "/synthetic/codex/member-b",
    }, "member-b");
    const codex = await resolveIdentity(CODEX_CONFIG, {
      explicitIdentityFlag: codexContext.identityFlag,
      cwd: "/synthetic/projects/codex/task",
      env: { CODEX_HOME: "/synthetic/codex/member-b" },
    }, deps);
    expect(codex.identity?.name).toBe("member-b");

    const codexDirectoryContext = resolveParentLaunchContext("codex", {
      AI_PROFILE_SWITCHER_SESSION: "pool-a",
      AI_PROFILE_SWITCHER_TOOL: "claude",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
      CODEX_HOME: "/synthetic/codex/member-b",
    }, undefined);
    const codexByDirectory = await resolveIdentity(CODEX_CONFIG, {
      explicitIdentityFlag: codexDirectoryContext.identityFlag,
      cwd: "/synthetic/projects/codex/task",
      env: {},
    }, deps);
    expect(codexByDirectory.identity?.name).toBe("member-b");
    expect(codexByDirectory.source).toBe("directory-match");

    const claudeContext = resolveParentLaunchContext("claude", {
      AI_PROFILE_SWITCHER_SESSION: "pool-a",
      AI_PROFILE_SWITCHER_TOOL: "codex",
      CODEX_HOME: "/synthetic/codex/pool-a",
      CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
    }, undefined);
    const poolArgs = parseCliArgs("claude", ["--pool=pool-a"]);
    const claude = await resolveIdentity(CLAUDE_CONFIG, {
      explicitIdentityFlag: claudeContext.identityFlag,
      explicitPoolFlag: poolArgs.poolFlag,
      cwd: "/synthetic/projects/unrelated",
      env: { CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a" },
    }, deps);
    expect(claude.identity?.name).toBe("pool-a");
    expect(claude.source).toBe("flag");

    const codexMemberA = await resolveIdentity(CODEX_CONFIG, {
      explicitIdentityFlag: resolveParentLaunchContext("codex", {
        AI_PROFILE_SWITCHER_SESSION: "pool-a",
        AI_PROFILE_SWITCHER_TOOL: "claude",
        CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
        CODEX_HOME: "/synthetic/codex/member-a",
      }, "member-a").identityFlag,
      cwd: "/synthetic/projects/unrelated",
      env: {},
    }, deps);
    const claudeMemberB = await resolveIdentity(CLAUDE_CONFIG, {
      explicitIdentityFlag: resolveParentLaunchContext("claude", {
        AI_PROFILE_SWITCHER_SESSION: "pool-a",
        AI_PROFILE_SWITCHER_TOOL: "codex",
        CODEX_HOME: "/synthetic/codex/pool-a",
        CLAUDE_CONFIG_DIR: "/synthetic/claude/member-b",
      }, "member-b").identityFlag,
      cwd: "/synthetic/projects/unrelated",
      env: {},
    }, deps);
    expect(codexMemberA.identity?.name).toBe("member-a");
    expect(claudeMemberB.identity?.name).toBe("member-b");
  });

  test.each([
    { target: "claude" as const, parent: "codex" as const, parentEnv: "CODEX_HOME", targetEnv: "CLAUDE_CONFIG_DIR", config: CLAUDE_CONFIG, expected: "pool-a", requested: "pool-a" },
    { target: "codex" as const, parent: "claude" as const, parentEnv: "CLAUDE_CONFIG_DIR", targetEnv: "CODEX_HOME", config: CODEX_CONFIG, expected: "pool-a", requested: "pool-a" },
    { target: "claude" as const, parent: "codex" as const, parentEnv: "CODEX_HOME", targetEnv: "CLAUDE_CONFIG_DIR", config: CLAUDE_CONFIG, parentIdentity: "member-a", expected: "member-b", requested: "member-b" },
    { target: "codex" as const, parent: "claude" as const, parentEnv: "CLAUDE_CONFIG_DIR", targetEnv: "CODEX_HOME", config: CODEX_CONFIG, parentIdentity: "member-a", expected: "member-b", requested: "member-b" },
  ])("cross-provider $target resolves explicit $requested with both provider env vars present", async (scenario) => {
    const parentEnvValue = scenario.parent === "claude"
      ? `/synthetic/claude/${scenario.parentIdentity ?? "pool-a"}`
      : `/synthetic/codex/${scenario.parentIdentity ?? "pool-a"}`;
    const targetEnvValue = scenario.target === "claude"
      ? `/synthetic/claude/${scenario.expected}`
      : `/synthetic/codex/${scenario.expected}`;
    const context = resolveParentLaunchContext(scenario.target, {
      AI_PROFILE_SWITCHER_SESSION: scenario.parentIdentity ?? "pool-a",
      AI_PROFILE_SWITCHER_TOOL: scenario.parent,
      [scenario.parentEnv]: parentEnvValue,
      [scenario.targetEnv]: targetEnvValue,
    }, scenario.requested);
    const resolved = await resolveIdentity(scenario.config, {
      explicitIdentityFlag: context.identityFlag,
      cwd: "/synthetic/projects/unrelated",
      env: { [scenario.targetEnv]: targetEnvValue },
    }, deps);
    expect(resolved.identity?.name).toBe(scenario.expected);
    expect(resolved.source).toBe("flag");
  });
});
