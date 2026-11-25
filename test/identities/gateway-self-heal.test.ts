import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { hasMemberCopy, memberDir } from "../../src/identities/gateway-members.ts";
import { writeGrantThroughStores } from "../../src/identities/oauth-refresh.ts";
import type { Identity } from "../../src/identities/types.ts";

/** A refreshed grant of an identity with no member-store copy reaches the member store, whatever the folder or the pi registry hold. */

let root: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["AIS_GATEWAY_MEMBERS_DIR", "AIS_GATEWAY_MEMBER_STORE"] as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-self-heal-"));
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
  process.env.AIS_GATEWAY_MEMBER_STORE = "1";
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
});
