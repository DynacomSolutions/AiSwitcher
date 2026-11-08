import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantFingerprint } from "../../src/identities/oauth-reconcile.ts";
import { OAuthRefreshError } from "../../src/identities/oauth-refresh.ts";
import { CLAUDE_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";
import { AuthRefreshScheduler } from "../../src/server/auth-refresh.ts";

// Real OAuth path (claude): the default fingerprint reader runs against temp
// stores. Registries are repointed at temp files and restored afterwards;
// token values are short synthetic strings.
const NAME = "acme";
const saved: Record<string, string> = {};
let root = "";
let claudeDir = "";
let piDir = "";
let identity: Identity;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-stale-pin-"));
  claudeDir = join(root, "claude", NAME);
  piDir = join(root, "pi", NAME);
  await mkdir(claudeDir, { recursive: true });
  await mkdir(piDir, { recursive: true });
  identity = { name: NAME, label: "Acme", configDir: claudeDir };
  for (const [tool, cfg, dir] of [["claude", CLAUDE_CONFIG, claudeDir], ["pi", PI_CONFIG, piDir]] as const) {
    saved[tool] = cfg.identitiesJsonPath;
    (cfg as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}.json`);
    await writeFile(cfg.identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: NAME, label: "Acme", configDir: dir }] }));
  }
});

afterEach(async () => {
  (CLAUDE_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.claude!;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi!;
  await rm(root, { recursive: true, force: true });
});

const farFuture = () => Date.now() + 7 * 24 * 3600 * 1000;

async function writeClaude(refreshToken: string): Promise<void> {
  await writeFile(
    join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "at-syn", refreshToken, expiresAt: farFuture() } }),
  );
}

async function revokedScheduler(oldRefresh: string): Promise<AuthRefreshScheduler> {
  const stateHome = await mkdtemp(join(root, "state-"));
  const fp = grantFingerprint({ access_token: "at-syn", refresh_token: oldRefresh });
  const scheduler = new AuthRefreshScheduler(
    0,
    {
      claude: async () => {
        throw new OAuthRefreshError("refresh token revoked", true, fp);
      },
    },
    async () => [identity],
    stateHome,
  );
  await scheduler.refreshNow("claude", NAME);
  return scheduler;
}

describe("stale revoked pin on the real claude path", () => {
  test("a re-login (new refresh token) clears the pin; the same token keeps it", async () => {
    await writeClaude("rt-old");
    const scheduler = await revokedScheduler("rt-old");
    await scheduler.reconcileStale();
    expect(scheduler.status()[0]!.revoked).toBe(true);

    await writeClaude("rt-new");
    await scheduler.reconcileStale();
    const status = scheduler.status()[0]!;
    expect(status.revoked).toBe(false);
    expect(status.lastError).toBeNull();
    expect(status.consecutiveFailures).toBe(0);
  });

  test("an unreadable native store beside a different pi grant keeps the pin", async () => {
    await writeClaude("rt-old");
    const scheduler = await revokedScheduler("rt-old");
    await writeFile(join(claudeDir, ".credentials.json"), "{ torn");
    await writeFile(
      join(piDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "at-pi", refresh: "rt-other", expires: farFuture() } }),
    );
    await scheduler.reconcileStale();
    expect(scheduler.status()[0]!.revoked).toBe(true);
  });
});
