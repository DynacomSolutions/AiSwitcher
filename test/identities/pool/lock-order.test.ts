import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockOrder, withOauthRefreshLock } from "../../../src/identities/claude-swap-lock.ts";
import { codexAdapter } from "../../../src/identities/pool/codex-adapter.ts";
import { loadIdentitiesFile } from "../../../src/identities/store.ts";
import { requirePool } from "../../../src/identities/pool/swap-pool.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ais-lock-order-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (account: string, iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } })}.SYNTHETIC_FIXTURE`;
const auth = (account: string, iat: number) => JSON.stringify({
  tokens: { id_token: jwt(account, iat), access_token: jwt(account, iat), refresh_token: `SYNTHETIC_FIXTURE-rt-${account}-${iat}`, account_id: account },
  last_refresh: new Date(iat * 1000).toISOString(),
});

test("lockOrder resolves, de-duplicates and sorts by lock path", () => {
  expect(lockOrder(["/x/b", "/x/a/", "/x/b", "/x/a/../c"])).toEqual(["/x/a", "/x/b", "/x/c"]);
  expect(lockOrder([])).toEqual([]);
  expect(lockOrder(["rel"])).toEqual([resolve("rel")]);
});

test("two pools sharing members swap concurrently without a lock timeout", async () => {
  const T0 = 1_789_200_000;
  const dir = (n: string) => join(root, n);
  const member = (name: string) => ({ name, label: name, configDir: dir(name) });
  const registryPath = join(root, "codex-identities.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, identities: [
    member("m"), member("x"),
    { ...member("p1"), swapPool: { accounts: ["m", "x"], active: "x" } },
    { ...member("p2"), swapPool: { accounts: ["m", "x"], active: "m" } },
  ] }));
  const put = async (name: string, account: string, iat: number) => { await mkdir(dir(name), { recursive: true }); await writeFile(join(dir(name), "auth.json"), auth(account, iat)); };
  await put("m", "acct-m", T0);
  await put("x", "acct-x", T0);
  for (let i = 0; i < 6; i++) {
    // p1 holds x and goes to m (owner x); p2 holds m and goes to x (owner m): the old orders inverted.
    await put("p1", "acct-x", T0 + 10 + i);
    await put("p2", "acct-m", T0 + 10 + i);
    const run = (pool: string, target: string) => performPoolSwap(codexAdapter, { registryPath, ledgerPath: join(root, `${pool}.jsonl`), pool, target, reason: "manual", lock: { timeoutMs: 1_500 } });
    const [a, b] = await Promise.all([run("p1", "m"), run("p2", "x")]);
    expect(a.to).toBe("m");
    expect(b.to).toBe("x");
    // Reset the recorded active member for the next round.
    const file = JSON.parse(await Bun.file(registryPath).text());
    for (const id of file.identities) if (id.name === "p1") id.swapPool.active = "x"; else if (id.name === "p2") id.swapPool.active = "m";
    await writeFile(registryPath, JSON.stringify(file));
  }
});

test("heal restores the vault as it is under the lock, not a token a refresh just spent", async () => {
  const T0 = 1_789_200_000;
  const dir = (n: string) => join(root, n);
  const member = (name: string) => ({ name, label: name, configDir: dir(name) });
  const registryPath = join(root, "codex-identities.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, identities: [member("m"), { ...member("p"), swapPool: { accounts: ["m"], active: "m" } }] }));
  const put = async (name: string, text: string) => { await mkdir(dir(name), { recursive: true }); await writeFile(join(dir(name), "auth.json"), text); };
  await put("m", auth("acct-m", T0));
  await put("p", "");
  const file = await loadIdentitiesFile(registryPath);
  const pool = requirePool(file, "p", "codex");
  const members = [file.identities.find((i) => i.name === "m")!];
  // A refresh holds the vault lock; heal has already read the old vault by the time it waits for it.
  let heal!: Promise<string[]>;
  await withOauthRefreshLock(dir("m"), async () => {
    heal = codexAdapter.heal!(pool, members, { timeoutMs: 5_000 });
    await Bun.sleep(300);
    await writeFile(join(dir("m"), "auth.json"), auth("acct-m", T0 + 500));
  });
  await heal;
  expect(await readFile(join(dir("p"), "auth.json"), "utf8")).toBe(auth("acct-m", T0 + 500));
});
