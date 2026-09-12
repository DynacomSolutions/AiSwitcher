import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantFingerprint,
  reconcileNativeProviderStores,
  readProviderGrantCopy,
  writeProviderGrantCopy,
} from "../../src/identities/oauth-reconcile.ts";
import { oauthRefreshHealth } from "../../src/identities/oauth-refresh.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";

// Same registry-repoint pattern as oauth-reconcile.test.ts: real temp
// registries, the live ~/.codex, ~/.claude and ~/.pi registries untouched.
// All fixture tokens are short synthetic strings; JWTs are built at runtime.
const tempDirs: string[] = [];
const savedPaths: Record<string, string> = {};

let dirs: Record<"claude" | "codex" | "pi", string> = {} as never;
const ACME = "acme";
const NOW = 1_789_200_000;

const CODEX_FILE = () => join(dirs.codex, "auth.json");
const CLAUDE_FILE = () => join(dirs.claude, ".credentials.json");
const PI_AUTH = () => join(dirs.pi, "auth.json");

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-oauth-native-"));
  tempDirs.push(root);
  dirs = {
    claude: join(root, "claude-identities", ACME),
    codex: join(root, "codex-identities", ACME),
    pi: join(root, "pi-identities", ACME),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    savedPaths[tool] = path.identitiesJsonPath;
    (path as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}-identities.json`);
    await writeFile(
      path.identitiesJsonPath,
      JSON.stringify({ version: 1, identities: [{ name: ACME, label: "Acme", configDir: dirs[tool] }] }),
    );
  }
});

afterEach(async () => {
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    if (savedPaths[tool]) (path as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths[tool];
  }
  const roots = tempDirs.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function fakeJwt(claims: { iat?: number; exp?: number }): string {
  const enc = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.syn`;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function codexIdentity(): Identity {
  return { name: ACME, label: "Acme", configDir: dirs.codex };
}

function seedCodexPair(
  nativeIat: number,
  piIat: number,
  nativeRefresh = "rt-same-1",
  piRefresh = "rt-same-1",
): void {
  void (async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: nativeIat, exp: nativeIat + 3600 }), refresh_token: nativeRefresh },
      last_refresh: new Date(nativeIat * 1000).toISOString(),
    });
    await json(PI_AUTH(), {
      "openai-codex": { type: "oauth", access: fakeJwt({ iat: piIat, exp: piIat + 3600 }), refresh: piRefresh, expires: (piIat + 3600) * 1000 },
    });
  })();
}

describe("reconcileNativeProviderStores (reconcile-on-read)", () => {
  test("in-sync copies report in-sync and write nothing", async () => {
    seedCodexPair(NOW - 60, NOW - 60);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = await readFile(CODEX_FILE(), "utf8");
    const entry = await reconcileNativeProviderStores("codex", codexIdentity(), { write: true });
    expect(entry.provider).toBe("openai-codex");
    expect(entry.status).toBe("in-sync");
    expect(entry.nativeFingerprint).toBe(entry.piFingerprint);
    expect(await readFile(CODEX_FILE(), "utf8")).toBe(before);
  });

  test("a forked pair heals into the FRESHER native store's shape", async () => {
    // Native is 10 days fresher than pi: the heal rewrites pi's copy.
    seedCodexPair(NOW - 60, NOW - 10 * 86_400, "rt-nat-1", "rt-pi-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = await reconcileNativeProviderStores("codex", codexIdentity(), { write: true });
    expect(entry.status).toBe("rewrote-pi");
    expect(entry.adoptedFrom).toBe("native");
    const pi = await readJson<Record<string, { refresh: string }>>(PI_AUTH());
    expect(pi["openai-codex"]!.refresh).toBe("rt-nat-1");
    // mode 0600 kept on the rewritten copy
    expect((await stat(PI_AUTH())).mode & 0o777).toBe(0o600);
  });

  test("a forked pair heals into the fresher pi copy too", async () => {
    // pi is fresher: the native store adopts pi's grant.
    seedCodexPair(NOW - 10 * 86_400, NOW - 60, "rt-stale-1", "rt-pi-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = await reconcileNativeProviderStores("codex", codexIdentity(), { write: true });
    expect(entry.status).toBe("rewrote-native");
    expect(entry.adoptedFrom).toBe("pi");
    const native = await readJson<{ tokens: { refresh_token: string } }>(CODEX_FILE());
    expect(native.tokens.refresh_token).toBe("rt-pi-1");
    expect((await stat(CODEX_FILE())).mode & 0o777).toBe(0o600);
  });

  test("a native-only grant (no pi counterpart copy) is an honest single-copy", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW, exp: NOW + 3600 }), refresh_token: "rt-nat-1" },
    });
    const entry = await reconcileNativeProviderStores("codex", codexIdentity(), { write: true });
    expect(entry.status).toBe("single-copy");
    expect(entry.detail).toContain("only the native store holds a copy");
  });

  test("never throws on unreadable stores", async () => {
    const entry = await reconcileNativeProviderStores("codex", codexIdentity(), { write: true });
    expect(entry.status).toBe("unreadable");
  });
});

describe("readProviderGrantCopy / writeProviderGrantCopy", () => {
  test("round-trips a codex grant and preserves unknown file keys", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW, exp: NOW + 3600 }), refresh_token: "rt-nat-1", account_id: "acc-syn" },
      last_refresh: new Date(NOW * 1000).toISOString(),
    });
    const copy = await readProviderGrantCopy("codex", dirs.codex);
    expect(copy?.grant.refresh_token).toBe("rt-nat-1");
    expect(copy?.grant.minted_at).toBe(NOW);
    await writeProviderGrantCopy("codex", dirs.codex, {
      access_token: fakeJwt({ iat: NOW + 60, exp: NOW + 3660 }),
      refresh_token: "rt-new-9",
      minted_at: NOW + 60,
    });
    const raw = await readJson<{ tokens: Record<string, unknown>; last_refresh: string }>(CODEX_FILE());
    expect(raw.tokens.refresh_token).toBe("rt-new-9");
    expect(raw.tokens.account_id).toBe("acc-syn");
    expect(new Date(raw.last_refresh).getTime() / 1000).toBe(NOW + 60);
  });

  test("fingerprints identify copies without exposing tokens", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW, exp: NOW + 3600 }), refresh_token: "rt-nat-1" },
    });
    const copy = await readProviderGrantCopy("codex", dirs.codex);
    expect(copy && grantFingerprint(copy.grant)).toBe(grantFingerprint({ access_token: "x", refresh_token: "rt-nat-1" }));
    expect(copy && grantFingerprint(copy.grant)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("oauthRefreshHealth (doctor classifier)", () => {
  test("expired access with a live refresh token is refreshable", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-alive-1" },
    });
    const health = await oauthRefreshHealth("codex", codexIdentity());
    expect(health.state).toBe("expired-refreshable");
    expect(health.detail).toContain("refreshable");
    expect(health.detail).toContain("ais auth refresh acme --tool=codex");
  });

  test("the pinned revoked diagnosis renders as re-login required", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-dead-1" },
    });
    const fingerprint = grantFingerprint({ access_token: "x", refresh_token: "rt-dead-1" });
    const health = await oauthRefreshHealth("codex", codexIdentity(), fingerprint);
    expect(health.state).toBe("revoked");
    expect(health.detail).toContain("re-login required");
  });

  test("a revoked diagnosis pinned to a DIFFERENT grant does not fire", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-alive-1" },
    });
    const health = await oauthRefreshHealth(
      "codex",
      codexIdentity(),
      grantFingerprint({ access_token: "x", refresh_token: "rt-dead-1" }),
    );
    expect(health.state).toBe("expired-refreshable");
  });

  test("a fresh grant is fresh or expiring", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW, exp: NOW + 3600 }), refresh_token: "rt-alive-1" },
    });
    const health = await oauthRefreshHealth("codex", codexIdentity());
    expect(health.state).toBe("expiring");
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW, exp: NOW + 30 * 86_400 }), refresh_token: "rt-alive-1" },
    });
    expect((await oauthRefreshHealth("codex", codexIdentity())).state).toBe("fresh");
  });

  test("expired with no refresh token is not refreshable", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }) },
    });
    const health = await oauthRefreshHealth("codex", codexIdentity());
    expect(health.state).toBe("expired-no-refresh-token");
  });

  test("no grant anywhere is absent", async () => {
    const health = await oauthRefreshHealth("codex", codexIdentity());
    expect(health.state).toBe("absent");
  });

  test("claude's opaque token expiry comes from the store's expiresAt", async () => {
    await json(CLAUDE_FILE(), {
      claudeAiOauth: { accessToken: "at-syn-cla", refreshToken: "rt-alive-1", expiresAt: (NOW - 3600) * 1000 },
    });
    const health = await oauthRefreshHealth("claude", { name: ACME, label: "Acme", configDir: dirs.claude });
    expect(health.state).toBe("expired-refreshable");
  });
});
