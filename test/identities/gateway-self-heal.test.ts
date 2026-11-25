import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { hasMemberCopy, memberDir } from "../../src/identities/gateway-members.ts";
import { HomeMirror } from "../../src/gateway/home-mirror.ts";
import { pushRefreshed, refreshPushPaths } from "../../src/gateway/serve.ts";
import { writeGrantThroughStores } from "../../src/identities/oauth-refresh.ts";
import type { Identity } from "../../src/identities/types.ts";

/** A refreshed grant of an identity with no member-store copy reaches the member store, whatever the folder or the pi registry hold. */

let root: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["AIS_GATEWAY_MEMBERS_DIR", "AIS_GATEWAY_MEMBER_STORE", "AIS_GATEWAY_OWNER"] as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-self-heal-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
  process.env.AIS_GATEWAY_MEMBER_STORE = "1";
  process.env.AIS_GATEWAY_OWNER = "1";
});
afterEach(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

const grant = { access_token: "SYNTHETIC_FIXTURE-access", refresh_token: "SYNTHETIC_FIXTURE-refresh", expires_at: 1_795_635_411 };

async function routedFolder(): Promise<Identity> {
  const configDir = join(root, "identities", "alpha");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, ".credentials.json"), gatewayEntryText("aisg_SYNTHETIC_FIXTURE_token"));
  return { name: "alpha", label: "alpha", configDir } as Identity;
}

describe("gateway self-heal", () => {
  test("an identity with a placeholder folder and no member copy gets the refreshed grant in the member store", async () => {
    const identity = await routedFolder();
    expect(hasMemberCopy("claude", "alpha")).toBe(false);
    const report = await writeGrantThroughStores("claude", identity, grant, { piDir: undefined, poolDirs: [] });
    expect(report.failed).toEqual([]);
    expect(report.written.some((w) => w.startsWith("member:"))).toBe(true);
    expect(hasMemberCopy("claude", "alpha")).toBe(true);
    const stored = JSON.parse(await readFile(join(memberDir("claude", "alpha"), ".credentials.json"), "utf8")) as { claudeAiOauth: { refreshToken: string } };
    expect(stored.claudeAiOauth.refreshToken).toBe("SYNTHETIC_FIXTURE-refresh");
  });

  test("a process that is not the gateway (member store off) writes no member copy", async () => {
    process.env.AIS_GATEWAY_MEMBER_STORE = "0";
    const identity = await routedFolder();
    const report = await writeGrantThroughStores("claude", identity, grant, { poolDirs: [] });
    expect(report.written.some((w) => w.startsWith("member:"))).toBe(false);
    expect(hasMemberCopy("claude", "alpha")).toBe(false);
  });

  test("a process that is not the gateway owner (ais gateway local) never takes a login over", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    const identity = await routedFolder();
    const report = await writeGrantThroughStores("claude", identity, grant, { poolDirs: [] });
    expect(report.written.some((w) => w.startsWith("member:"))).toBe(false);
  });

  test("a host-owned login (a refreshable folder login, not routed) gets no member copy", async () => {
    const configDir = join(root, "identities", "hostowned");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE-a", refreshToken: "SYNTHETIC_FIXTURE-r", expiresAt: 1 } }));
    const report = await writeGrantThroughStores("claude", { name: "hostowned", label: "h", configDir } as Identity, grant, { poolDirs: [] });
    expect(report.written.some((w) => w.startsWith("member:"))).toBe(false);
    expect(hasMemberCopy("claude", "hostowned")).toBe(false);
  });
});

describe("the healed member copy reaches the store", () => {
  test("the push after a refresh names the member login file, not only the labels the write-through lists", async () => {
    const identity = await routedFolder();
    const report = await writeGrantThroughStores("claude", identity, grant, { poolDirs: [] });
    const paths = await refreshPushPaths("claude", identity, report.written, async () => []);
    expect(paths).toContain(join(memberDir("claude", "alpha"), ".credentials.json"));
  });

  test("pushing those paths through the mirror puts the member login row in the store", async () => {
    const identity = await routedFolder();
    const report = await writeGrantThroughStores("claude", identity, grant, { poolDirs: [] });
    const rows = new Map<string, { account: string | null; text: string }>();
    const store = {
      get: async () => [],
      list: async () => [],
      getAccount: async () => [],
      put: async (path: string, content: Buffer, o: { account: string | null }) => (rows.set(path, { account: o.account, text: content.toString("utf8") }), { ok: true as const, version: 1 }),
      listen: async () => async () => undefined,
    };
    const mirror = new HomeMirror(store as never, { home: root, warn: () => {} });
    await mirror.push(await refreshPushPaths("claude", identity, report.written, async () => []), "claude/alpha", "login");
    const rel = [...rows.keys()].find((k) => k.endsWith("members/claude/alpha/.credentials.json"));
    expect(rel).toBeDefined();
    expect(rows.get(rel!)!.text).toContain("SYNTHETIC_FIXTURE-refresh");
  });
});

describe("pushRefreshed raises only for files that really failed", () => {
  const identity = { name: "alpha", label: "a", configDir: "/h/alpha" } as Identity;
  const fake = (o: { push?: Error; dirty?: Error; tracked: boolean }) => ({
    push: async () => {
      if (o.push) throw o.push;
    },
    pushAccountDirty: async () => {
      if (o.dirty) throw o.dirty;
    },
    tracks: () => o.tracked,
  });
  const run = (m: ReturnType<typeof fake>) => pushRefreshed(m as never, "claude", identity, [], async () => ["/h/alpha/.credentials.json"]);

  test("a listed file that failed but is tracked and pushed by the dirty pass is no failure", async () => {
    await expect(run(fake({ push: new Error("db down"), tracked: true }))).resolves.toBeUndefined();
  });
  test("a listed file that failed and is not tracked stays a failure", async () => {
    await expect(run(fake({ push: new Error("db down"), tracked: false }))).rejects.toThrow("db down");
  });
  test("a dirty file that failed is a failure", async () => {
    await expect(run(fake({ dirty: new Error("still down"), tracked: true }))).rejects.toThrow("still down");
  });
  test("no failure at all", async () => {
    await expect(run(fake({ tracked: true }))).resolves.toBeUndefined();
  });
});
