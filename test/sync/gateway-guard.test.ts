import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { isGatewayManagedHere } from "../../src/identities/gateway-managed.ts";
import { decideCredentialMerge, withoutProviders } from "../../src/sync/gateway-guard.ts";
import { mergeIncomingProfileTree, setDirectOwnerProbe } from "../../src/sync/tree-merge.ts";

const KEY = "aisg_SYNTHETIC_FIXTURE_key";
const T = 1_700_000_000;
const all = { kind: "all" } as const;
const noPurge = async () => ({ removed: [], warnings: [] });
const claudeLogin = (n: string) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt: 1 } });
const codexLogin = (n: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `at-SYNTHETIC_FIXTURE-${n}`, refresh_token: `rt-SYNTHETIC_FIXTURE-${n}` } });
const codexEntry = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: KEY });
const piAuth = JSON.stringify({ anthropic: { type: "oauth", access: "pi-a", refresh: "pi-rt-a" }, "openai-codex": { type: "oauth", access: "pi-c", refresh: "pi-rt-c" } });

const dirs: string[] = [];
let savedOwner: string | undefined;
// Another test file may have marked this process as the gateway owner: these checks are for every other process.
beforeEach(() => {
  savedOwner = process.env.AIS_GATEWAY_OWNER;
  process.env.AIS_GATEWAY_OWNER = "0";
});
afterEach(async () => {
  if (savedOwner === undefined) delete process.env.AIS_GATEWAY_OWNER;
  else process.env.AIS_GATEWAY_OWNER = savedOwner;
  setDirectOwnerProbe();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ais-gateway-guard-"));
  dirs.push(root);
  const [home, incoming] = [join(root, "home"), join(root, "incoming")];
  setDirectOwnerProbe(async () => false);
  for (const base of [".claude", ".codex", ".pi"]) {
    await mkdir(join(home, base, "identities", "alpha"), { recursive: true });
    await writeFile(join(home, base, "identities.json"), JSON.stringify({ version: 1, identities: [{ name: "alpha", label: "alpha", configDir: join(home, base, "identities", "alpha") }] }));
  }
  const put = async (base: string, rel: string, content: string, mtime: number) => {
    await mkdir(dirname(join(base, rel)), { recursive: true });
    await writeFile(join(base, rel), content);
    await utimes(join(base, rel), mtime, mtime);
  };
  const memberCopy = async (tool: string, file: string, content: string) => put(join(home, ".ais", "gateway-members", tool, "alpha"), file, content, T);
  const merge = () => mergeIncomingProfileTree(incoming, all, { home, purgeRetired: noPurge });
  const read = (rel: string) => readFile(join(home, rel), "utf8");
  return { home, incoming, put, memberCopy, merge, read };
}

const CLAUDE = ".claude/identities/alpha/.credentials.json";
const CODEX = ".codex/identities/alpha/auth.json";
const PI = ".pi/identities/alpha/auth.json";

describe("decideCredentialMerge", () => {
  test("a member store copy here keeps the local file whatever arrives", () => {
    expect(decideCredentialMerge("claude", claudeLogin("a"), gatewayEntryText(KEY), true)).toBe("keep-local");
    expect(decideCredentialMerge("claude", gatewayEntryText(KEY), claudeLogin("a"), true)).toBe("keep-local");
  });
  test("a gateway entry is never replaced by a login, and replaces one", () => {
    expect(decideCredentialMerge("claude", gatewayEntryText(KEY), claudeLogin("a"), false)).toBe("keep-local");
    expect(decideCredentialMerge("codex", codexEntry, codexLogin("a"), false)).toBe("keep-local");
    expect(decideCredentialMerge("claude", claudeLogin("a"), gatewayEntryText(KEY), false)).toBe("take-incoming");
    expect(decideCredentialMerge("codex", undefined, codexEntry, false)).toBe("take-incoming");
    expect(decideCredentialMerge("claude", claudeLogin("a"), claudeLogin("b"), false)).toBe("merge");
  });
  test("withoutProviders drops only the named providers", () => {
    expect(JSON.parse(withoutProviders(piAuth, ["anthropic"])!)).toEqual({ "openai-codex": { type: "oauth", access: "pi-c", refresh: "pi-rt-c" } });
    expect(withoutProviders(JSON.stringify({ x: 1 }), ["anthropic"])).toBeUndefined();
    expect(withoutProviders("not json", ["anthropic"])).toBeUndefined();
  });
});

describe("sync merge of gateway-routed logins", () => {
  test("the routing host never takes a newer real login over its gateway entry", async () => {
    const f = await fixture();
    await f.memberCopy("claude", ".credentials.json", claudeLogin("store"));
    await f.put(f.home, CLAUDE, gatewayEntryText(KEY), T);
    await f.put(f.incoming, CLAUDE, claudeLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(gatewayEntryText(KEY));
  });

  test("a member store copy here keeps the folder even before it holds the entry (mid-routing)", async () => {
    const f = await fixture();
    await f.memberCopy("codex", "auth.json", codexLogin("store"));
    await f.put(f.home, CODEX, codexLogin("local"), T);
    await f.put(f.incoming, CODEX, codexLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CODEX)).toBe(codexLogin("local"));
  });

  test("a host without the store copy takes an arriving gateway entry over its newer login, and keeps it after", async () => {
    const f = await fixture();
    await f.put(f.home, CODEX, codexLogin("local"), T + 100);
    await f.put(f.incoming, CODEX, codexEntry, T);
    await f.merge();
    expect(await f.read(CODEX)).toBe(codexEntry);
    // the identity is now the gateway's on this host: nothing here refreshes or reconciles it
    expect(await isGatewayManagedHere("codex", "alpha", join(f.home, ".codex", "identities.json"))).toBe(true);
    // a third host that has not seen the routing yet cannot undo it
    await rm(f.incoming, { recursive: true, force: true });
    await f.put(f.incoming, CODEX, codexLogin("third"), T + 500);
    await f.merge();
    expect(await f.read(CODEX)).toBe(codexEntry);
  });

  test("other logins still merge by time", async () => {
    const f = await fixture();
    await f.put(f.home, CLAUDE, claudeLogin("local"), T);
    await f.put(f.incoming, CLAUDE, claudeLogin("remote"), T + 100);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(claudeLogin("remote"));
    expect(await isGatewayManagedHere("claude", "alpha", join(f.home, ".claude", "identities.json"))).toBe(false);
  });

  test("pi's copy of a routed login is dropped from what arrives and from the live file, other providers kept", async () => {
    const f = await fixture();
    await f.memberCopy("claude", ".credentials.json", claudeLogin("store"));
    await f.put(f.home, CLAUDE, gatewayEntryText(KEY), T);
    await f.put(f.home, PI, JSON.stringify({ "openai-codex": { type: "oauth", access: "old" } }), T);
    await f.put(f.incoming, PI, piAuth, T + 100);
    await f.merge();
    const live = JSON.parse(await f.read(PI));
    expect(live.anthropic).toBeUndefined();
    expect(live["openai-codex"].access).toBe("pi-c");
  });

  test("a gateway entry that arrives strips the receiving host's own pi copy (after a backup)", async () => {
    const f = await fixture();
    await f.put(f.home, CLAUDE, claudeLogin("local"), T + 100);
    await f.put(f.home, PI, piAuth, T + 100);
    await f.put(f.incoming, CLAUDE, gatewayEntryText(KEY), T);
    await f.merge();
    expect(await f.read(CLAUDE)).toBe(gatewayEntryText(KEY));
    const live = JSON.parse(await f.read(PI));
    expect(live.anthropic).toBeUndefined();
    expect(live["openai-codex"].refresh).toBe("pi-rt-c");
    const backups = (await readdir(join(f.home, ".pi", "identities", "alpha"))).filter((n) => n.includes(".pre-gateway."));
    expect(backups.length).toBe(1);
  });
});
