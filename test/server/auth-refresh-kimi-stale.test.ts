import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantFingerprint } from "../../src/identities/oauth-reconcile.ts";
import { OAuthRefreshError, refreshIdentityOAuthGrant } from "../../src/identities/oauth-refresh.ts";
import { KIMI_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";
import { AuthRefreshScheduler } from "../../src/server/auth-refresh.ts";

// Real OAuth path (kimi): the default fingerprint reader runs against temp
// stores. Registries are repointed at temp files and restored afterwards;
// token values are short synthetic strings.
const NAME = "acme";
const saved: Record<string, string> = {};
let root = "";
let kimiDir = "";
let piDir = "";
let identity: Identity;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-stale-pin-"));
  kimiDir = join(root, "kimi", NAME);
  piDir = join(root, "pi", NAME);
  await mkdir(kimiDir, { recursive: true });
  await mkdir(piDir, { recursive: true });
  identity = { name: NAME, label: "Acme", configDir: kimiDir };
  for (const [tool, cfg, dir] of [["kimi", KIMI_CONFIG, kimiDir], ["pi", PI_CONFIG, piDir]] as const) {
    saved[tool] = cfg.identitiesJsonPath;
    (cfg as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}.json`);
    await writeFile(cfg.identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: NAME, label: "Acme", configDir: dir }] }));
  }
});

afterEach(async () => {
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.kimi!;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi!;
  await rm(root, { recursive: true, force: true });
});

const KIMI_FILE = () => join(kimiDir, "credentials", "kimi-code.json");
const farFuture = () => Date.now() + 7 * 24 * 3600 * 1000;

async function writeKimi(refreshToken: string): Promise<void> {
  await mkdir(join(kimiDir, "credentials"), { recursive: true });
  await writeFile(
    KIMI_FILE(),
    JSON.stringify({ access_token: "at-syn", refresh_token: refreshToken, expires_at: Math.floor(farFuture() / 1000) }),
  );
}

async function revokedScheduler(oldRefresh: string): Promise<AuthRefreshScheduler> {
  const stateHome = await mkdtemp(join(root, "state-"));
  const fp = grantFingerprint({ access_token: "at-syn", refresh_token: oldRefresh });
  const scheduler = new AuthRefreshScheduler(
    0,
    {
      kimi: async () => {
        throw new OAuthRefreshError("refresh token revoked", true, fp);
      },
    },
    async () => [identity],
    stateHome,
  );
  await scheduler.refreshNow("kimi", NAME);
  return scheduler;
}

describe("stale revoked pin on the real kimi path", () => {
  test("a re-login (new refresh token) clears the pin; the same token keeps it", async () => {
    await writeKimi("rt-old");
    const scheduler = await revokedScheduler("rt-old");
    await scheduler.reconcileStale();
    expect(scheduler.status()[0]!.revoked).toBe(true);

    await writeKimi("rt-new");
    await scheduler.reconcileStale();
    const status = scheduler.status()[0]!;
    expect(status.revoked).toBe(false);
    expect(status.lastError).toBeNull();
    expect(status.consecutiveFailures).toBe(0);
  });

  test("an unreadable native store beside a different pi grant keeps the pin", async () => {
    await writeKimi("rt-old");
    const scheduler = await revokedScheduler("rt-old");
    await writeFile(KIMI_FILE(), "{ torn");
    await writeFile(
      join(piDir, "auth.json"),
      JSON.stringify({ "kimi-coding": { type: "oauth", access: "at-pi", refresh: "rt-other", expires: farFuture() } }),
    );
    await scheduler.reconcileStale();
    expect(scheduler.status()[0]!.revoked).toBe(true);
  });

  test("the refresh path reports a torn store as a read error, not a logged-out identity", async () => {
    await mkdir(join(kimiDir, "credentials"), { recursive: true });
    await writeFile(KIMI_FILE(), "{ torn");
    const result = await refreshIdentityOAuthGrant("kimi", identity, { force: true });
    expect(result.outcome).toBe("no-grant");
    expect(result.readError).toBe(true);
  });

  test("a torn native store beside a pi grant skips the refresh: readError, no POST", async () => {
    await mkdir(join(kimiDir, "credentials"), { recursive: true });
    await writeFile(KIMI_FILE(), "{ torn");
    await writeFile(
      join(piDir, "auth.json"),
      JSON.stringify({ "kimi-coding": { type: "oauth", access: "at-pi", refresh: "rt-other", expires: Date.now() - 3600_000 } }),
    );
    let posts = 0;
    const fetchImpl = (async () => {
      posts += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await refreshIdentityOAuthGrant("kimi", identity, { force: true, fetchImpl });
    expect(result.outcome).toBe("skipped-read-error");
    expect(result.readError).toBe(true);
    expect(posts).toBe(0);
  });

  test("the scheduler surfaces the skip as lastError without pinning a revoked diagnosis", async () => {
    await mkdir(join(kimiDir, "credentials"), { recursive: true });
    await writeFile(KIMI_FILE(), "{ torn");
    await writeFile(
      join(piDir, "auth.json"),
      JSON.stringify({ "kimi-coding": { type: "oauth", access: "at-pi", refresh: "rt-other", expires: Date.now() - 3600_000 } }),
    );
    const stateHome = await mkdtemp(join(root, "state-"));
    const scheduler = new AuthRefreshScheduler(0, undefined, async () => [identity], stateHome);
    await scheduler.refreshNow("kimi", NAME);
    const status = scheduler.status().find((entry) => entry.tool === "kimi")!;
    expect(status.lastError).toContain("could not be read");
    expect(status.revoked).toBe(false);
    expect(status.consecutiveFailures).toBe(1);
  });
});
