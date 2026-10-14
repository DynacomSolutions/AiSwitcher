import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOauthRefreshLock, withOauthRefreshLocks, SwapLockError } from "../../../src/identities/claude-swap-lock.ts";
import { kimiAdapter } from "../../../src/identities/pool/kimi-adapter.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (u: string, iat: number) => `${b64({ alg: "none" })}.${b64({ user_id: u, iat, exp: iat + 900 })}.SYNTHETIC_FIXTURE`;
const creds = (u: string, exp: number) => JSON.stringify({ access_token: jwt(u, exp - 900), refresh_token: `SYNTHETIC_FIXTURE-rt-${u}-${exp}`, expires_at: exp });

test("kimi swap vs member refresh: pool dirs first then member leaf, both orders complete without a lock timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-kimi-inv-"));
  try {
    const dir = (n: string) => join(root, n);
    const m = (name: string) => ({ name, label: name, configDir: dir(name) });
    const registryPath = join(root, "kimi-identities.json");
    // "a" sorts before "pool" by lock path; the swap must still take the pool first, as refresh does.
    await writeFile(registryPath, JSON.stringify({ version: 1, identities: [m("a"), m("z"), { ...m("pool"), swapPool: { accounts: ["a", "z"], active: "a" } }] }));
    const put = async (n: string, u: string, exp: number) => { await mkdir(join(dir(n), "credentials"), { recursive: true }); await writeFile(join(dir(n), "credentials", "kimi-code.json"), creds(u, exp)); };
    await put("a", "user-a", 1_789_200_000); await put("z", "user-z", 1_789_200_000); await put("pool", "user-a", 1_789_200_010);
    const lock = { timeoutMs: 1_500 };
    const refresh = withOauthRefreshLocks([dir("pool")], async () => {
      await Bun.sleep(300); // the swap starts meanwhile
      return withOauthRefreshLock(dir("a"), async () => "refreshed", lock);
    }, lock).catch((e) => (e instanceof SwapLockError ? `refresh timeout ${e.lockPath}` : String(e)));
    await Bun.sleep(50);
    const swap = performPoolSwap(kimiAdapter, { registryPath, ledgerPath: join(root, "l.jsonl"), pool: "pool", target: "z", reason: "manual", lock })
      .then((r) => `swapped to ${r["to"]}`, (e) => (e instanceof SwapLockError ? `swap timeout ${e.lockPath}` : String(e)));
    expect(await Promise.all([refresh, swap])).toEqual(["refreshed", "swapped to z"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two kimi pools sharing members, swapped in opposite directions at once, never invert their locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-kimi-inv2-"));
  try {
    const dir = (n: string) => join(root, n);
    const m = (name: string) => ({ name, label: name, configDir: dir(name) });
    const registryPath = join(root, "kimi-identities.json");
    await writeFile(registryPath, JSON.stringify({ version: 1, identities: [m("a"), m("z"), { ...m("p1"), swapPool: { accounts: ["a", "z"], active: "a" } }, { ...m("p2"), swapPool: { accounts: ["a", "z"], active: "z" } }] }));
    const put = async (n: string, u: string, exp: number) => { await mkdir(join(dir(n), "credentials"), { recursive: true }); await writeFile(join(dir(n), "credentials", "kimi-code.json"), creds(u, exp)); };
    await put("a", "user-a", 1_789_200_000); await put("z", "user-z", 1_789_200_000);
    await put("p1", "user-a", 1_789_200_010); await put("p2", "user-z", 1_789_200_010); // each pool holds a newer grant of its active member
    const lock = { timeoutMs: 1_500 };
    const run = (pool: string, target: string) => performPoolSwap(kimiAdapter, { registryPath, ledgerPath: join(root, `${pool}.jsonl`), pool, target, reason: "manual", lock })
      .then((r) => `${pool}: ${r["writeBack"]}`, (e) => (e instanceof SwapLockError ? `${pool} timeout ${e.lockPath}` : String(e)));
    expect(await Promise.all([run("p1", "z"), run("p2", "a")])).toEqual(["p1: written", "p2: written"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
