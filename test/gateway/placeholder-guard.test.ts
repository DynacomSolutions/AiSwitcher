import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatewayEntryText } from "../../src/identities/claude-gateway-entry.ts";
import { grantFreshness, HomeMirror, isFresher, isPlaceholderLogin, isRefreshableLogin, mergeByKey } from "../../src/gateway/home-mirror.ts";
import { importHome } from "../../src/gateway/home-import.ts";
import { startHostSync } from "../../src/gateway/host-sync.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
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

const realEntry = (tag: string, exp: number) => ({ type: "oauth", access: `SYNTHETIC_FIXTURE-a-${tag}`, refresh: `SYNTHETIC_FIXTURE-r-${tag}`, expires: exp });
const gwEntry = { type: "oauth", access: "aisg_SYNTHETIC_FIXTURE_token", refresh: "", expires: 4_102_444_800_000 };
const PI = ".pi/identities/alpha/auth.json";

describe("a mixed pi auth.json (real entry beside a gateway entry)", () => {
  async function inStep() {
    const home = await tmp();
    const store = new FakeStore();
    const rowText = JSON.stringify({ anthropic: realEntry("a", 1_795_000_000_000), "openai-codex": realEntry("c", 1_795_000_000_000) });
    store.seed(PI, rowText);
    store.rows.get(PI)!.account = "pi/alpha";
    await put(home, PI, rowText);
    const mirror = new HomeMirror(asStore(store), { home, fileStore: true, warn: () => {} });
    await mirror.pullAll();
    return { home, store, mirror };
  }

  test("only local changed: the rotated entry is pushed, the gateway entry never is", async () => {
    const { home, store, mirror } = await inStep();
    await put(home, PI, JSON.stringify({ anthropic: gwEntry, "openai-codex": realEntry("c2", 1_796_000_000_000) }));
    await mirror.pushDirty();
    const row = JSON.parse(store.text(PI)!) as { anthropic: { refresh: string }; "openai-codex": { refresh: string } };
    expect(row.anthropic.refresh).toBe("SYNTHETIC_FIXTURE-r-a");
    expect(row["openai-codex"].refresh).toBe("SYNTHETIC_FIXTURE-r-c2");
    expect(JSON.parse(await readFile(join(home, PI), "utf8")).anthropic.refresh).toBe("SYNTHETIC_FIXTURE-r-a");
  });

  test("push() reconciles the same file instead of pushing it as is", async () => {
    const { home, store, mirror } = await inStep();
    await put(home, PI, JSON.stringify({ anthropic: gwEntry, "openai-codex": realEntry("c2", 1_796_000_000_000) }));
    await mirror.push([join(home, PI)], "pi/alpha", "login");
    expect(JSON.parse(store.text(PI)!).anthropic.refresh).toBe("SYNTHETIC_FIXTURE-r-a");
  });
});

describe("one refused file never starves the later ones", () => {
  test("pushDirty and pushAccountDirty push every other dirty file when one push throws", async () => {
    const home = await tmp();
    const store = new FakeStore();
    const a = ".claude/identities/a/.credentials.json";
    const b = ".claude/identities/b/.credentials.json";
    store.seed(a, real("ra"));
    store.seed(b, real("rb"));
    store.rows.get(b)!.account = "claude/a";
    await put(home, a, real("ra"));
    await put(home, b, real("rb"));
    const mirror = new HomeMirror(asStore(store), { home, fileStore: true, warn: () => {} });
    await mirror.pullAll();
    await put(home, a, real("ra2", 1_796_000_000_000));
    await put(home, b, real("rb2", 1_796_000_000_000));
    const put0 = store.put.bind(store);
    store.put = async (path, content, o) => {
      if (path === a) throw new Error("refused");
      return put0(path, content, o);
    };
    await expect(mirror.pushDirty()).rejects.toThrow("refused");
    expect(store.text(b)).toBe(real("rb2", 1_796_000_000_000));
    await put(home, b, real("rb3", 1_797_000_000_000));
    await expect(mirror.pushAccountDirty("claude/a")).resolves.toBeUndefined();
    expect(store.text(b)).toBe(real("rb3", 1_797_000_000_000));
  });
});

describe("importHome with a mixed login file", () => {
  const PI = ".pi/agent/auth.json";
  const piReal = { anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-pa", refresh: "SYNTHETIC_FIXTURE-pr", expires: 1_795_000_000_000 }, "openai-codex": { type: "oauth", access: "SYNTHETIC_FIXTURE-ca", refresh: "SYNTHETIC_FIXTURE-cr", expires: 1_795_000_000_000 } };
  const piMixed = { anthropic: { type: "oauth", access: "aisg_SYNTHETIC_FIXTURE_token", expires: 4_102_444_800_000 }, "openai-codex": { type: "oauth", access: "SYNTHETIC_FIXTURE-ca2", refresh: "SYNTHETIC_FIXTURE-cr2", expires: 1_796_000_000_000 } };

  test("a fresher real entry is merged in and the gateway entry never replaces the real one", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(PI, JSON.stringify(piReal));
    await put(home, PI, JSON.stringify(piMixed));
    const rep = await importHome(asStore(store), { home, entries: [{ abs: join(home, PI), account: "pi/a", kind: "login" }] });
    const row = JSON.parse(store.text(PI)!);
    expect(row.anthropic.refresh).toBe("SYNTHETIC_FIXTURE-pr");
    expect(row.anthropic.access.startsWith("aisg_")).toBe(false);
    expect(row["openai-codex"].refresh).toBe("SYNTHETIC_FIXTURE-cr2");
    expect(rep.updated).toEqual([PI]);
  });

  test("a claude file with real mcpOAuth beside a placeholder claudeAiOauth keeps the real login", async () => {
    const home = await tmp();
    const store = new FakeStore();
    const mcp = { s: { accessToken: "SYNTHETIC_FIXTURE-m", refreshToken: "SYNTHETIC_FIXTURE-mr", expiresAt: 1_796_000_000_000 } };
    store.seed(LOGIN, JSON.stringify({ claudeAiOauth: JSON.parse(real("x")).claudeAiOauth, mcpOAuth: { s: { ...mcp.s, expiresAt: 1_795_000_000_000 } } }));
    await put(home, LOGIN, JSON.stringify({ claudeAiOauth: JSON.parse(PLACEHOLDER).claudeAiOauth, mcpOAuth: mcp }));
    await importHome(asStore(store), { home, entries: [{ abs: join(home, LOGIN), account: "claude/alpha", kind: "login" }] });
    const row = JSON.parse(store.text(LOGIN)!);
    expect(row.claudeAiOauth.refreshToken).toBe("SYNTHETIC_FIXTURE-r-x");
    expect(row.mcpOAuth.s.refreshToken).toBe("SYNTHETIC_FIXTURE-mr");
  });

  test("a merge that would still lose a login is skipped, not pushed", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(PI, JSON.stringify(piReal));
    await put(home, PI, JSON.stringify({ anthropic: piMixed.anthropic, "openai-codex": { ...piReal["openai-codex"] } }));
    const rep = await importHome(asStore(store), { home, entries: [{ abs: join(home, PI), account: "pi/a", kind: "login" }] });
    expect(store.puts).toEqual([]);
    expect(rep.updated).toEqual([]);
  });

  test("one failing entry is reported skipped and the later entries still import", async () => {
    const home = await tmp();
    const store = new FakeStore();
    const b = ".claude/identities/beta/.credentials.json";
    store.seed(LOGIN, real("old", 1_790_000_000_000));
    store.seed(b, real("oldb", 1_790_000_000_000));
    await put(home, LOGIN, real("new", 1_796_000_000_000));
    await put(home, b, real("newb", 1_796_000_000_000));
    const put0 = store.put.bind(store);
    store.put = async (path, content, o) => {
      if (path === LOGIN) throw new Error("refused");
      return put0(path, content, o);
    };
    const rep = await importHome(asStore(store), {
      home,
      entries: [
        { abs: join(home, LOGIN), account: "claude/alpha", kind: "login" },
        { abs: join(home, b), account: "claude/beta", kind: "login" },
      ],
    });
    expect(rep.skipped.some((s) => s.path === LOGIN)).toBe(true);
    expect(store.text(b)).toBe(real("newb", 1_796_000_000_000));
  });
});

describe("host sync pass", () => {
  test("a failing first import never stops the sync: the mirror still starts and follows the store", async () => {
    const home = await tmp();
    const store = new FakeStore();
    store.seed(LOGIN, real("s1", 1_795_000_000_000));
    const warnings: string[] = [];
    const sync = startHostSync(undefined, {
      home,
      store: asStore(store),
      lock: new MemoryRefreshBackend(),
      importEntries: async () => {
        throw new Error("import broke");
      },
      pollMs: 20,
      importMs: 60_000,
      warn: (m: string) => warnings.push(m),
    });
    await sync.ready;
    expect(await readFile(join(home, LOGIN), "utf8")).toBe(real("s1", 1_795_000_000_000));
    store.seed(LOGIN, real("s2", 1_796_000_000_000));
    for (let i = 0; i < 60 && !(await readFile(join(home, LOGIN), "utf8")).includes("s2"); i++) await Bun.sleep(25);
    expect(await readFile(join(home, LOGIN), "utf8")).toContain("s2");
    expect(warnings.some((w) => w.includes("import failed"))).toBe(true);
    await sync.stop();
  });
});
