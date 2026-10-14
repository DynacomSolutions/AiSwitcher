import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshIdentityOAuthGrant } from "../../../src/identities/oauth-refresh.ts";
import { reconcilePiOAuthStores } from "../../../src/identities/oauth-reconcile.ts";
import { PI_CONFIG } from "../../../src/identities/tool-configs.ts";
import type { Identity } from "../../../src/identities/types.ts";

let root: string;
const savedPi = PI_CONFIG.identitiesJsonPath;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-pool-pairing-"));
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "pi-identities.json");
});
afterEach(async () => {
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = savedPi;
  await rm(root, { recursive: true, force: true });
});

const dir = (name: string) => join(root, name);
const id = (name: string, pool = false): Identity => ({ name, label: name, configDir: dir(name), ...(pool ? { swapPool: { accounts: ["x", "y"], active: "x" } } : {}) });
const put = async (path: string, text: string) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); };
const registry = (path: string, identities: Identity[]) => writeFile(path, JSON.stringify({ version: 1, identities }));
const T0 = 1_789_200_000;
const piKimi = (tag: string, exp: number) => JSON.stringify({ "kimi-coding": { type: "oauth", access: `SYNTHETIC_FIXTURE-acc-${tag}`, refresh: `SYNTHETIC_FIXTURE-rt-${tag}`, expires: exp * 1000 } });
const nativeKimi = (tag: string, exp: number) => JSON.stringify({ access_token: `SYNTHETIC_FIXTURE-acc-${tag}`, refresh_token: `SYNTHETIC_FIXTURE-rt-${tag}`, expires_at: exp });

describe("same-named identities across tools never pair through a swap pool", () => {
  test("a pi pool is not reconciled into a same-named kimi pool, nor a pi member into a kimi pool", async () => {
    const kimiReg = join(root, "kimi-identities.json");
    await registry(kimiReg, [id("team", true)]);
    await put(join(dir("team"), "credentials", "kimi-code.json"), nativeKimi("kimi-pool", T0));
    const kimiBefore = await readFile(join(dir("team"), "credentials", "kimi-code.json"), "utf8");

    const piPool = id("team", true);
    await put(join(dir("team"), "auth.json"), piKimi("pi-pool-newer", T0 + 5000));
    await reconcilePiOAuthStores(piPool, { write: true, registryPaths: { kimi: kimiReg, claude: join(root, "none"), codex: join(root, "none"), grok: join(root, "none") } });
    expect(await readFile(join(dir("team"), "credentials", "kimi-code.json"), "utf8")).toBe(kimiBefore);

    const piMember = id("team");
    await reconcilePiOAuthStores(piMember, { write: true, registryPaths: { kimi: kimiReg, claude: join(root, "none"), codex: join(root, "none"), grok: join(root, "none") } });
    expect(await readFile(join(dir("team"), "credentials", "kimi-code.json"), "utf8")).toBe(kimiBefore);
  });

  test("refreshing a same-named codex identity does not write a pi pool", async () => {
    await registry(PI_CONFIG.identitiesJsonPath, [id("team", true)]);
    const piPath = join(dir("team"), "auth.json");
    const piText = JSON.stringify({ "openai-codex": { type: "oauth", access: "SYNTHETIC_FIXTURE-pi-acc", refresh: "SYNTHETIC_FIXTURE-pi-rt", expires: (T0 - 100) * 1000 } });
    await put(piPath, piText);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const jwt = (iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-t" } })}.SYNTHETIC_FIXTURE`;
    const codexDir = join(root, "codex-team");
    await put(join(codexDir, "auth.json"), JSON.stringify({ tokens: { id_token: jwt(T0 - 200), access_token: jwt(T0 - 200), refresh_token: "SYNTHETIC_FIXTURE-cx-rt", account_id: "acct-t" }, last_refresh: new Date((T0 - 200) * 1000).toISOString() }));
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: jwt(T0), refresh_token: "SYNTHETIC_FIXTURE-cx-rot", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const r = await refreshIdentityOAuthGrant("codex", { name: "team", label: "team", configDir: codexDir }, { force: true, fetchImpl, poolRegistryPath: join(root, "none"), now: () => T0 * 1000 });
    expect(r.outcome).toBe("refreshed");
    expect(await readFile(piPath, "utf8")).toBe(piText);
  });
});
