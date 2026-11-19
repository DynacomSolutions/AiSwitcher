import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdoptLogin } from "../../../src/cli/identities/adopt-login.ts";
import type { RouteAllOptions } from "../../../src/cli/identities/route-all.ts";
import { classifyLogin, refreshOf } from "../../../src/identities/gateway-routed.ts";
import { CliUsageError } from "../../../src/cli/errors.ts";

/** `ais identities adopt-login`: the owner's sign-in already in the folder becomes the gateway's account. */

const KEY = "aisg_SYNTHETIC_FIXTURE_claude_key";
const claudeLogin = (n: string) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-SYNTHETIC_FIXTURE-${n}`, refreshToken: `rt-SYNTHETIC_FIXTURE-${n}`, expiresAt: 2_000_000_000_000, scopes: [] } });
const account = (uuid: string, email: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } });

let home: string;
let folder: string;
let store: string;
let opts: RouteAllOptions;
const lines: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ais-adopt-"));
  folder = join(home, "folder");
  store = join(home, "members", "claude", "alpha");
  await mkdir(folder, { recursive: true });
  await mkdir(store, { recursive: true });
  await mkdir(join(home, "proc"), { recursive: true });
  await writeFile(join(home, "claude.json"), JSON.stringify({ version: 1, identities: [{ name: "alpha", label: "alpha", configDir: folder }] }));
  await writeFile(join(home, "secrets"), `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${KEY}\n`);
  await writeFile(join(store, ".credentials.json"), claudeLogin("old"));
  await writeFile(join(store, ".claude.json"), account("uuid-a", "alice@example.test"));
  await writeFile(join(folder, ".credentials.json"), claudeLogin("new"));
  await writeFile(join(folder, ".claude.json"), account("uuid-b", "bob@example.test"));
  lines.length = 0;
  opts = {
    registries: { claude: join(home, "claude.json"), codex: join(home, "n1.json"), grok: join(home, "n2.json"), kimi: join(home, "n3.json"), pi: join(home, "n4.json") },
    secretsPath: join(home, "secrets"),
    memberRoot: join(home, "members"),
    heartbeatPath: join(home, "none-heartbeat.json"),
    home,
    procRoot: join(home, "proc"),
    hostname: "test-host",
    out: () => {},
  };
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  await rm(home, { recursive: true, force: true });
});

describe("adopt-login", () => {
  test("replaces the store copy of another account, prints now uses B (was A), puts the gateway entry back", async () => {
    await runAdoptLogin(["claude", "alpha"], opts, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("alpha now uses bob@example.test (was alice@example.test)");
    expect(refreshOf("claude", readFileSync(join(store, ".credentials.json"), "utf8"))).toBe("rt-SYNTHETIC_FIXTURE-new");
    expect(classifyLogin("claude", readFileSync(join(folder, ".credentials.json"), "utf8"))).toBe("gateway");
    expect(JSON.parse(readFileSync(join(store, ".claude.json"), "utf8")).oauthAccount.accountUuid).toBe("uuid-b");
    expect(lines.join("\n")).not.toContain("SYNTHETIC_FIXTURE");
    expect(process.exitCode).toBe(0);
  });

  test("the push to the PostgreSQL store runs once and its note is reported", async () => {
    const pushed: string[] = [];
    await runAdoptLogin(["claude", "alpha"], { ...opts, storePush: async (t, n) => (pushed.push(`${t}/${n}`), "pushed 3 files to the PostgreSQL store") }, (l) => lines.push(l));
    expect(pushed).toEqual(["claude/alpha"]);
    expect(lines.join("\n")).toContain("pushed 3 files");
  });

  test("refuses only when the folder holds no login", async () => {
    await writeFile(join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: KEY, scopes: [] } }));
    await expect(runAdoptLogin(["claude", "alpha"], opts, (l) => lines.push(l))).rejects.toBeInstanceOf(CliUsageError);
    await expect(runAdoptLogin(["claude", "missing"], opts)).rejects.toBeInstanceOf(CliUsageError);
    await expect(runAdoptLogin(["grok", "alpha"], opts)).rejects.toBeInstanceOf(CliUsageError);
  });
});
