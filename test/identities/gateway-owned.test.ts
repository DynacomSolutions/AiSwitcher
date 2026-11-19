import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialCache } from "../../src/gateway/credentials.ts";
import { runAuthCommand } from "../../src/cli/auth/dispatch.ts";
import { fetchKimiUsageForCredentials } from "../../src/cli/limits/kimi-limits.ts";
import { kimiRefreshContext } from "../../src/cli/limits/kimi-store.ts";
import { HEARTBEAT_FRESH_MS, writeHeartbeat } from "../../src/identities/gateway-heartbeat.ts";
import { isGatewayManagedHere } from "../../src/identities/gateway-managed.ts";
import { isStickyOwned, readOwned, recordOwned, releaseOwned } from "../../src/identities/gateway-owned.ts";
import { refreshIdentityOAuthGrant, type RefreshableTool } from "../../src/identities/oauth-refresh.ts";
import { importPiCredentials, syncPiCredentials } from "../../src/identities/pi-auth.ts";
import { isGatewayMember } from "../../src/identities/pool/gateway-pool.ts";
import { CODEX_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";
import { AuthRefreshScheduler } from "../../src/server/auth-refresh.ts";
import { runReleaseCommand } from "../../src/cli/gateway/dispatch.ts";

// Sticky gateway ownership: a login the gateway ever named stays the gateway's on this host, whatever the heartbeat says.
// Every name and token below is a fake value.

const NAME = "acme";
const TOOLS: RefreshableTool[] = ["claude", "codex", "grok", "kimi"];
const SAVED = ["AIS_GATEWAY_OWNER", "AIS_GATEWAY_HEARTBEAT", "AIS_GATEWAY_OWNED", "AIS_GATEWAY_MEMBERS_DIR"] as const;
const realFetch = globalThis.fetch;

let root = "";
let saved: Record<string, string | undefined> = {};
let fetched: string[] = [];

const beat = (ageMs: number, held: string[]) =>
  writeHeartbeat({ version: 1, passAt: new Date(Date.now() - ageMs).toISOString(), held: Object.fromEntries(held.map((k) => [k, {}])) });
const identity = (): Identity => ({ name: NAME, label: NAME, configDir: join(root, "folder", NAME) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-gw-owned-"));
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  process.env.AIS_GATEWAY_OWNER = "0";
  process.env.AIS_GATEWAY_HEARTBEAT = join(root, "heartbeat.json");
  process.env.AIS_GATEWAY_OWNED = join(root, "owned.json");
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
  fetched = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    return new Response("{}", { status: 400 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe("the ownership record", () => {
  test("only grows from heartbeats, keeps the first time, and a release removes one login", async () => {
    expect(await isStickyOwned("codex", NAME)).toBe(false);
    expect(await recordOwned(["codex/acme", "claude/acme", "bogus"], "2026-01-01T00:00:00.000Z")).toEqual(["codex/acme", "claude/acme"]);
    expect(await recordOwned(["codex/acme"], "2026-01-02T00:00:00.000Z")).toEqual([]);
    const record = await readOwned();
    expect(record.owned["codex/acme"]).toEqual({ since: "2026-01-01T00:00:00.000Z", lastHeldAt: "2026-01-02T00:00:00.000Z" });
    expect(await recordOwned([], "2026-01-03T00:00:00.000Z")).toEqual([]); // an empty heartbeat removes nothing
    expect(await isStickyOwned("codex", NAME)).toBe(true);
    expect(await releaseOwned("codex", NAME)).toBe(true);
    expect(await releaseOwned("codex", NAME)).toBe(false);
    expect(await isStickyOwned("codex", NAME)).toBe(false);
    expect(await isStickyOwned("claude", NAME)).toBe(true);
  });

  test("a malformed record is an empty record", async () => {
    await writeFile(process.env.AIS_GATEWAY_OWNED!, "{not json");
    expect(await isStickyOwned("codex", NAME)).toBe(false);
  });
});

describe("one check: isGatewayManagedHere", () => {
  const registry = () => join(root, "identities.json");
  beforeEach(async () => {
    await writeFile(registry(), JSON.stringify({ version: 1, identities: [{ name: NAME, label: NAME, configDir: join(root, "folder", NAME) }] }));
  });

  test("a stale heartbeat after a fresh one still leaves codex, grok and kimi owned (latched on the first sighting)", async () => {
    for (const tool of ["codex", "grok", "kimi"]) {
      await beat(1000, [`${tool}/${NAME}`]);
      expect(await isGatewayManagedHere(tool, NAME, registry())).toBe(true);
      await beat(HEARTBEAT_FRESH_MS + 60_000, [`${tool}/${NAME}`]);
      expect(await isGatewayManagedHere(tool, NAME, registry())).toBe(true); // stale heartbeat, still owned
      await rm(process.env.AIS_GATEWAY_HEARTBEAT!);
      expect(await isGatewayManagedHere(tool, NAME, registry())).toBe(true); // no heartbeat at all, still owned
    }
  });

  test("a login the heartbeat never named is not claimed, and a heartbeat that names a login the registry lacks does not latch it", async () => {
    await beat(1000, ["codex/unknown"]);
    expect(await isGatewayManagedHere("codex", "unknown", registry())).toBe(false);
    expect(await isStickyOwned("codex", "unknown")).toBe(false);
    expect(await isGatewayManagedHere("codex", NAME, registry())).toBe(false);
  });

  test("a recorded claude login of a retired identity stays owned until a release hands it back; an active identity is always managed", async () => {
    const reg = join(root, "claude-identities.json");
    await writeFile(reg, JSON.stringify({ version: 1, identities: [{ name: NAME, label: NAME, configDir: join(root, "folder", NAME), retired: true }, { name: "live", label: "live", configDir: join(root, "folder", "live") }] }));
    expect(await isGatewayManagedHere("claude", "live", reg)).toBe(true);
    expect(await isGatewayManagedHere("claude", NAME, reg)).toBe(false);
    await recordOwned([`claude/${NAME}`], new Date().toISOString());
    expect(await isGatewayManagedHere("claude", NAME, reg)).toBe(true);
    await releaseOwned("claude", NAME);
    expect(await isGatewayManagedHere("claude", NAME, reg)).toBe(false);
  });

  test("the gateway process itself is never blocked, and an unserved tool is never claimed", async () => {
    await recordOwned([`codex/${NAME}`, `zai/${NAME}`], new Date().toISOString());
    process.env.AIS_GATEWAY_OWNER = "1";
    expect(await isGatewayManagedHere("codex", NAME, registry())).toBe(false);
    process.env.AIS_GATEWAY_OWNER = "0";
    expect(await isGatewayManagedHere("zai", NAME, registry())).toBe(false);
  });

  test("a swap pool treats a recorded login as a gateway member", async () => {
    expect(isGatewayMember("claude", identity())).toBe(false);
    await recordOwned([`claude/${NAME}`], new Date().toISOString());
    expect(isGatewayMember("claude", identity())).toBe(true);
  });
});

describe("every host refresher, stale heartbeat, no member copy", () => {
  beforeEach(async () => {
    // Expired fake logins, so an unguarded refresh would reach the token endpoint.
    const dir = identity().configDir;
    await mkdir(join(dir, "credentials"), { recursive: true });
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "at-fake", refreshToken: "rt-fake", expiresAt: 1_000 } }));
    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "at-fake", refresh_token: "rt-fake" }, last_refresh: "2020-01-01T00:00:00.000Z" }));
    await writeFile(join(dir, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "at-fake", refresh_token: "rt-fake", expires_at: 1 }));
    await recordOwned(TOOLS.map((t) => `${t}/${NAME}`), new Date().toISOString());
    await beat(HEARTBEAT_FRESH_MS + 3_600_000, TOOLS.map((t) => `${t}/${NAME}`)); // stale
  });

  test("refreshIdentityOAuthGrant (the path of ais gateway local, the web daemon and the CLI) sends nothing, even forced", async () => {
    for (const tool of TOOLS) {
      for (const force of [false, true]) {
        const r = await refreshIdentityOAuthGrant(tool, identity(), { force, fetchImpl: globalThis.fetch as never });
        expect(r.outcome).toBe("skipped-fresh");
        expect(r.detail).toContain("owned by the cluster gateway");
      }
    }
    expect(fetched).toEqual([]);
  });

  test("the web daemon scheduler sends nothing for any tool, not even a manual run", async () => {
    const stateHome = await mkdtemp(join(root, "state-"));
    const s = new AuthRefreshScheduler(0, undefined, async (tool) => (TOOLS.includes(tool as RefreshableTool) ? [identity()] : []), stateHome, 24, async () => undefined, async () => new Set());
    await s.tick();
    for (const tool of TOOLS) await s.refreshNow(tool, NAME);
    expect(fetched).toEqual([]);
  });

  test("ais auth refresh sends nothing and says the gateway owns the login", async () => {
    const saved = CODEX_CONFIG.identitiesJsonPath;
    (CODEX_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "codex.json");
    await writeFile(CODEX_CONFIG.identitiesJsonPath, JSON.stringify({ version: 1, identities: [identity()] }));
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await runAuthCommand(["refresh", NAME], { tool: "codex", force: true });
    } finally {
      console.log = log;
      (CODEX_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved;
    }
    expect(fetched).toEqual([]);
    expect(lines.join("\n")).toContain("owned by the cluster gateway");
  });

  test("the host proxy credential cache sends nothing on an expired token or a 401 for an owned codex login without a store entry", async () => {
    const saved = CODEX_CONFIG.identitiesJsonPath;
    (CODEX_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "codex.json");
    await writeFile(CODEX_CONFIG.identitiesJsonPath, JSON.stringify({ version: 1, identities: [identity()] }));
    try {
      const cache = new CredentialCache();
      await cache.get("codex", NAME).catch(() => undefined);
      await cache.refreshAfter401("codex", NAME, "at-fake").catch(() => undefined);
    } finally {
      (CODEX_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved;
    }
    expect(fetched).toEqual([]);
  });

  test("a kimi usage refresh sends nothing for a kimi identity and for a pi-only identity", async () => {
    for (const self of ["kimi", "pi"] as const) {
      const ctx = await kimiRefreshContext(identity(), self);
      expect(ctx.gatewayManaged).toBe(true);
      const out = await fetchKimiUsageForCredentials({ access_token: "at-fake", refresh_token: "rt-fake", expires_at: 1 } as never, async () => {}, ctx);
      expect(out.error).toBeDefined();
    }
    expect(fetched.every((u) => u.includes("/usages"))).toBe(true); // reads only, never the token endpoint
  });
});

describe("kimi usage refresh without a kimi identity", () => {
  test("a pi-only identity that nobody owns still refreshes under a lock named after its own folder", async () => {
    const dir = join(root, "pi", NAME);
    await mkdir(dir, { recursive: true });
    const ctx = await kimiRefreshContext({ name: "only-in-pi", label: "x", configDir: dir }, "pi");
    expect(ctx.gatewayManaged).toBeUndefined();
    expect(ctx.lockDir).toBe(dir);
  });
});

describe("pi credentials never take a copy of a gateway-owned login", () => {
  const files = async (): Promise<{ claude: string; kimi: string; pi: string }> => {
    const claude = join(root, "claude-src");
    const kimi = join(root, "kimi-src");
    const pi = join(root, "pi-dst");
    await mkdir(join(kimi, "credentials"), { recursive: true });
    await mkdir(claude, { recursive: true });
    await writeFile(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "at-fake", refreshToken: "rt-fake", expiresAt: 4_102_444_800_000 } }));
    await writeFile(join(kimi, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "kat-fake", refresh_token: "krt-fake", expires_at: 4_102_444_800 }));
    return { claude, kimi, pi };
  };

  test("import and sync leave out an owned login (stale heartbeat), keep an unowned one, and say so", async () => {
    const d = await files();
    await recordOwned([`claude/${NAME}`], new Date().toISOString());
    await beat(HEARTBEAT_FRESH_MS + 60_000, [`claude/${NAME}`]);
    const imported = await importPiCredentials(d.pi, { claude: d.claude, kimi: d.kimi }, { claude: NAME, kimi: "other" });
    expect(imported.providers).toEqual(["kimi-coding"]);
    expect(imported.skippedOwned).toEqual(["anthropic"]);
    const auth = JSON.parse(await readFile(join(d.pi, "auth.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(auth)).toEqual(["kimi-coding"]);
    const synced = await syncPiCredentials(join(root, "pi-two"), { claude: d.claude }, { claude: NAME }).then(() => undefined, (e: Error) => e);
    expect(synced?.message).toContain("gateway owns the login for anthropic");
    await expect(readFile(join(root, "pi-two", "auth.json"), "utf8")).rejects.toThrow();
    const other = await syncPiCredentials(join(root, "pi-three"), { claude: d.claude }, { claude: "someone-else" });
    expect(other.added).toEqual(["anthropic"]);
    expect(other.skippedOwned).toEqual([]);
  });
});

describe("ais gateway release", () => {
  const deps = () => {
    const out: string[] = [];
    return { out, deps: { out: (l: string) => void out.push(l) } as never };
  };

  test("refuses while a fresh heartbeat names the login, releases with --force or once the heartbeat dropped it", async () => {
    await recordOwned([`codex/${NAME}`], new Date().toISOString());
    await beat(1000, [`codex/${NAME}`]);
    const a = deps();
    await expect(runReleaseCommand([`codex/${NAME}`], false, a.deps)).rejects.toThrow("still named by a fresh gateway heartbeat");
    expect(await isStickyOwned("codex", NAME)).toBe(true);
    await beat(1000, ["codex/other"]);
    await runReleaseCommand([`codex/${NAME}`], false, a.deps);
    expect(a.out.join("\n")).toContain("released");
    expect(await isStickyOwned("codex", NAME)).toBe(false);
    await runReleaseCommand([`codex/${NAME}`], false, a.deps);
    expect(a.out.at(-1)).toContain("not owned");
    await recordOwned([`kimi/${NAME}`], new Date().toISOString());
    await beat(1000, [`kimi/${NAME}`]);
    await runReleaseCommand([`kimi/${NAME}`], true, a.deps);
    expect(await isStickyOwned("kimi", NAME)).toBe(false);
  });

  test("needs exactly <tool>/<identity>", async () => {
    for (const bad of [[], ["codex"], ["codex/"], ["/x"], ["a/b", "c/d"]]) {
      await expect(runReleaseCommand(bad, false, deps().deps)).rejects.toThrow("Usage");
    }
  });
});

