import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus } from "../../src/server/auth.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import { refreshFingerprint } from "../../src/identities/gateway-routed.ts";
import { recordLoginRevoked } from "../../src/identities/gateway-revoked.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** Identity folders that hold the gateway entry: the Identities tab must report the member store's login, not the entry. */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-auth-gw-"));
  saved = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
});
afterEach(async () => {
  if (saved === undefined) delete process.env.AIS_GATEWAY_MEMBERS_DIR;
  else process.env.AIS_GATEWAY_MEMBERS_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

const jwt = (expSeconds: number) => `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ exp: expSeconds }))}.sig`;
const inHours = (h: number) => Math.floor(Date.now() / 1000 + h * 3600);

const codexEntry = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "aisg_SYNTHETIC_FIXTURE_key", aisGatewayRouting: { host: "h", at: 1, fingerprints: [] } });
const codexLogin = (exp: number, n = "a") => JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x", access_token: jwt(exp), refresh_token: `rt-SYNTHETIC_FIXTURE-${n}` } });
const claudeEntry = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_key", scopes: [] } });
const claudeLogin = (expiresAt: number, n = "a") => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-SYNTHETIC_FIXTURE", refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt } });

function cfg(toolName: "claude" | "codex"): ToolConfig {
  return {
    toolName,
    realBinaryName: toolName,
    envVarName: toolName === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME",
    globalMemoryProjection: toolName === "claude" ? "claude-append-file" : "codex-developer-instructions",
    identitiesJsonPath: join(root, toolName, "identities.json"),
    identitiesRootDir: join(root, toolName, "identities"),
  };
}

/** One identity "work" whose folder holds `folderFile`; `store` is the member store login (undefined: none on this host). */
async function seed(tool: "claude" | "codex", folderFile: string, store?: string): Promise<void> {
  const file = tool === "claude" ? ".credentials.json" : "auth.json";
  const folder = join(root, tool, "identities", "work");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, file), folderFile);
  await writeFile(cfg(tool).identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: "work", label: "Work", configDir: folder }] }));
  if (store !== undefined) {
    const dir = memberDir(tool, "work");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), store);
  }
}

const fp = (n: string) => refreshFingerprint(`rt-SYNTHETIC_FIXTURE-${n}`).slice(0, 8);
const entryOf = async (tool: "claude" | "codex") => (await authStatus([cfg(tool)])).entries[0]!;

describe("auth status of a gateway-routed identity", () => {
  for (const tool of ["codex", "claude"] as const) {
    const entry = tool === "codex" ? codexEntry : claudeEntry;
    const login = (hours: number) => (tool === "codex" ? codexLogin(inHours(hours)) : claudeLogin(Date.now() + hours * 3_600_000));

    test(`${tool}: gateway entry and a healthy member copy reports the member login`, async () => {
      await seed(tool, entry, login(24 * 5));
      const e = await entryOf(tool);
      expect(e.state).toBe("ok");
      expect(e.detail).toContain("via gateway member store");
      expect(e.detail).toContain("expires in");
      expect(e.expiresAt).toBeDefined();
    });

    test(`${tool}: gateway entry and an expired member copy that can refresh is renewed on use`, async () => {
      await seed(tool, entry, login(-3));
      const e = await entryOf(tool);
      expect(e.detail).toContain("via gateway member store");
      expect(e.detail).toContain("lapsed");
      expect(e.state).toBe("ok");
    });

    test(`${tool}: a revoked member login needs a re-login`, async () => {
      await seed(tool, entry, login(24 * 5));
      expect(await recordLoginRevoked(tool, "work", "token_revoked", fp("a"))).toBe(true);
      const e = await entryOf(tool);
      expect(e.state).toBe("expired");
      expect(e.detail).toContain("refresh token revoked: re-login required");
      expect(e.fixable).toEqual(["login"]);
    });

    test(`${tool}: a new login in the store makes the revoked record stale`, async () => {
      await seed(tool, entry, login(24 * 5));
      await recordLoginRevoked(tool, "work", "token_revoked", fp("a"));
      const file = tool === "codex" ? "auth.json" : ".credentials.json";
      await writeFile(join(memberDir(tool, "work"), file), tool === "codex" ? codexLogin(inHours(100), "new") : claudeLogin(Date.now() + 100 * 3_600_000, "new"));
      expect((await entryOf(tool)).state).toBe("ok");
    });

    test(`${tool}: gateway entry without a member copy is never ok`, async () => {
      await seed(tool, entry);
      const e = await entryOf(tool);
      expect(e.state).toBe("unknown");
      expect(e.detail).toContain("no member-store login");
      expect(e.fixable).toEqual(["login"]);
    });
  }

  test("a plain login in the folder is probed as before, even when a revoked record exists for the name", async () => {
    await seed("codex", codexLogin(inHours(24 * 3)), codexLogin(inHours(24 * 5), "store"));
    await recordLoginRevoked("codex", "work", "token_revoked", fp("store"));
    const e = await entryOf("codex");
    expect(e.state).toBe("ok");
    expect(e.detail).not.toContain("gateway");
    expect(e.detail).toContain("token expires in");
  });

  test("a codex API-key login (not the gateway entry) is unchanged", async () => {
    await seed("codex", JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-SYNTHETIC_FIXTURE" }));
    const e = await entryOf("codex");
    expect(e.state).toBe("ok");
    expect(e.detail).toContain("API key");
  });

  test("a stale host refresh failure recorded before routing does not override the member-store probe", async () => {
    await seed("codex", codexEntry, codexLogin(inHours(24 * 5)));
    const stale = [{ tool: "codex", identity: "work", revoked: true, lastError: "old failure", consecutiveFailures: 9, lastSuccessAt: "2020-01-01T00:00:00Z" }] as never;
    const e = (await authStatus([cfg("codex")], stale)).entries[0]!;
    expect(e.state).toBe("ok");
    expect(e.detail).toContain("via gateway member store");
    expect(e.refreshError).toBeUndefined();
  });

  test("a host refresh status still applies to a plain login", async () => {
    await seed("codex", codexLogin(inHours(2)));
    const status = [{ tool: "codex", identity: "work", revoked: true, lastError: "x", consecutiveFailures: 3 }] as never;
    const e = (await authStatus([cfg("codex")], status)).entries[0]!;
    expect(e.state).toBe("expiring");
  });
});
