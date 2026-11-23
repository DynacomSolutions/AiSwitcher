import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus } from "../../src/server/auth.ts";
import { memberDir } from "../../src/identities/gateway-members.ts";
import type { GatewayRenewalLoginDto, GatewayRenewalView } from "../../src/server/gateway-renewal.ts";
import type { ToolConfig } from "../../src/identities/types.ts";

/** The gateway's renewal row decides a claude or codex login; stale host copies must not say "expired". */

let root: string;
let saved: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-auth-renewal-"));
  saved = process.env.AIS_GATEWAY_MEMBERS_DIR;
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
});
afterEach(async () => {
  if (saved === undefined) delete process.env.AIS_GATEWAY_MEMBERS_DIR;
  else process.env.AIS_GATEWAY_MEMBERS_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

const claudeEntry = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_key", scopes: [] } });
/** A login that expired in 1970, like the stale copies seen live. */
const staleClaude = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-SYNTHETIC_FIXTURE", refreshToken: "", expiresAt: 1 } });

function cfg(): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    globalMemoryProjection: "claude-append-file",
    identitiesJsonPath: join(root, "claude", "identities.json"),
    identitiesRootDir: join(root, "claude", "identities"),
  };
}

async function seed(folderFile: string, opts: { store?: string; aliases?: string[] } = {}): Promise<void> {
  const folder = join(root, "claude", "identities", "member-a");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, ".credentials.json"), folderFile);
  await writeFile(cfg().identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: "member-a", label: "Member A", configDir: folder, ...(opts.aliases ? { aliases: opts.aliases } : {}) }] }));
  if (opts.store !== undefined) {
    const dir = memberDir("claude", "member-a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), opts.store);
  }
}

const row = (over: Partial<GatewayRenewalLoginDto> = {}): GatewayRenewalLoginDto => ({
  provider: "claude",
  identity: "member-a",
  lastRefreshAt: "2026-11-23T12:00:00Z",
  lastRefreshReplica: "gw-0",
  lastError: null,
  expiresAt: "2026-11-23T18:23:00Z",
  nextRefreshAt: "2026-11-23T17:00:00Z",
  revoked: false,
  ...over,
});
const view = (...logins: GatewayRenewalLoginDto[]): GatewayRenewalView => ({ state: "ok", logins });
const status = async (v: GatewayRenewalView | (() => Promise<GatewayRenewalView>)) => (await authStatus([cfg()], [], typeof v === "function" ? v : async () => v)).entries[0]!;

describe("auth status from the gateway renewal row", () => {
  test("a stale folder and member copy is ok when the gateway row is healthy", async () => {
    await seed(staleClaude, { store: staleClaude });
    const e = await status(view(row()));
    expect(e.state).toBe("ok");
    expect(e.expiresAt).toBe("2026-11-23T18:23:00Z");
    expect(e.detail).toContain("via gateway: renewed 2026-11-23T12:00:00Z");
    expect(e.detail).toContain("next renewal 2026-11-23T17:00:00Z");
  });

  test("a stale folder that holds the gateway entry is ok when the gateway row is healthy", async () => {
    await seed(claudeEntry);
    expect((await status(view(row()))).state).toBe("ok");
  });

  test("an alias in the registry matches the gateway row", async () => {
    await seed(staleClaude, { aliases: ["member-a-alias"] });
    const e = await status(view(row({ identity: "member-a-alias" })));
    expect(e.state).toBe("ok");
    expect(e.detail).toContain("via gateway");
  });

  test("a revoked row needs a re-login", async () => {
    await seed(staleClaude);
    const e = await status(view(row({ revoked: true })));
    expect(e.state).toBe("expired");
    expect(e.detail).toBe("refresh token revoked at the gateway: re-login required");
    expect(e.fixable).toEqual(["login"]);
  });

  test("a row with a renewal error warns with the short error", async () => {
    await seed(staleClaude);
    const long = "upstream said no ".repeat(30);
    const e = await status(view(row({ lastError: { at: "2026-11-23T12:30:00Z", code: "http_500", detail: long } })));
    expect(e.state).toBe("expiring");
    expect(e.detail).toContain("http_500");
    expect(e.detail!.length).toBeLessThan(220);
  });

  test("an identity with no row keeps the host probe", async () => {
    await seed(staleClaude);
    const e = await status(view(row({ identity: "someone-else" })));
    expect(e.state).toBe("expired");
    expect(e.detail).toContain("token expired");
  });

  test("an unreachable gateway admin never marks a gateway-entry folder expired", async () => {
    await seed(claudeEntry, { store: staleClaude });
    const e = await status({ state: "unavailable", logins: [], error: "gateway admin unreachable" });
    expect(e.state).toBe("unknown");
    expect(e.detail).toBe("gateway admin unreachable");
  });

  test("a thrown admin read behaves as unreachable", async () => {
    await seed(claudeEntry, { store: staleClaude });
    const e = await status(async () => {
      throw new Error("boom");
    });
    expect(e.state).toBe("unknown");
  });

  test("an unreachable admin keeps the host probe for a plain login folder", async () => {
    await seed(staleClaude);
    const e = await status({ state: "unavailable", logins: [], error: "gateway admin unreachable" });
    expect(e.state).toBe("expired");
  });

  test("no gateway configured keeps the host probe", async () => {
    await seed(staleClaude);
    const e = await status({ state: "unconfigured", logins: [] });
    expect(e.state).toBe("expired");
  });
});
