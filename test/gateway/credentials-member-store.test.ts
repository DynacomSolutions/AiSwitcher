import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialCache } from "../../src/gateway/credentials.ts";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { refreshIdentityOAuthGrant } from "../../src/identities/oauth-refresh.ts";
import { CLAUDE_CONFIG } from "../../src/identities/tool-configs.ts";

// A gateway process reads and refreshes a routed account's login in the member store, never in the identity folder
// (which holds the gateway entry). Temp dirs only: the registry, the folder and the store all live under `work`.
let work = "";
let savedRegistry = "";
const env: Record<string, string | undefined> = {};
const ENV_KEYS = ["AIS_GATEWAY_MEMBER_STORE", "AIS_GATEWAY_MEMBERS_DIR", "AIS_GATEWAY_OWNER"];

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "ais-gw-cred-store-"));
  savedRegistry = CLAUDE_CONFIG.identitiesJsonPath;
  for (const k of ENV_KEYS) env[k] = process.env[k];
});
afterEach(async () => {
  (CLAUDE_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = savedRegistry;
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  await rm(work, { recursive: true, force: true });
});

test("the gateway credential cache writes a refreshed login into the member store copy, not the identity folder", async () => {
  // registry at <work>/.claude/identities.json: the shape the member store remap recognises as claude's own registry
  const registry = join(work, ".claude", "identities.json");
  const folder = join(work, ".claude", "identities", "m");
  const members = join(work, "members");
  const store = join(members, "claude", "m");
  await mkdir(folder, { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "m", label: "m", configDir: folder }] }));
  const entry = gatewayEntryText("aisg_SYNTHETIC_FIXTURE_entry");
  await writeFile(join(folder, ".credentials.json"), entry);
  // the store holds the real login, its access token already expired
  await writeFile(join(store, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE-old-access", refreshToken: "SYNTHETIC_FIXTURE-old-refresh", expiresAt: 1_000, scopes: ["user:inference"] } }));
  await writeFile(join(store, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u-m" } }));

  (CLAUDE_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = registry;
  process.env.AIS_GATEWAY_MEMBERS_DIR = members;
  process.env.AIS_GATEWAY_MEMBER_STORE = "1";
  process.env.AIS_GATEWAY_OWNER = "1";

  const posts: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    posts.push(String(url));
    expect(String(init?.body)).toContain("SYNTHETIC_FIXTURE-old-refresh");
    return new Response(JSON.stringify({ access_token: "SYNTHETIC_FIXTURE-new-access", refresh_token: "SYNTHETIC_FIXTURE-new-refresh", expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const cache = new CredentialCache({
    claudeRegistryPath: registry,
    refresh: (tool, identity, options) => refreshIdentityOAuthGrant(tool, identity, { ...options, fetchImpl, claudeRegistryPath: registry }),
  });

  const cred = await cache.get("claude", "m");
  expect(posts.length).toBe(1);
  expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-new-access");
  const stored = JSON.parse(await readFile(join(store, ".credentials.json"), "utf8")).claudeAiOauth;
  expect(stored.accessToken).toBe("SYNTHETIC_FIXTURE-new-access");
  expect(stored.refreshToken).toBe("SYNTHETIC_FIXTURE-new-refresh");
  expect(stored.expiresAt).toBeGreaterThan(Date.now());
  // the identity folder keeps the gateway entry
  expect(await readFile(join(folder, ".credentials.json"), "utf8")).toBe(entry);
});
