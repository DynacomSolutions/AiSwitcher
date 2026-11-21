import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { accountInfoFor, accountsDiffer, collectAccounts, decodeJwtPayload, markSharedAccounts } from "../../src/identities/account-info.ts";
import type { Identity } from "../../src/identities/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-acct-"));
  dirs.push(d);
  return d;
};
const jwt = (claims: object): string => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.SYNTHETIC_FIXTURE_sig`;
};
const ident = (name: string, configDir: string): Identity => ({ name, label: name, configDir });
const claudeJson = (email: string, uuid: string, org?: string) => JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid, ...(org ? { organizationName: org } : {}) } });

async function seed(dir: string, file: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}

describe("accountInfoFor", () => {
  test("claude folder login", async () => {
    const root = await temp();
    await seed(join(root, "alpha"), ".claude.json", claudeJson("alice@example.test", "00000000-0000-0000-0000-000000000001", "Example Org"));
    const info = await accountInfoFor("claude", ident("alpha", join(root, "alpha")), join(root, "members"));
    expect(info).toEqual({ source: "folder", email: "alice@example.test", accountId: "00000000-0000-0000-0000-000000000001", organization: "Example Org" });
  });

  test("claude gateway member wins and a different folder account is a mismatch", async () => {
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "claude", "alpha"), ".claude.json", claudeJson("alice@example.test", "id-a"));
    await seed(join(root, "alpha"), ".claude.json", claudeJson("bob@example.test", "id-b"));
    const info = await accountInfoFor("claude", ident("alpha", join(root, "alpha")), members);
    expect(info?.source).toBe("gateway-member");
    expect(info?.email).toBe("alice@example.test");
    expect(info?.mismatch).toEqual({ folderEmail: "bob@example.test", folderAccountId: "id-b" });
  });

  test("claude member and folder on the same account give no mismatch", async () => {
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "claude", "alpha"), ".claude.json", claudeJson("alice@example.test", "id-a"));
    await seed(join(root, "alpha"), ".claude.json", claudeJson("ALICE@example.test", "id-a"));
    const info = await accountInfoFor("claude", ident("alpha", join(root, "alpha")), members);
    expect(info?.mismatch).toBeUndefined();
  });

  const gatewayEntry = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_key", refreshToken: null, expiresAt: 4102444800000, scopes: [] }, aisGatewayRouting: { host: "h", at: 1, fingerprints: [] } });
  const realLogin = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-SYNTHETIC_FIXTURE-a", refreshToken: "rt-SYNTHETIC_FIXTURE-a", expiresAt: 1, scopes: [] } });

  test("claude folder with only the gateway entry and a stale cached account gives no mismatch", async () => {
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "claude", "alpha"), ".claude.json", claudeJson("alice@example.test", "id-a"));
    await seed(join(root, "alpha"), ".claude.json", claudeJson("old@example.test", "id-old"));
    await seed(join(root, "alpha"), ".credentials.json", gatewayEntry);
    const info = await accountInfoFor("claude", ident("alpha", join(root, "alpha")), members);
    expect(info?.email).toBe("alice@example.test");
    expect(info?.mismatch).toBeUndefined();
  });

  test("claude folder with a real different login still gives a mismatch", async () => {
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "claude", "alpha"), ".claude.json", claudeJson("alice@example.test", "id-a"));
    await seed(join(root, "alpha"), ".claude.json", claudeJson("bob@example.test", "id-b"));
    await seed(join(root, "alpha"), ".credentials.json", realLogin);
    const info = await accountInfoFor("claude", ident("alpha", join(root, "alpha")), members);
    expect(info?.mismatch).toEqual({ folderEmail: "bob@example.test", folderAccountId: "id-b" });
  });

  test("claude gateway-entry folder without a member copy has no account", async () => {
    const root = await temp();
    await seed(join(root, "alpha"), ".claude.json", claudeJson("old@example.test", "id-old"));
    await seed(join(root, "alpha"), ".credentials.json", gatewayEntry);
    expect(await accountInfoFor("claude", ident("alpha", join(root, "alpha")), join(root, "members"))).toBeUndefined();
  });

  test("codex reads the id_token email and the account id claim", async () => {
    const root = await temp();
    const auth = { tokens: { id_token: jwt({ email: "alice@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), access_token: "SYNTHETIC_FIXTURE_a" } };
    await seed(join(root, "alpha"), "auth.json", JSON.stringify(auth));
    const info = await accountInfoFor("codex", ident("alpha", join(root, "alpha")), join(root, "members"));
    expect(info).toEqual({ source: "folder", email: "alice@example.test", accountId: "acct-1" });
  });

  test("codex tokens.account_id wins and the member copy is flagged against a different folder", async () => {
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "codex", "alpha"), "auth.json", JSON.stringify({ tokens: { account_id: "acct-m", id_token: jwt({ email: "alice@example.test" }) } }));
    await seed(join(root, "alpha"), "auth.json", JSON.stringify({ tokens: { account_id: "acct-f", id_token: jwt({ email: "bob@example.test" }) } }));
    const info = await accountInfoFor("codex", ident("alpha", join(root, "alpha")), members);
    expect(info?.accountId).toBe("acct-m");
    expect(info?.mismatch).toEqual({ folderEmail: "bob@example.test", folderAccountId: "acct-f" });
  });

  test("API key tools give a label and leak no key characters", async () => {
    const root = await temp();
    const secret = "sk-SYNTHETIC_FIXTURE_abcdef123456";
    await seed(join(root, "alpha", "data", "opencode"), "auth.json", JSON.stringify({ provider: { type: "api", key: secret } }));
    const info = await accountInfoFor("opencode", ident("alpha", join(root, "alpha")), join(root, "members"));
    expect(info).toEqual({ source: "folder", label: "API key", logins: [{ provider: "provider", label: "API key" }] });
    expect(JSON.stringify(info)).not.toContain("abcdef");
    expect(JSON.stringify(info)).not.toContain("sk-");
  });

  test("pi OAuth id_token email is used", async () => {
    const root = await temp();
    await seed(join(root, "alpha"), "auth.json", JSON.stringify({ prov: { type: "oauth", access: jwt({ email: "alice@example.test" }) } }));
    expect((await accountInfoFor("pi", ident("alpha", join(root, "alpha"))))?.email).toBe("alice@example.test");
  });

  test("retired identities, pools and missing files give undefined", async () => {
    const root = await temp();
    await seed(join(root, "alpha"), ".claude.json", claudeJson("alice@example.test", "id-a"));
    expect(await accountInfoFor("claude", { ...ident("alpha", join(root, "alpha")), retired: true })).toBeUndefined();
    expect(await accountInfoFor("claude", ident("beta", join(root, "missing")), join(root, "members"))).toBeUndefined();
    expect(await accountInfoFor("grok", ident("beta", join(root, "missing")))).toBeUndefined();
  });
});

describe("decodeJwtPayload", () => {
  test("decodes base64url and rejects garbage", () => {
    expect(decodeJwtPayload(jwt({ email: "alice@example.test" }))?.email).toBe("alice@example.test");
    expect(decodeJwtPayload("not-a-jwt")).toBeUndefined();
    expect(decodeJwtPayload(42)).toBeUndefined();
  });
});

describe("markSharedAccounts", () => {
  test("marks same id, same email in any case, per tool only", () => {
    const rows = markSharedAccounts([
      { toolName: "claude", identity: "alpha", account: { source: "folder" as const, email: "a@example.test", accountId: "1" } },
      { toolName: "claude", identity: "beta", account: { source: "folder" as const, email: "A@example.test", accountId: "1" } },
      { toolName: "claude", identity: "gamma", account: { source: "folder" as const, email: "g@example.test" } },
      { toolName: "claude", identity: "delta", account: { source: "folder" as const, email: "G@Example.test" } },
      { toolName: "codex", identity: "alpha", account: { source: "folder" as const, email: "a@example.test", accountId: "1" } },
      { toolName: "claude", identity: "eps", account: { source: "folder" as const, label: "API key" } },
    ]);
    expect(rows[0]!.account?.sharedWith).toEqual(["beta"]);
    expect(rows[1]!.account?.sharedWith).toEqual(["alpha"]);
    expect(rows[2]!.account?.sharedWith).toEqual(["delta"]);
    expect(rows[3]!.account?.sharedWith).toEqual(["gamma"]);
    expect(rows[4]!.account?.sharedWith).toBeUndefined();
    expect(rows[5]!.account?.sharedWith).toBeUndefined();
  });
});

describe("collectAccounts", () => {
  test("keys by tool and identity and marks duplicates", async () => {
    const root = await temp();
    await seed(join(root, "a"), ".claude.json", claudeJson("alice@example.test", "id-1"));
    await seed(join(root, "b"), ".claude.json", claudeJson("alice@example.test", "id-1"));
    const map = await collectAccounts([{ cfg: { toolName: "claude" }, file: { identities: [ident("alpha", join(root, "a")), ident("beta", join(root, "b"))] } }], join(root, "members"));
    expect(map.get("claude/alpha")?.sharedWith).toEqual(["beta"]);
    expect(map.get("claude/beta")?.sharedWith).toEqual(["alpha"]);
  });
});

describe("workspace ids shared by team seats", () => {
  test("same id with different emails is not shared; same id and email is", () => {
    const rows = markSharedAccounts([
      { toolName: "codex", identity: "alpha", account: { source: "folder" as const, email: "a@example.test", accountId: "ws-1" } },
      { toolName: "codex", identity: "beta", account: { source: "folder" as const, email: "b@example.test", accountId: "ws-1" } },
      { toolName: "codex", identity: "gamma", account: { source: "folder" as const, email: "A@example.test", accountId: "ws-1" } },
    ]);
    expect(rows[0]!.account?.sharedWith).toEqual(["gamma"]);
    expect(rows[1]!.account?.sharedWith).toBeUndefined();
    expect(rows[2]!.account?.sharedWith).toEqual(["alpha"]);
  });

  test("a codex folder with the same workspace id but another email is a mismatch", async () => {
    expect(accountsDiffer({ accountId: "ws-1", email: "a@example.test" }, { accountId: "ws-1", email: "b@example.test" })).toBe(true);
    const root = await temp();
    const members = join(root, "members");
    await seed(join(members, "codex", "alpha"), "auth.json", JSON.stringify({ tokens: { account_id: "ws-1", id_token: jwt({ email: "a@example.test" }) } }));
    await seed(join(root, "alpha"), "auth.json", JSON.stringify({ tokens: { account_id: "ws-1", id_token: jwt({ email: "b@example.test" }) } }));
    const info = await accountInfoFor("codex", ident("alpha", join(root, "alpha")), members);
    expect(info?.mismatch).toEqual({ folderEmail: "b@example.test", folderAccountId: "ws-1" });
  });
});

describe("kimi, pi and opencode logins", () => {
  test("kimi user id from the access token", async () => {
    const root = await temp();
    await seed(join(root, "alpha", "credentials"), "kimi-code.json", JSON.stringify({ access_token: jwt({ user_id: "u-123" }), refresh_token: "SYNTHETIC_FIXTURE_r" }));
    const info = await accountInfoFor("kimi", ident("alpha", join(root, "alpha")));
    expect(info).toEqual({ source: "folder", accountId: "u-123", label: "Kimi user u-123" });
  });

  test("pi lists one login per provider", async () => {
    const root = await temp();
    const auth = {
      "openai-codex": { type: "oauth", access: jwt({ "https://api.openai.com/profile": { email: "alice@example.test" }, "https://api.openai.com/auth": { chatgpt_account_id: "ws-1" } }), refresh: "SYNTHETIC_FIXTURE_r" },
      "kimi-coding": { type: "oauth", access: jwt({ user_id: "u-9" }) },
      xai: { type: "oauth", access: jwt({ principal_id: "p-1" }) },
      anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE_opaque" },
      other: { type: "api", key: "SYNTHETIC_FIXTURE_keyvalue" },
    };
    await seed(join(root, "alpha"), "auth.json", JSON.stringify(auth));
    const info = await accountInfoFor("pi", ident("alpha", join(root, "alpha")));
    expect(info?.email).toBe("alice@example.test");
    expect(info?.accountId).toBe("ws-1");
    expect(info?.logins).toEqual([
      { provider: "openai-codex", email: "alice@example.test", accountId: "ws-1" },
      { provider: "kimi-coding", accountId: "u-9", label: "Kimi user u-9" },
      { provider: "xai", accountId: "p-1", label: "xAI OAuth" },
      { provider: "anthropic", label: "OAuth" },
      { provider: "other", label: "API key" },
    ]);
    expect(JSON.stringify(info)).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("pi empty file gives no account", async () => {
    const root = await temp();
    await seed(join(root, "alpha"), "auth.json", "{}");
    expect(await accountInfoFor("pi", ident("alpha", join(root, "alpha")))).toBeUndefined();
  });

  test("opencode reads the Console email and credential kinds from the db", async () => {
    const root = await temp();
    const dir = join(root, "alpha", "data", "opencode");
    await mkdir(dir, { recursive: true });
    const db = new Database(join(dir, "opencode.db"));
    db.run("CREATE TABLE account (id TEXT, email TEXT, access_token TEXT)");
    db.run("CREATE TABLE account_state (active_account_id TEXT)");
    db.run("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER)");
    db.run("INSERT INTO account VALUES ('a1', 'alice@example.test', 'SYNTHETIC_FIXTURE_tok')");
    db.run("INSERT INTO account VALUES ('a2', 'bob@example.test', 'SYNTHETIC_FIXTURE_tok2')");
    db.run("INSERT INTO account_state VALUES ('a1')");
    db.run(`INSERT INTO credential VALUES ('opencode', '{"type":"oauth","access":"SYNTHETIC_FIXTURE_x"}', 1)`);
    db.run(`INSERT INTO credential VALUES ('openrouter', '{"type":"api","key":"SYNTHETIC_FIXTURE_k"}', 1)`);
    db.run(`INSERT INTO credential VALUES ('old', '{"type":"api","key":"SYNTHETIC_FIXTURE_k2"}', 0)`);
    db.close();
    await seed(dir, "auth.json", JSON.stringify({ xai: { type: "api", key: "SYNTHETIC_FIXTURE_k3" } }));
    const info = await accountInfoFor("opencode", ident("alpha", join(root, "alpha")));
    expect(info?.email).toBe("alice@example.test");
    expect(info?.logins).toEqual([
      { provider: "opencode console", email: "alice@example.test" },
      { provider: "opencode", label: "OAuth" },
      { provider: "openrouter", label: "API key" },
      { provider: "xai", label: "API key" },
    ]);
    expect(JSON.stringify(info)).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("opencode without a db or tables skips quietly", async () => {
    const root = await temp();
    await seed(join(root, "alpha", "data", "opencode"), "opencode.db", "not a database");
    expect(await accountInfoFor("opencode", ident("alpha", join(root, "alpha")))).toBeUndefined();
  });
});
