import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus, credentialPathsForTool } from "../../src/server/auth.ts";
import type { RefreshStatusDto } from "../../src/server/auth-refresh.ts";
import type { ToolConfig } from "../../src/identities/types.ts";
import type { AuthKind, AuthState } from "../../src/server/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-auth-"));
  tempDirs.push(dir);
  return dir;
}

function configFor(toolName: ToolConfig["toolName"], root: string): ToolConfig {
  const envVarNames: Record<string, string> = {
    claude: "CLAUDE_CONFIG_DIR",
    codex: "CODEX_HOME",
    grok: "GROK_HOME",
    kimi: "KIMI_CODE_HOME",
    zai: "CRUSH_GLOBAL_CONFIG",
    ali: "ALI_CONFIG_DIR",
    pi: "PI_CODING_AGENT_DIR",
    opencode: "OPENCODE_CONFIG_DIR",
  };
  return {
    toolName,
    realBinaryName: (toolName === "zai" || toolName === "ali" ? "crush" : toolName) as ToolConfig["realBinaryName"],
    envVarName: envVarNames[toolName] as ToolConfig["envVarName"],
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath: join(root, "identities.json"),
    identitiesRootDir: join(root, "identities"),
  };
}

/** Creates a one-identity registry plus the identity's config dir. */
async function seedIdentity(toolName: ToolConfig["toolName"], root: string): Promise<string> {
  const configDir = join(root, "identity-work");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(root, "identities.json"),
    `${JSON.stringify({ version: 1, identities: [{ name: "work", label: "Work", configDir }] }, null, 2)}\n`,
  );
  return configDir;
}

function singleEntry(dto: {
  entries: Array<{
    toolName: string;
    identity: string;
    kind: AuthKind;
    state: AuthState;
    detail?: string;
    fixable: string[];
    expiresAt?: string;
    lastRefreshAt?: string;
    refreshError?: string;
  }>;
}) {
  expect(dto.entries.length).toBe(1);
  return dto.entries[0];
}

async function statusFor(toolName: ToolConfig["toolName"], refresh: RefreshStatusDto[] = []) {
  const root = await tempHome();
  const configDir = await seedIdentity(toolName, root);
  const dto = await authStatus([configFor(toolName, root)], refresh);
  return { entry: singleEntry(dto), configDir, root };
}

function hoursFromNow(hours: number): number {
  return Date.now() + hours * 3_600_000;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

describe("credentialPathsForTool", () => {
  test("covers every credential shape per tool", () => {
    expect(credentialPathsForTool("claude", "/cfg")).toEqual(["/cfg/.credentials.json"]);
    expect(credentialPathsForTool("codex", "/cfg")).toEqual(["/cfg/auth.json"]);
    expect(credentialPathsForTool("grok", "/cfg")).toEqual(["/cfg/credentials.json", "/cfg/auth.json", "/cfg/auth.toml"]);
    expect(credentialPathsForTool("kimi", "/cfg")).toEqual(["/cfg/credentials/kimi-code.json"]);
    expect(credentialPathsForTool("pi", "/cfg")).toEqual(["/cfg/auth.json"]);
    expect(credentialPathsForTool("opencode", "/cfg")).toEqual(["/cfg/data/opencode/auth.json", "/cfg/opencode/auth.json"]);
    expect(credentialPathsForTool("zai", "/cfg")).toEqual([]);
    expect(credentialPathsForTool("ali", "/cfg")).toEqual([]);
  });
});

describe("claude probe", () => {
  test("missing credentials", async () => {
    const { entry } = await statusFor("claude");
    expect(entry.state).toBe("missing");
    expect(entry.fixable).toContain("login");
  });

  test("expired, expiring and fresh tokens report expiresAt", async () => {
    for (const [hours, expected] of [
      [-5, "expired"],
      [2, "expiring"],
      [48, "ok"],
    ] as const) {
      const { entry, configDir } = await statusFor("claude");
      await Bun.write(
        join(configDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: hoursFromNow(hours) } }),
      );
      const dto = await authStatus([configFor("claude", join(configDir, ".."))]);
      const refreshed = singleEntry(dto);
      expect(refreshed.state).toBe(expected);
      expect(refreshed.expiresAt).toBeDefined();
    }
  });
});

describe("codex probe", () => {
  test("missing auth.json", async () => {
    const { entry } = await statusFor("codex");
    expect(entry.state).toBe("missing");
  });

  test("API-key-only auth.json is ok without an expiry", async () => {
    const { entry, configDir } = await statusFor("codex");
    await Bun.write(join(configDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    const dto = await authStatus([configFor("codex", join(configDir, ".."))]);
    const refreshed = singleEntry(dto);
    expect(refreshed.state).toBe("ok");
    expect(refreshed.expiresAt).toBeUndefined();
  });

  test("JWT expiry inside id_token drives the state", async () => {
    const { entry, configDir } = await statusFor("codex");
    const expiredJwt = fakeJwt({ exp: Math.floor(hoursFromNow(-3) / 1000) });
    await Bun.write(
      join(configDir, "auth.json"),
      JSON.stringify({ tokens: { id_token: expiredJwt, access_token: "at", refresh_token: "rt" }, last_refresh: new Date().toISOString() }),
    );
    const dto = await authStatus([configFor("codex", join(configDir, ".."))]);
    const refreshed = singleEntry(dto);
    expect(refreshed.state).toBe("expired");
    expect(refreshed.expiresAt).toBeDefined();
  });
});

describe("kimi probe", () => {
  test("expired token still advertises the refresh fix", async () => {
    const { entry, configDir } = await statusFor("kimi");
    await mkdir(join(configDir, "credentials"), { recursive: true });
    await Bun.write(
      join(configDir, "credentials", "kimi-code.json"),
      JSON.stringify({ accessToken: "x", expiresAt: hoursFromNow(-1) }),
    );
    const dto = await authStatus([configFor("kimi", join(configDir, ".."))]);
    const refreshed = singleEntry(dto);
    expect(refreshed.state).toBe("expired");
    expect(refreshed.fixable).toEqual(["refresh", "login"]);
    expect(refreshed.detail).toContain("refresh");
  });
});

describe("opencode probe", () => {
  test("missing auth.json under the XDG data dir", async () => {
    const { entry } = await statusFor("opencode");
    expect(entry.state).toBe("missing");
  });

  test("credentials in data/opencode/auth.json are found and expiry-aware", async () => {
    const { entry, configDir } = await statusFor("opencode");
    await mkdir(join(configDir, "data", "opencode"), { recursive: true });
    await Bun.write(
      join(configDir, "data", "opencode", "auth.json"),
      JSON.stringify({ zai_coding_plan: { type: "oauth", access: "a", refresh: "r", expires: hoursFromNow(-2) } }),
    );
    const dto = await authStatus([configFor("opencode", join(configDir, ".."))]);
    const refreshed = singleEntry(dto);
    expect(refreshed.state).toBe("expired");
    expect(refreshed.expiresAt).toBeDefined();
  });
});

describe("ali probe with refresh scheduler status", () => {
  test("refresh status is threaded into the entry", async () => {
    const { entry, configDir } = await statusFor("ali");
    await Bun.write(join(configDir, "console-cookie.txt"), "cna=x; t=y\n");
    const refresh: RefreshStatusDto[] = [
      {
        tool: "ali",
        identity: "work",
        lastAttemptAt: "2026-09-10T00:00:00.000Z",
        lastSuccessAt: "2026-09-10T00:00:01.000Z",
        lastError: null,
        lastDetail: null,
        revoked: false,
        consecutiveFailures: 0,
        running: false,
      },
    ];
    const dto = await authStatus([configFor("ali", join(configDir, ".."))], refresh);
    const refreshed = singleEntry(dto);
    expect(refreshed.state).toBe("unknown");
    expect(refreshed.lastRefreshAt).toBe("2026-09-10T00:00:01.000Z");
    expect(refreshed.refreshError).toBeUndefined();
    expect(refreshed.detail).toContain("cookie written");
  });

  test("refresh errors are surfaced too", async () => {
    const { entry, configDir } = await statusFor("ali");
    await Bun.write(join(configDir, "console-cookie.txt"), "cna=x\n");
    const refresh: RefreshStatusDto[] = [
      {
        tool: "ali",
        identity: "work",
        lastAttemptAt: "2026-09-10T00:00:00.000Z",
        lastSuccessAt: null,
        lastError: "browser unavailable",
        lastDetail: null,
        revoked: false,
        consecutiveFailures: 1,
        running: false,
      },
    ];
    const dto = await authStatus([configFor("ali", join(configDir, ".."))], refresh);
    const refreshed = singleEntry(dto);
    expect(refreshed.refreshError).toBe("browser unavailable");
  });
});

describe("grok probe", () => {
  test("unknown when a credential file has no parsable expiry", async () => {
    const { entry, configDir } = await statusFor("grok");
    await Bun.write(join(configDir, "credentials.json"), JSON.stringify({ teamId: "1" }));
    const dto = await authStatus([configFor("grok", join(configDir, ".."))]);
    expect(singleEntry(dto).state).toBe("unknown");
  });

  test("missing when no known credential file exists", async () => {
    const { entry } = await statusFor("grok");
    expect(entry.state).toBe("missing");
  });
});
