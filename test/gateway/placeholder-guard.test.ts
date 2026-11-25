import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { grantFreshness, HomeMirror, isFresher, isPlaceholderLogin, isRefreshableLogin, mergeByKey } from "../../src/gateway/home-mirror.ts";
import { importHome } from "../../src/gateway/home-import.ts";
import { sha256Hex, type HomeFileKind, type HomeFileMeta, type HomeFileRow, type PgHomeStore, type PutResult } from "../../src/gateway/home-store.ts";

/** A gateway placeholder login (an app token, far-future expiry, no refresh token) never beats or replaces a real login. */

const real = (tag: string, expiresAtMs = 1_795_635_411_000): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE-a-${tag}`, refreshToken: `SYNTHETIC_FIXTURE-r-${tag}`, expiresAt: expiresAtMs } });
const PLACEHOLDER = gatewayEntryText("aisg_SYNTHETIC_FIXTURE_token");
const LOGIN = ".claude/identities/alpha/.credentials.json";

class FakeStore {
  rows = new Map<string, HomeFileRow>();
  puts: string[] = [];
  private version = 0;
  async list(): Promise<HomeFileMeta[]> {
    return [...this.rows.values()].map(({ content: _c, ...meta }) => meta);
  }
  async get(paths: string[]): Promise<HomeFileRow[]> {
    return paths.flatMap((p) => (this.rows.has(p) ? [this.rows.get(p)!] : []));
  }
  async getAccount(account: string): Promise<HomeFileRow[]> {
    return [...this.rows.values()].filter((r) => r.account === account);
  }
  async put(path: string, content: Buffer, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    const cur = this.rows.get(path);
    if ((opts.expectedVersion === null && cur) || (typeof opts.expectedVersion === "number" && cur?.version !== opts.expectedVersion)) return { ok: false };
    this.puts.push(path);
    this.version += 1;
    this.rows.set(path, { path, account: opts.account, kind: opts.kind, sha256: sha256Hex(content), version: this.version, content });
    return { ok: true, version: this.version };
  }
  async listen(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
  seed(path: string, text: string, kind: HomeFileKind = "login"): void {
    this.version += 1;
    this.rows.set(path, { path, account: "claude/alpha", kind, sha256: sha256Hex(text), version: this.version, content: Buffer.from(text) });
  }
  text(path: string): string | undefined {
    return this.rows.get(path)?.content.toString("utf8");
  }
}
const asStore = (s: FakeStore): PgHomeStore => s as unknown as PgHomeStore;

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-placeholder-guard-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const put = async (home: string, rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(home, rel)), { recursive: true });
  await writeFile(join(home, rel), text);
};

describe("freshness", () => {
  test("a gateway placeholder has no freshness and never beats a real login", () => {
    expect(grantFreshness(PLACEHOLDER)).toBeUndefined();
    expect(isFresher(PLACEHOLDER, real("x"))).toBe(false);
    expect(isFresher(real("x"), PLACEHOLDER)).toBe(true);
  });

  test("mergeByKey keeps the real entry over a placeholder entry", () => {
    const placeholderPi = JSON.stringify({ anthropic: { type: "oauth", access: "aisg_SYNTHETIC_FIXTURE_token", refresh: "", expires: 4_102_444_800_000 } });
    const realPi = JSON.stringify({ anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-a", refresh: "SYNTHETIC_FIXTURE-r", expires: 1_795_635_411_000 } });
    const merged = JSON.parse(mergeByKey(placeholderPi, realPi)!.toString()) as { anthropic: { refresh: string } };
    expect(merged.anthropic.refresh).toBe("SYNTHETIC_FIXTURE-r");
  });
});

describe("per entry placeholder check", () => {
  const piMixed = JSON.stringify({
    anthropic: { type: "oauth", access: "aisg_SYNTHETIC_FIXTURE_token", refresh: "", expires: 4_102_444_800_000 },
    "openai-codex": { type: "oauth", access: "SYNTHETIC_FIXTURE-a", refresh: "SYNTHETIC_FIXTURE-r", expires: 1_795_635_411_000 },
  });
  test("one gateway entry in a pi auth.json does not mark the whole file, and its real entry still counts", () => {
    expect(isPlaceholderLogin(piMixed)).toBe(false);
    expect(isRefreshableLogin(piMixed)).toBe(true);
    expect(grantFreshness(piMixed)).toBe(1_795_635_411);
  });
  test("codex's literal none refresh token is no refresh token", () => {
    const codexPlaceholder = JSON.stringify({ OPENAI_API_KEY: "aisg_SYNTHETIC_FIXTURE_token", tokens: { access_token: "aisg_SYNTHETIC_FIXTURE_token", refresh_token: "none" } });
    expect(isRefreshableLogin(codexPlaceholder)).toBe(false);
    expect(isPlaceholderLogin(codexPlaceholder)).toBe(true);
  });
  test("a previous row with any real refresh token is protected", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(".pi/identities/alpha/auth.json", piMixed);
    await put(home, ".pi/identities/alpha/auth.json", PLACEHOLDER);
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, ".pi/identities/alpha/auth.json"), account: "pi/alpha", kind: "login" }] });
    expect(store.puts).toEqual([]);
    expect(report.skipped.length).toBe(1);
  });
});

describe("member account record", () => {
  test("a .claude.json beside a login is uploaded although it holds no refresh token", async () => {
    const home = await tmp();
    const store = new FakeStore();
    const rel = ".ais/gateway-members/claude/alpha/.claude.json";
    await put(home, rel, JSON.stringify({ oauthAccount: { accountUuid: "uuid-1" } }));
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, rel), account: "claude/alpha", kind: "login" }] });
    expect(report.added).toEqual([rel]);
  });
});

describe("importHome", () => {
  test("a host folder that holds only the placeholder leaves a real store row unchanged and is reported skipped", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, real("store"));
    await put(home, LOGIN, PLACEHOLDER);
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login" }] });
    expect(store.text(LOGIN)).toBe(real("store"));
    expect(store.puts).toEqual([]);
    expect(report.skipped.some((s) => s.path === LOGIN && s.why.includes("placeholder"))).toBe(true);
  });

  test("a placeholder is not uploaded even when the store has no row", async () => {
    const home = await tmp();
    const store = new FakeStore();
    await put(home, LOGIN, PLACEHOLDER);
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login" }] });
    expect(store.puts).toEqual([]);
    expect(report.added).toEqual([]);
    expect(report.skipped.length).toBe(1);
  });

  test("a login file without a refresh token is not uploaded", async () => {
    const home = await tmp();
    const store = new FakeStore();
    await put(home, LOGIN, JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE-a", expiresAt: 4_102_444_800_000 } }));
    const report = await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login" }] });
    expect(store.puts).toEqual([]);
    expect(report.skipped[0]?.why).toContain("refresh token");
  });

  test("a real, fresher login still replaces an older real login", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, real("old", 1_700_000_000_000));
    await put(home, LOGIN, real("new", 1_800_000_000_000));
    await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login" }] });
    expect(store.text(LOGIN)).toBe(real("new", 1_800_000_000_000));
  });
});

describe("HomeMirror", () => {
  test("first sight with a local placeholder and a real row writes the row and does not push", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, real("store"));
    await put(home, LOGIN, PLACEHOLDER);
    await new HomeMirror(asStore(store), { home, fileStore: true, warn: () => {} }).pullAll();
    expect(store.puts).toEqual([]);
    expect(store.text(LOGIN)).toBe(real("store"));
  });

  test("a local placeholder is never pushed over a real row, even when only the local file moved", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, real("store"));
    await put(home, LOGIN, real("store"));
    const mirror = new HomeMirror(asStore(store), { home, fileStore: true, warn: () => {} });
    await mirror.pullAll();
    await put(home, LOGIN, PLACEHOLDER);
    await mirror.pushDirty();
    expect(store.puts).toEqual([]);
    expect(store.text(LOGIN)).toBe(real("store"));
    expect(await readFile(join(home, LOGIN), "utf8")).toBe(real("store"));
  });
});
