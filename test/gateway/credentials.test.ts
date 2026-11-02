import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialCache, NotRefreshableError, type RefreshFn } from "../../src/gateway/credentials.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "gateway");
const SCRATCH = join(import.meta.dir, ".tmp");

let work = "";
beforeEach(async () => {
  await mkdir(SCRATCH, { recursive: true });
  work = await mkdtemp(join(SCRATCH, "gw-cred-"));
  await cp(FIXTURES, work, { recursive: true });
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const claudeFile = () => join(work, "claude", ".credentials.json");
const writeClaude = async (token: string, mtimeSec: number): Promise<void> => {
  await writeFile(claudeFile(), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "SYNTHETIC_FIXTURE-claude-refresh-0001", expiresAt: 1893456000000 } }));
  await utimes(claudeFile(), mtimeSec, mtimeSec);
};
const makeCache = (refresh?: RefreshFn) => new CredentialCache({ resolveConfigDir: async (p) => join(work, p), ...(refresh ? { refresh } : {}) });
const refreshed = (over: Partial<Awaited<ReturnType<RefreshFn>>> = {}): Awaited<ReturnType<RefreshFn>> => ({
  tool: "claude", identity: "id1", outcome: "refreshed", detail: "ok", written: [], writeFailures: [], ...over,
});

describe("CredentialCache", () => {
  test("reads codex account id and claude expiry", async () => {
    const c = makeCache();
    expect((await c.get("codex", "id1")).accountId).toBe("SYNTHETIC_FIXTURE-account-0001");
    expect((await c.get("claude", "id1")).expiresAtMs).toBe(1893456000000);
  });

  test("cache reloads after mtime change", async () => {
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0001", 1_800_000_000);
    const c = makeCache();
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_000);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_100);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
  });

  test("concurrent 401 refreshes share one locked refresh", async () => {
    let calls = 0;
    const refresh: RefreshFn = async () => {
      calls++;
      await Bun.sleep(20);
      await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_200);
      return refreshed();
    };
    const c = makeCache(refresh);
    const [a, b] = await Promise.all([
      c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001"),
      c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001"),
    ]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
    expect(b.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
  });

  test("refresh skipped when file already holds a newer token", async () => {
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0009", 1_800_000_300);
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    const cred = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001");
    expect(calls).toBe(0);
    expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0009");
  });

  test("failed refresh and unchanged token raise errors without token values", async () => {
    const failing = makeCache(async () => refreshed({ outcome: "failed", detail: "endpoint said no" }));
    const err = await failing.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err as Error).message).toContain("endpoint said no");
    expect((err as Error).message).not.toContain("SYNTHETIC_FIXTURE-claude-access-0001");
    const noop = makeCache(async () => refreshed());
    const err2 = await noop.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err2 as Error).message).toMatch(/still holds/);
    expect((err2 as Error).message).not.toContain("SYNTHETIC_FIXTURE-claude-access-0001");
  });

  test("non-refreshable providers (zai, ali, opencode) surface a clear error", async () => {
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    for (const p of ["zai", "ali", "opencode"] as const) {
      const err = await c.refreshAfter401(p, "id1", "x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(NotRefreshableError);
      expect((err as Error).message).toContain(p);
      expect((err as Error).message).toMatch(/API key/);
    }
    expect(calls).toBe(0);
  });

  test("missing identity or credential gives a clear error", async () => {
    const c = new CredentialCache({ resolveConfigDir: async () => undefined });
    await expect(c.get("claude", "nope")).rejects.toThrow(/identity "nope"/);
    const d = new CredentialCache({ resolveConfigDir: async () => join(work, "empty") });
    await expect(d.get("claude", "id1")).rejects.toThrow(/no usable claude credential/);
  });
});
