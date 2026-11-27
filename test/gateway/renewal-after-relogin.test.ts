import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { buildRenewalReport } from "../../src/gateway/renewal.ts";
import { grantFingerprint } from "../../src/identities/oauth-reconcile.ts";
import type { Identity } from "../../src/identities/types.ts";

/**
 * After a new sign-in the newest journal row is still the old login's error. The renewal report must show the new login
 * as healthy: an error recorded for another refresh token, or before the stored login was minted, belongs to the old login.
 */
const NOW = 1_789_200_000;
const ACCOUNT = "acct-a";
let root: string;
let configDir: string;
const ID = (): Identity => ({ name: ACCOUNT, label: ACCOUNT, configDir });

const savedMemberStore = process.env.AIS_GATEWAY_MEMBER_STORE;
beforeAll(() => {
  process.env.AIS_GATEWAY_MEMBER_STORE = "0";
});
afterAll(() => {
  if (savedMemberStore === undefined) delete process.env.AIS_GATEWAY_MEMBER_STORE;
  else process.env.AIS_GATEWAY_MEMBER_STORE = savedMemberStore;
});
let savedOwnerRole: string | undefined;
beforeEach(async () => {
  savedOwnerRole = process.env.AIS_GATEWAY_OWNER;
  process.env.AIS_GATEWAY_OWNER = "1";
  root = await mkdtemp(join(tmpdir(), "ais-renewal-relogin-"));
  configDir = join(root, "identities", ACCOUNT);
  await mkdir(configDir, { recursive: true });
});
afterEach(async () => {
  if (savedOwnerRole === undefined) delete process.env.AIS_GATEWAY_OWNER;
  else process.env.AIS_GATEWAY_OWNER = savedOwnerRole;
  await rm(root, { recursive: true, force: true });
});

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (iat: number, exp: number): string => `${b64({ alg: "none" })}.${b64({ iat, exp })}.sig`;

/** A stored login for the tool, minted at `mintedAt` (unix seconds), expiring 8 hours later. */
async function writeLogin(tool: "claude" | "codex", refresh: string, mintedAt: number): Promise<string> {
  const expires = mintedAt + 8 * 3600;
  if (tool === "claude") {
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `at-${refresh}`, refreshToken: refresh, expiresAt: expires * 1000 } }));
  } else {
    await writeFile(join(configDir, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(mintedAt, expires), refresh_token: refresh }, last_refresh: new Date(mintedAt * 1000).toISOString() }));
  }
  return grantFingerprint({ access_token: "x", refresh_token: refresh });
}

/** Journals one resolved claim and returns its time stamp through the summary. */
async function journal(backend: MemoryRefreshBackend, oldFp: string, outcome: "dead" | "failed", code: string): Promise<void> {
  const lock = await backend.acquire({ provider: TOOL_UNDER_TEST, identity: ACCOUNT }, 1000);
  const id = await lock.claim(oldFp, "pod-1:1");
  await lock.resolve(id, outcome, undefined, code);
  await lock.release();
}

let TOOL_UNDER_TEST: "claude" | "codex" = "claude";
const report = (backend: MemoryRefreshBackend, now?: Date) =>
  buildRenewalReport({ tools: [TOOL_UNDER_TEST], accounts: async () => [ID()], summary: () => backend.summary(), ...(now ? { now: () => now } : {}) }).then((rows) => rows[0]!);

for (const tool of ["claude", "codex"] as const) {
  describe(`renewal report after a new sign-in (${tool})`, () => {
    beforeEach(() => {
      TOOL_UNDER_TEST = tool;
    });

    test("a dead row for the old login does not show and does not revoke the new login", async () => {
      // The journal time stamp is the real clock, so the new login is minted in the future of the journal row.
      const oldFp = grantFingerprint({ access_token: "x", refresh_token: "rt-old" });
      const backend = new MemoryRefreshBackend();
      await journal(backend, oldFp, "dead", "refresh_token_invalidated");
      await writeLogin(tool, "rt-new", Math.floor(Date.now() / 1000) + 60);
      const row = await report(backend);
      expect(row.lastError).toBeNull();
      expect(row.revoked).toBe(false);
      expect(row.nextRefreshAt).not.toBeNull();
    });

    test("a failed row for the old login does not show either, even when the new login is older than the row", async () => {
      const oldFp = grantFingerprint({ access_token: "x", refresh_token: "rt-old" });
      const backend = new MemoryRefreshBackend();
      await journal(backend, oldFp, "failed", "transport");
      // Minted long before the journal row: only the fingerprint tells the logins apart.
      await writeLogin(tool, "rt-new", NOW);
      const row = await report(backend);
      expect(row.lastError).toBeNull();
      expect(row.revoked).toBe(false);
    });

    // Only codex stores a mint time in its grant, so only it can show the skew case.
    for (const skewS of [2, 30]) {
      (tool === "codex" ? test : test.skip)(`a dead row for the current refresh token still revokes it when the access token is ${skewS} s newer than the row`, async () => {
        const fp = await writeLogin(tool, "rt-same", Math.floor(Date.now() / 1000) + skewS);
        const backend = new MemoryRefreshBackend();
        await journal(backend, fp, "dead", "refresh_token_invalidated");
        const row = await report(backend);
        expect(row.revoked).toBe(true);
        expect(row.lastError).toMatchObject({ code: "refresh_token_invalidated" });
        expect(row.nextRefreshAt).toBeNull();
      });
    }

    (tool === "codex" ? test : test.skip)("a failed row for the current refresh token still shows when the access token is newer than the row", async () => {
      const fp = await writeLogin(tool, "rt-same", Math.floor(Date.now() / 1000) + 30);
      const backend = new MemoryRefreshBackend();
      await journal(backend, fp, "failed", "transport");
      const row = await report(backend);
      expect(row.lastError).toMatchObject({ code: "transport" });
      expect(row.revoked).toBe(false);
    });

    // Without a refresh token the grant has no fingerprint, so the mint time is the only way to date the error.
    (tool === "codex" ? test : test.skip)("a grant with no fingerprint falls back to the mint time", async () => {
      const mintedAt = Math.floor(Date.now() / 1000) + 3600;
      await writeFile(join(configDir, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(mintedAt, mintedAt + 8 * 3600) }, last_refresh: new Date(mintedAt * 1000).toISOString() }));
      const backend = new MemoryRefreshBackend();
      await journal(backend, grantFingerprint({ access_token: "x", refresh_token: "rt-old" }), "failed", "transport");
      const newer = await report(backend);
      expect(newer.lastError).toBeNull();
      await writeFile(join(configDir, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(NOW, NOW + 8 * 3600) }, last_refresh: new Date(NOW * 1000).toISOString() }));
      const older = await report(backend);
      expect(older.lastError).toMatchObject({ code: "transport" });
    });

    test("a dead row for the current refresh token still revokes the login", async () => {
      const fp = await writeLogin(tool, "rt-live", NOW);
      const backend = new MemoryRefreshBackend();
      await journal(backend, fp, "dead", "refresh_token_invalidated");
      const row = await report(backend);
      expect(row.revoked).toBe(true);
      expect(row.lastError).toMatchObject({ code: "refresh_token_invalidated" });
      expect(row.nextRefreshAt).toBeNull();
    });

    test("a failed row for the current refresh token still shows as the last error", async () => {
      const fp = await writeLogin(tool, "rt-live", NOW);
      const backend = new MemoryRefreshBackend();
      await journal(backend, fp, "failed", "transport");
      const row = await report(backend);
      expect(row.revoked).toBe(false);
      expect(row.lastError).toMatchObject({ code: "transport" });
    });
  });
}
