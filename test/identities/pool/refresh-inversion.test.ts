import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOauthRefreshLock, withOauthRefreshLocks, SwapLockError } from "../../../src/identities/claude-swap-lock.ts";
import { codexAdapter } from "../../../src/identities/pool/codex-adapter.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (a: string, iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: a } })}.SYNTHETIC_FIXTURE`;
const auth = (a: string, iat: number) => JSON.stringify({ tokens: { id_token: jwt(a, iat), access_token: jwt(a, iat), refresh_token: `SYNTHETIC_FIXTURE-rt-${a}-${iat}`, account_id: a }, last_refresh: new Date(iat * 1000).toISOString() });

test("codex swap vs refresh order (pools then member leaf, oauth-refresh.ts:643)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-inv-"));
  const dir = (n: string) => join(root, n);
  const m = (name: string) => ({ name, label: name, configDir: dir(name) });
  const registryPath = join(root, "codex-identities.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, identities: [m("a"), m("z"), { ...m("pool"), swapPool: { accounts: ["a", "z"], active: "a" } }] }));
  const put = async (n: string, acct: string, iat: number) => { await mkdir(dir(n), { recursive: true }); await writeFile(join(dir(n), "auth.json"), auth(acct, iat)); };
  await put("a", "acct-a", 1_789_200_000); await put("z", "acct-z", 1_789_200_000); await put("pool", "acct-a", 1_789_200_010);
  const lock = { timeoutMs: 1_500 };
  // refresh of member "a": pool dirs first, then member leaf
  const refresh = withOauthRefreshLocks([dir("pool")], async () => {
    await Bun.sleep(300); // swap starts meanwhile
    return withOauthRefreshLock(dir("a"), async () => "refreshed", lock);
  }, lock).catch((e) => (e instanceof SwapLockError ? `refresh timeout ${e.lockPath}` : String(e)));
  await Bun.sleep(50);
  const swap = performPoolSwap(codexAdapter, { registryPath, ledgerPath: join(root, "l.jsonl"), pool: "pool", target: "z", reason: "manual", lock })
    .then((r) => `swapped to ${r["to"]}`, (e) => (e instanceof SwapLockError ? `swap timeout ${e.lockPath}` : String(e)));
  const out = await Promise.all([refresh, swap]);
  console.log(out);
  expect(out).toEqual(["refreshed", "swapped to z"]);
});
