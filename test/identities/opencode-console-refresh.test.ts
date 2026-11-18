import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthRefreshError } from "../../src/identities/oauth-refresh.ts";
import { opencodeConsoleFingerprint, readOpencodeConsoleGrant, refreshOpencodeConsoleGrant } from "../../src/identities/opencode-console-refresh.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
let dir = "";

const grant = (expires: number) => ({
  type: "oauth",
  methodID: "device",
  access: "SYNTHETIC_FIXTURE-oc-access-0001",
  refresh: "SYNTHETIC_FIXTURE-oc-refresh-0001",
  expires,
  metadata: { server: "https://console.example.test/console", orgID: "org-1", orgName: "Default" },
});

function seed(value: object, extra: (db: Database) => void = () => {}): void {
  const db = new Database(join(dir, "data", "opencode", "opencode.db"), { create: true });
  db.run("CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)");
  db.run("INSERT INTO credential VALUES ('cred-key','opencode','API key', ?, NULL, NULL, NULL, 1, 1)", [JSON.stringify({ type: "key", key: "SYNTHETIC_FIXTURE-oc-key-0001" })]);
  db.run("INSERT INTO credential VALUES ('cred-oauth','opencode','Default', ?, NULL, NULL, 1, 2, 2)", [JSON.stringify(value)]);
  extra(db);
  db.close();
}

const stored = (): Record<string, unknown> => {
  const db = new Database(join(dir, "data", "opencode", "opencode.db"), { readonly: true });
  try {
    return JSON.parse((db.query("SELECT value FROM credential WHERE id = 'cred-oauth'").get() as { value: string }).value);
  } finally {
    db.close();
  }
};

type Call = { url: string; body: Record<string, unknown> };
const fakeFetch = (status: number, body: unknown, calls: Call[] = [], before?: () => void) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    before?.();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "oc-console-"));
  await mkdir(join(dir, "data", "opencode"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OpenCode Console login renewal", () => {
  test("reads the OAuth row, not the API key row", () => {
    seed(grant(NOW + 10 * DAY));
    const g = readOpencodeConsoleGrant(dir)!;
    expect(g.rowId).toBe("cred-oauth");
    expect(g.server).toBe("https://console.example.test/console");
    expect(opencodeConsoleFingerprint(dir)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("no db or no OAuth login: skipped without a request", async () => {
    const calls: Call[] = [];
    expect((await refreshOpencodeConsoleGrant("id1", dir, { fetch: fakeFetch(200, {}, calls), now: () => NOW })).outcome).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  test("outside the window: skipped; inside: renewed with OpenCode's request and written back", async () => {
    seed(grant(NOW + 10 * DAY));
    const calls: Call[] = [];
    const ok = fakeFetch(200, { access_token: "SYNTHETIC_FIXTURE-oc-access-0002", refresh_token: "SYNTHETIC_FIXTURE-oc-refresh-0002", expires_in: 30 * 86_400 }, calls);
    expect((await refreshOpencodeConsoleGrant("id1", dir, { fetch: ok, now: () => NOW })).outcome).toBe("skipped");
    expect(calls.length).toBe(0);

    const r = await refreshOpencodeConsoleGrant("id1", dir, { fetch: ok, now: () => NOW + 8 * DAY });
    expect(r.outcome).toBe("refreshed");
    expect(calls).toEqual([
      { url: "https://console.example.test/console/auth/device/token", body: { grant_type: "refresh_token", refresh_token: "SYNTHETIC_FIXTURE-oc-refresh-0001", client_id: "opencode-cli" } },
    ]);
    const v = stored();
    expect(v.access).toBe("SYNTHETIC_FIXTURE-oc-access-0002");
    expect(v.refresh).toBe("SYNTHETIC_FIXTURE-oc-refresh-0002");
    expect(v.expires).toBe(NOW + 8 * DAY + 30 * DAY);
    expect(v.methodID).toBe("device");
    expect((v.metadata as Record<string, unknown>).orgName).toBe("Default");
  });

  test("force renews a fresh login", async () => {
    seed(grant(NOW + 20 * DAY));
    const r = await refreshOpencodeConsoleGrant("id1", dir, { force: true, fetch: fakeFetch(200, { access_token: "SYNTHETIC_FIXTURE-oc-access-0003", refresh_token: "SYNTHETIC_FIXTURE-oc-refresh-0003", expires_in: 60 }), now: () => NOW });
    expect(r.outcome).toBe("refreshed");
    expect(stored().access).toBe("SYNTHETIC_FIXTURE-oc-access-0003");
  });

  test("invalid_grant is a revoked error pinned to the grant, and that grant is then skipped", async () => {
    seed(grant(NOW + DAY));
    const err = await refreshOpencodeConsoleGrant("id1", dir, { fetch: fakeFetch(400, { error: "invalid_grant" }), now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect((err as OAuthRefreshError).revoked).toBe(true);
    expect((err as OAuthRefreshError).message).not.toContain("SYNTHETIC_FIXTURE");
    const calls: Call[] = [];
    const r = await refreshOpencodeConsoleGrant("id1", dir, { fetch: fakeFetch(200, {}, calls), now: () => NOW, revokedFingerprint: (err as OAuthRefreshError).refreshFingerprint! });
    expect(r.outcome).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  test("a server error fails without touching the row", async () => {
    seed(grant(NOW + DAY));
    const err = await refreshOpencodeConsoleGrant("id1", dir, { fetch: fakeFetch(500, { error: "server_error" }), now: () => NOW }).catch((e: unknown) => e);
    expect((err as OAuthRefreshError).revoked).toBe(false);
    expect(stored().access).toBe("SYNTHETIC_FIXTURE-oc-access-0001");
  });

  test("a row OpenCode rewrote during the request is kept", async () => {
    seed(grant(NOW + DAY));
    const racing = () => {
      const db = new Database(join(dir, "data", "opencode", "opencode.db"));
      db.run("UPDATE credential SET value = ? WHERE id = 'cred-oauth'", [JSON.stringify({ ...grant(NOW + 30 * DAY), access: "SYNTHETIC_FIXTURE-oc-access-opencode" })]);
      db.close();
    };
    const r = await refreshOpencodeConsoleGrant("id1", dir, { fetch: fakeFetch(200, { access_token: "SYNTHETIC_FIXTURE-oc-access-0004", refresh_token: "SYNTHETIC_FIXTURE-oc-refresh-0004", expires_in: 60 }, [], racing), now: () => NOW });
    expect(r.outcome).toBe("skipped");
    expect(stored().access).toBe("SYNTHETIC_FIXTURE-oc-access-opencode");
  });
});
