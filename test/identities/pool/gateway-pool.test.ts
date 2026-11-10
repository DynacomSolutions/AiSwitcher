import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwapCommand } from "../../../src/cli/swap/dispatch.ts";
import { fetchCodexLimits, fetchCodexLimitsViaStore, snapshotFromWham } from "../../../src/cli/limits/codex-limits.ts";
import { gatewayEntryText } from "../../../src/identities/claude-gateway-entry.ts";
import { performSwap as performClaudeSwap } from "../../../src/identities/claude-swap.ts";
import { fetchMemberUsage } from "../../../src/identities/claude-usage-api.ts";
import { classifyLogin } from "../../../src/identities/gateway-routed.ts";
import { codexAdapter, codexMemberProblem, codexTuning } from "../../../src/identities/pool/codex-adapter.ts";
import { codexPoolEntryText, isCodexGatewayPoolDir, isGatewayRoutedPool } from "../../../src/identities/pool/gateway-pool.ts";
import { poolLaunchCheck } from "../../../src/identities/pool/launch.ts";
import { readSwapEvents } from "../../../src/identities/pool/ledger.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
import { requirePool } from "../../../src/identities/pool/swap-pool.ts";
import { configureCodexGatewayHome, codexGatewayHomeProblem } from "../../../src/identities/codex-gateway-home.ts";
import { loadIdentitiesFile } from "../../../src/identities/store.ts";

// Every token below is a synthetic string built for this test.
const CODEX_KEY = "aisg_SYNTHETIC_FIXTURE_codex_pool_key";
const CLAUDE_KEY = "aisg_SYNTHETIC_FIXTURE_claude_pool_key";
const T0 = 1_789_200_000;
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (account: string, iat: number) => `${b64({ alg: "none" })}.${b64({ iat, exp: iat + 3600, "https://api.openai.com/auth": { chatgpt_account_id: account } })}.SYNTHETIC_FIXTURE`;
const codexLogin = (account: string, iat = T0) =>
  JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwt(account, iat), access_token: jwt(account, iat), refresh_token: `SYNTHETIC_FIXTURE-rt-${account}-${iat}`, account_id: account }, last_refresh: new Date(iat * 1000).toISOString() });
const codexEntry = `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: CODEX_KEY })}\n`;
const routedConfig = 'model_provider = "ais-gateway"\n\n[model_providers.ais-gateway]\nname = "AIS Gateway"\nbase_url = "http://127.0.0.1:47140/codex"\nwire_api = "responses"\n';

let root = "";
let registry = "";
let ledger = "";
let members = "";
const saved: Record<string, string | undefined> = {};
const dirOf = (name: string) => join(root, name);
const put = async (name: string, file: string, text: string) => {
  await mkdir(dirOf(name), { recursive: true });
  await writeFile(join(dirOf(name), file), text);
};
const read = (name: string, file = "auth.json") => readFile(join(dirOf(name), file), "utf8");
const storeFile = (tool: string, name: string, file: string) => join(members, tool, name, file);
const putStore = async (tool: string, name: string, file: string, text: string) => {
  await mkdir(join(members, tool, name), { recursive: true });
  await writeFile(storeFile(tool, name, file), text);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-gateway-pool-"));
  registry = join(root, "identities.json");
  ledger = join(root, "swap.jsonl");
  members = join(root, "gateway-members");
  for (const k of ["AIS_GATEWAY_MEMBERS_DIR", "AIS_SECRETS_FILE"]) saved[k] = process.env[k];
  process.env.AIS_GATEWAY_MEMBERS_DIR = members;
  process.env.AIS_SECRETS_FILE = join(root, "secrets");
  await writeFile(join(root, "secrets"), `AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=${CODEX_KEY}\nAIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${CLAUDE_KEY}\n`);
  codexTuning.healRetryMs = 0;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeRegistry(active: string | undefined = "a"): Promise<void> {
  const id = (name: string) => ({ name, label: name, configDir: dirOf(name) });
  await writeFile(registry, JSON.stringify({ version: 1, identities: [id("a"), id("b"), { ...id("pool"), swapPool: { accounts: ["a", "b"], ...(active ? { active } : {}) } }] }));
}

/** Codex as on a routed host: members and pool hold the gateway entry, the logins live in the member store. */
async function routedCodex(active?: string): Promise<void> {
  await writeRegistry(active);
  for (const n of ["a", "b"]) {
    await put(n, "auth.json", codexEntry);
    await put(n, "config.toml", routedConfig);
    await putStore("codex", n, "auth.json", codexLogin(`acct-${n}`));
  }
  await put("pool", "auth.json", codexEntry);
  await put("pool", "config.toml", routedConfig);
}

const codexSwap = (target: string) => performPoolSwap(codexAdapter, { registryPath: registry, ledgerPath: ledger, pool: "pool", target, reason: "manual" });
const backups = (name: string, kind: string) => readdirSync(dirOf(name)).filter((f) => f.startsWith(`auth.json.pre-${kind}.`));

async function codexHeal() {
  const file = await loadIdentitiesFile(registry);
  const pool = requirePool(file, "pool", "codex");
  return codexAdapter.heal!(pool, pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!));
}

describe("codex: a gateway-routed pool", () => {
  test("is detected by its entry or by its config", async () => {
    await routedCodex();
    expect(isCodexGatewayPoolDir(dirOf("pool"))).toBe(true);
    expect(await isGatewayRoutedPool("codex", dirOf("pool"))).toBe(true);
    await put("pool", "auth.json", codexLogin("acct-a"));
    expect(isCodexGatewayPoolDir(dirOf("pool"))).toBe(true); // config.toml still on the gateway provider
    await put("pool", "config.toml", 'model = "m"\n');
    expect(isCodexGatewayPoolDir(dirOf("pool"))).toBe(false);
  });

  test("swap to a member whose login the gateway holds records the active member and keeps the entry", async () => {
    await routedCodex("a");
    const r = await codexSwap("b");
    expect(r).toMatchObject({ from: "a", to: "b", noop: false });
    expect(r.notes.join("\n")).toContain("the gateway picks the member");
    expect(r.runningSessions).toBeUndefined();
    expect(await read("pool")).toBe(codexEntry);
    expect(requirePool(await loadIdentitiesFile(registry), "pool", "codex").swapPool.active).toBe("b");
    expect((await readSwapEvents(ledger)).map((e) => e.to)).toEqual(["b"]);
    // the member store copies are untouched
    expect(await readFile(storeFile("codex", "b", "auth.json"), "utf8")).toBe(codexLogin("acct-b"));
    // swapping to the active member again is a no-op
    expect((await codexSwap("b")).noop).toBe(true);
  });

  test("works through the CLI: swap to, status with member usage from the store", async () => {
    await routedCodex("a");
    const out: string[] = [];
    const deps = { registryPath: registry, ledgerPath: ledger, log: (l: string) => out.push(l), fetchUsage: async () => ({ status: "live" as const, maxUtilization: 30, windows: [{ label: "week", utilization: 30 }], capturedAt: "x" }) };
    await runSwapCommand("codex", ["to", "b"], { pool: "pool" }, deps);
    expect(out.join("\n")).toContain("routes through the AIS gateway");
    out.length = 0;
    await runSwapCommand("codex", ["status"], {}, deps);
    expect(out.join("\n")).toContain("week 30%");
    expect(out.join("\n")).toContain("routed through the AIS gateway");
    out.length = 0;
    await runSwapCommand("codex", ["status"], { json: true }, deps);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ active: "b", gatewayRouted: true });
  });

  test("a login found in the routed pool is backed up and replaced by the entry, never written to a member", async () => {
    await routedCodex("a");
    await put("pool", "auth.json", codexLogin("acct-a", T0 + 500));
    await codexSwap("b");
    expect(await read("pool")).toBe(codexEntry);
    expect(backups("pool", "swap")).toHaveLength(1);
    expect(await readFile(storeFile("codex", "a", "auth.json"), "utf8")).toBe(codexLogin("acct-a"));
    expect(await read("a")).toBe(codexEntry);
  });

  test("without the gateway token the swap fails and writes nothing", async () => {
    await routedCodex("a");
    await put("pool", "auth.json", codexLogin("acct-a"));
    await writeFile(join(root, "secrets"), "");
    await expect(codexSwap("b")).rejects.toThrow(/AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN/);
    expect(await read("pool")).toBe(codexLogin("acct-a"));
  });

  test("heal never restores the active member's login over the entry (the copy that undid routing)", async () => {
    await writeRegistry("a");
    // the member is not routed yet: its folder still holds a real login
    await put("a", "auth.json", codexLogin("acct-a"));
    await put("b", "auth.json", codexLogin("acct-b"));
    await put("pool", "auth.json", codexEntry);
    await put("pool", "config.toml", routedConfig);
    expect(await codexHeal()).toEqual([]);
    expect(await read("pool")).toBe(codexEntry);

    // a codex login inside the pool: backed up, entry restored, the member's vault untouched
    await put("pool", "auth.json", codexLogin("acct-a", T0 + 900));
    const notes = await codexHeal();
    expect(notes.join("\n")).toContain("restored the gateway entry");
    expect(await read("pool")).toBe(codexEntry);
    expect(await read("a")).toBe(codexLogin("acct-a"));
    expect(backups("pool", "heal")).toHaveLength(1);
  });

  test("the launch check treats the entry as credentials and copies nothing in", async () => {
    await writeRegistry(undefined);
    await put("a", "auth.json", codexLogin("acct-a"));
    await put("b", "auth.json", codexLogin("acct-b"));
    await put("pool", "auth.json", codexEntry);
    await put("pool", "config.toml", routedConfig);
    expect(codexAdapter.hasCredentials(dirOf("pool"))).toBe(true);
    const pool = requirePool(await loadIdentitiesFile(registry), "pool", "codex");
    await poolLaunchCheck(codexAdapter, pool, { registryPath: registry, ledgerPath: ledger });
    expect(await read("pool")).toBe(codexEntry);
    expect(requirePool(await loadIdentitiesFile(registry), "pool", "codex").swapPool.active).toBe("a");
  });

  test("a plain pool refuses a routed member instead of copying its entry or store login", async () => {
    await writeRegistry("a");
    await put("a", "auth.json", codexLogin("acct-a"));
    await put("pool", "auth.json", codexLogin("acct-a"));
    await put("b", "auth.json", codexEntry);
    await putStore("codex", "b", "auth.json", codexLogin("acct-b"));
    await expect(codexSwap("b")).rejects.toThrow(/routed through the AIS gateway.*route-all-via-gateway/s);
    expect(await read("pool")).toBe(codexLogin("acct-a"));
  });

  test("a member the gateway holds is a valid pool member", async () => {
    await routedCodex();
    expect(codexMemberProblem({ name: "a", label: "a", configDir: dirOf("a") })).toBeUndefined();
    await put("c", "auth.json", JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FIXTURE-plain-key" }));
    expect(codexMemberProblem({ name: "c", label: "c", configDir: dirOf("c") })).toContain("no ChatGPT login");
  });

  test("the codex-home placeholder login counts as the gateway entry", () => {
    const placeholder = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x.y.c2ln", access_token: CODEX_KEY, refresh_token: "none", account_id: "ais-agents-codex" } });
    expect(classifyLogin("codex", placeholder)).toBe("gateway");
  });
});

describe("codex usage of a routed member", () => {
  const whamBody = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: T0 + 600 }, secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_after_seconds: 3600 } } };

  test("maps wham/usage to windows", () => {
    const snap = snapshotFromWham(whamBody, T0 * 1000)!;
    expect(snap.primary).toEqual({ usedPercent: 42, windowDurationMins: 300, resetsAt: T0 + 600 });
    expect(snap.secondary).toEqual({ usedPercent: 7, windowDurationMins: 10_080, resetsAt: T0 + 3600 });
    expect(snapshotFromWham({}, 0)).toBeUndefined();
  });

  test("reads the store copy's access token with one GET (no refresh, no codex process)", async () => {
    await routedCodex();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(whamBody), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchCodexLimits({ name: "a", label: "a", configDir: dirOf("a") }, { fetchImpl, now: () => T0 * 1000 });
    expect(r.status).toBe("live");
    expect(r.windows.map((w) => w.usedPercent)).toEqual([42, 7]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/backend-api/wham/usage");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${jwt("acct-a", T0)}`);
    expect(calls[0]!.headers["chatgpt-account-id"]).toBe("acct-a");
    // the store copy is untouched
    expect(await readFile(storeFile("codex", "a", "auth.json"), "utf8")).toBe(codexLogin("acct-a"));
  });

  test("a rejected token is reported, not repaired", async () => {
    await routedCodex();
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await fetchCodexLimitsViaStore({ name: "a", label: "a", configDir: dirOf("a") }, { fetchImpl });
    expect(r.status).toBe("unavailable");
    expect(r.error).toContain("the AIS gateway renews it");
  });
});

describe("claude: gateway-routed pools and members", () => {
  const claudeLogin = (n: string, expiresAtMs: number) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt: expiresAtMs, scopes: ["user:inference"] } });

  async function claudeSetup(poolRouted: boolean): Promise<void> {
    await writeRegistry("a");
    for (const n of ["a", "b"]) {
      await put(n, ".credentials.json", gatewayEntryText(CLAUDE_KEY));
      await put(n, ".claude.json", JSON.stringify({ oauthAccount: { accountUuid: `u-${n}` } }));
      await putStore("claude", n, ".credentials.json", claudeLogin(n, Date.now() + 3_600_000));
    }
    if (poolRouted) {
      await put("pool", ".credentials.json", gatewayEntryText(CLAUDE_KEY));
      await put("pool", "settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:47140/claude" } }));
    } else {
      await put("pool", ".credentials.json", claudeLogin("pool-old", 1));
    }
  }

  test("a routed pool swaps to a routed member: entry kept, the note says the gateway picks", async () => {
    await claudeSetup(true);
    const r = await performClaudeSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual", lock: { timeoutMs: 2_000 } });
    expect(r).toMatchObject({ from: "a", to: "b" });
    expect(r.notes.join("\n")).toContain("the gateway picks the member");
    expect(JSON.parse(await read("pool", ".credentials.json")).claudeAiOauth.accessToken).toBe(CLAUDE_KEY);
  });

  test("a plain pool refuses a routed member", async () => {
    await claudeSetup(false);
    await expect(performClaudeSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual", lock: { timeoutMs: 2_000 } })).rejects.toThrow(/routed through the AIS gateway/);
    expect(await read("pool", ".credentials.json")).toBe(claudeLogin("pool-old", 1));
  });

  test("usage of a routed member is read with the member store token and never refreshed", async () => {
    await claudeSetup(true);
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization ?? "");
      return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 34, resets_at: null } }), { status: 200 });
    }) as unknown as typeof fetch;
    const member = { name: "a", label: "a", configDir: dirOf("a") };
    const usage = await fetchMemberUsage(member, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache") });
    expect(usage.status).toBe("live");
    expect(usage.maxUtilization).toBe(34);
    expect(seen.every((h) => h === "Bearer sk-ant-SYNTHETIC_FIXTURE-a")).toBe(true);

    // an expired store copy: reported, no refresh request
    await putStore("claude", "b", ".credentials.json", claudeLogin("b", 1));
    seen.length = 0;
    const expired = await fetchMemberUsage({ name: "b", label: "b", configDir: dirOf("b") }, { fetchImpl, claudeRegistryPath: registry, cacheDir: join(root, "cache") });
    expect(expired.status).toBe("unavailable");
    expect(expired.error).toContain("the AIS gateway renews it");
    expect(seen).toHaveLength(0);
  });
});

describe("codex pool entry for a local-route folder", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "ais-cpe-"));
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));
  const secretsWith = async (lines: string) => {
    const path = join(scratch, "secrets");
    await writeFile(path, lines);
    return path;
  };

  test("chatgpt_base_url on the local route gives the placeholder login of agents-codex", async () => {
    const secrets = await secretsWith(`AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN=${CODEX_KEY}\n`);
    const dir = join(scratch, "pool");
    await mkdir(dir);
    await writeFile(join(dir, "config.toml"), `chatgpt_base_url = "http://127.0.0.1:47140/codex/backend-api"\n${routedConfig}`);
    const entry = JSON.parse((await codexPoolEntryText(dir, secrets))!);
    expect(entry.tokens).toMatchObject({ access_token: CODEX_KEY, account_id: "ais-agents-codex" });
    expect(entry.OPENAI_API_KEY).toBeNull();
  });

  test("the cluster form keeps its own app", async () => {
    const secrets = await secretsWith(`AIS_GATEWAY_APP_BILLING_TOKEN=${CODEX_KEY}\n`);
    const dir = join(scratch, "pool");
    await mkdir(dir);
    await writeFile(join(dir, "config.toml"), 'chatgpt_base_url = "https://gw.test/billing/backend-api"\n\n[model_providers.ais-gateway]\nbase_url = "https://gw.test/billing"\n');
    expect(JSON.parse((await codexPoolEntryText(dir, secrets))!).tokens.account_id).toBe("ais-billing");
  });

  test("a codex-home folder on the local route checks clean", async () => {
    const dir = join(scratch, "pool");
    await mkdir(dir);
    await writeFile(join(dir, "config.toml"), routedConfig);
    await configureCodexGatewayHome(dir, CODEX_KEY);
    expect(await codexGatewayHomeProblem(dir)).toBeUndefined();
  });
});
