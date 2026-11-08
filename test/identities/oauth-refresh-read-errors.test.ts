import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeClaudePoolStores, refreshIdentityOAuthGrant, storeClass } from "../../src/identities/oauth-refresh.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";

// Store read failures on the refresh path. Temp registries and stores only
// (repointed and restored per test); token values are short synthetic strings.
const NAME = "acme";
const saved: Record<string, string> = {};
let root = "";
let claudeDir = "";
let codexDir = "";
let piDir = "";
let poolDir = "";
let poolRegistry = "";

const NOW = 1_789_200_000;
const identityIn = (dir: string): Identity => ({ name: NAME, label: "Acme", configDir: dir });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-read-errors-"));
  claudeDir = join(root, "claude", NAME);
  codexDir = join(root, "codex", NAME);
  piDir = join(root, "pi", NAME);
  poolDir = join(root, "claude", "pool");
  for (const dir of [claudeDir, codexDir, piDir, poolDir]) await mkdir(dir, { recursive: true });
  for (const [tool, cfg, dir] of [["claude", CLAUDE_CONFIG, claudeDir], ["codex", CODEX_CONFIG, codexDir], ["pi", PI_CONFIG, piDir]] as const) {
    saved[tool] = cfg.identitiesJsonPath;
    (cfg as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}.json`);
    await writeFile(cfg.identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: NAME, label: "Acme", configDir: dir }] }));
  }
  poolRegistry = join(root, "pool-registry.json");
  await writeFile(
    poolRegistry,
    JSON.stringify({
      version: 1,
      identities: [
        { name: NAME, label: "Acme", configDir: claudeDir },
        { name: "pool", label: "Pool", configDir: poolDir, swapPool: { accounts: [NAME], active: NAME } },
      ],
    }),
  );
});

afterEach(async () => {
  (CLAUDE_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.claude!;
  (CODEX_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.codex!;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi!;
  await rm(root, { recursive: true, force: true });
});

const farMs = () => (NOW + 600) * 1000;
const claudeFile = (dir: string) => join(dir, ".credentials.json");
const writeClaude = (dir: string, refresh: string, expiresAtMs = farMs()) =>
  writeFile(claudeFile(dir), JSON.stringify({ claudeAiOauth: { accessToken: "at-syn", refreshToken: refresh, expiresAt: expiresAtMs } }));
const piAnthropic = (refresh: string) => JSON.stringify({ anthropic: { type: "oauth", access: "at-pi", refresh, expires: farMs() } });

function postCounter(): { posts: () => number; fetchImpl: typeof fetch } {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { posts: () => n, fetchImpl };
}

describe("refresh with an unreadable store", () => {
  test("a transient read failure that clears on the re-read refreshes normally", async () => {
    await writeClaude(claudeDir, "rt-old");
    await writeFile(claudeFile(claudeDir), "{ torn");
    setTimeout(() => void writeClaude(claudeDir, "rt-old"), 15);
    const { posts, fetchImpl } = postCounter();
    const result = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), { force: true, fetchImpl, now: () => NOW * 1000 });
    expect(result.outcome).toBe("refreshed");
    expect(result.unreadableStores).toBeUndefined();
    expect(posts()).toBe(1);
  });

  test("an unreadable pi auth.json beside a healthy native store refreshes, leaves pi untouched and reports it", async () => {
    await writeClaude(claudeDir, "rt-old");
    await writeFile(join(piDir, "auth.json"), "{ torn");
    const { posts, fetchImpl } = postCounter();
    const result = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), { force: true, fetchImpl, now: () => NOW * 1000 });
    expect(result.outcome).toBe("refreshed");
    expect(result.unreadableStores).toEqual(["pi"]);
    expect(posts()).toBe(1);
    expect(await readFile(join(piDir, "auth.json"), "utf8")).toBe("{ torn");
    expect(JSON.parse(await readFile(claudeFile(claudeDir), "utf8")).claudeAiOauth.refreshToken).toBe("rt-new");
  });

  test("an unreadable pool copy beside a healthy native store refreshes and is not written over", async () => {
    await writeClaude(claudeDir, "rt-old");
    await writeFile(claudeFile(poolDir), "{ torn");
    const { posts, fetchImpl } = postCounter();
    const result = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), { force: true, fetchImpl, claudeRegistryPath: poolRegistry, now: () => NOW * 1000 });
    expect(result.outcome).toBe("refreshed");
    expect(result.unreadableStores).toEqual(["pool"]);
    expect(posts()).toBe(1);
    expect(await readFile(claudeFile(poolDir), "utf8")).toBe("{ torn");
  });

  test("an unreadable native store beside a pi grant still skips with readError (claude)", async () => {
    await writeFile(claudeFile(claudeDir), "{ torn");
    await writeFile(join(piDir, "auth.json"), piAnthropic("rt-other"));
    const { posts, fetchImpl } = postCounter();
    const result = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), { force: true, fetchImpl, now: () => NOW * 1000 });
    expect(result.outcome).toBe("skipped-read-error");
    expect(result.readError).toBe(true);
    expect(result.unreadableStores).toEqual(["native"]);
    expect(posts()).toBe(0);
  });

  test("an unreadable native store beside a pi grant still skips with readError (codex)", async () => {
    await writeFile(join(codexDir, "auth.json"), "{ torn");
    const piAuth = JSON.stringify({ "openai-codex": { type: "oauth", access: "at-pi", refresh: "rt-other", expires: farMs() } });
    await writeFile(join(piDir, "auth.json"), piAuth);
    const { posts, fetchImpl } = postCounter();
    const result = await refreshIdentityOAuthGrant("codex", identityIn(codexDir), { force: true, fetchImpl, now: () => NOW * 1000 });
    expect(result.outcome).toBe("skipped-read-error");
    expect(result.readError).toBe(true);
    expect(posts()).toBe(0);
    expect(await readFile(join(codexDir, "auth.json"), "utf8")).toBe("{ torn");
    expect(await readFile(join(piDir, "auth.json"), "utf8")).toBe(piAuth);
  });
});

describe("a block only applies when a refresh is due", () => {
  const piFor = (expiresMs: number) => JSON.stringify({ anthropic: { type: "oauth", access: "at-pi", refresh: "rt-other", expires: expiresMs } });

  for (const [label, registry] of [["pooled", () => poolRegistry], ["unpooled", () => undefined]] as const) {
    test(`${label}: a torn native store does not raise a read error while the token is not due, and does when it is`, async () => {
      await writeFile(claudeFile(claudeDir), "{ torn");
      const { posts, fetchImpl } = postCounter();
      const opts = () => ({ fetchImpl, now: () => NOW * 1000, ...(registry() ? { claudeRegistryPath: registry()! } : {}) });
      await writeFile(join(piDir, "auth.json"), piFor((NOW + 7 * 86_400) * 1000));
      const idle = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), opts());
      expect(idle.outcome).toBe("skipped-fresh");
      expect(idle.readError).toBeUndefined();
      await writeFile(join(piDir, "auth.json"), piFor(farMs()));
      const due = await refreshIdentityOAuthGrant("claude", identityIn(claudeDir), opts());
      expect(due.outcome).toBe("skipped-read-error");
      expect(posts()).toBe(0);
      expect(await readFile(claudeFile(claudeDir), "utf8")).toBe("{ torn");
    });
  }
});

describe("store classes are by location, not file name", () => {
  test("a codex pool copy named auth.json is a pool, the pi projection is pi, the member's own file is native", () => {
    const own = "/m/acme/auth.json";
    const pi = "/p/acme/auth.json";
    expect(storeClass("/m/pool/auth.json", own, pi)).toBe("pool");
    expect(storeClass(pi, own, pi)).toBe("pi");
    expect(storeClass(own, own, pi)).toBe("native");
    expect(storeClass("/m/pool/auth.json", own, undefined)).toBe("pool");
  });
});

describe("convergeClaudePoolStores with an unreadable store", () => {
  test("never writes over a pool copy whose read failed", async () => {
    await writeClaude(claudeDir, "rt-member");
    await writeFile(claudeFile(poolDir), "{ torn");
    const out = await convergeClaudePoolStores(identityIn(claudeDir), poolRegistry);
    expect(out.written).toEqual([]);
    expect(await readFile(claudeFile(poolDir), "utf8")).toBe("{ torn");
  });

  test("converges nothing when the member's own store is the unreadable one", async () => {
    await writeFile(claudeFile(claudeDir), "{ torn");
    await writeClaude(poolDir, "rt-pool");
    const out = await convergeClaudePoolStores(identityIn(claudeDir), poolRegistry);
    expect(out.written).toEqual([]);
    expect(await readFile(claudeFile(claudeDir), "utf8")).toBe("{ torn");
  });

  test("still converges readable stores", async () => {
    await writeClaude(claudeDir, "rt-new", farMs() + 5000);
    await writeClaude(poolDir, "rt-old");
    const out = await convergeClaudePoolStores(identityIn(claudeDir), poolRegistry);
    expect(out.written).toContain(poolDir);
  });
});
