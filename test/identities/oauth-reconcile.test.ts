import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  grantFingerprint,
  reconcilePiConfigDirOnLaunch,
  reconcilePiOAuthStores,
  renderOAuthReconcileReport,
} from "../../src/identities/oauth-reconcile.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";

// The reconcile resolves ALL five registries by same-named identity, so the
// tests build real temp registries (claude, codex, grok, kimi, pi) and
// repoint each tool's identitiesJsonPath for the duration of every test.
// The real ~/.claude, ~/.codex, ~/.grok, ~/.kimi-code and ~/.pi registries
// are never touched; afterEach restores the original paths.
const tempDirs: string[] = [];
const savedPaths: Record<string, string> = {};

let dirs: Record<"claude" | "codex" | "grok" | "kimi" | "pi", string> = {} as never;

const ACME = "acme";

const CLAUDE_FILE = () => join(dirs.claude, ".credentials.json");
const CODEX_FILE = () => join(dirs.codex, "auth.json");
const GROK_FILE = () => join(dirs.grok, "auth.json");
const KIMI_FILE = () => join(dirs.kimi, "credentials", "kimi-code.json");
const PI_AUTH = () => join(dirs.pi, "auth.json");

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-oauth-reconcile-"));
  tempDirs.push(root);
  dirs = {
    claude: join(root, "claude-identities", ACME),
    codex: join(root, "codex-identities", ACME),
    grok: join(root, "grok-identities", ACME),
    kimi: join(root, "kimi-identities", ACME),
    pi: join(root, "pi-identities", ACME),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    savedPaths[tool] = path.identitiesJsonPath;
    (path as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}-identities.json`);
    await writeFile(
      path.identitiesJsonPath,
      JSON.stringify({ version: 1, identities: [{ name: ACME, label: "Acme", configDir: dirs[tool] }] }),
    );
  }
});

afterEach(async () => {
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    if (savedPaths[tool]) (path as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths[tool];
  }
  const roots = tempDirs.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function acmePi(): Identity {
  return { name: ACME, label: "Acme", configDir: dirs.pi };
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readMaybe(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

const MS_DAY = 86_400_000;

/** A full five-store fixture: every pairing diverged with the NATIVE copy
 * fresher except where a test says otherwise. Returns the fixture stamps. */
async function seedStores(overrides: {
  piAnthropic?: { access: string; refresh: string; expires: number };
  piCodexIat?: number;
  nativeCodexIat?: number;
} = {}): Promise<void> {
  await json(CLAUDE_FILE(), {
    claudeAiOauth: {
      accessToken: "claude-acc",
      refreshToken: "claude-ref",
      expiresAt: 1_900_000_000_000,
      refreshTokenExpiresAt: 1_999_000_000_000,
      scopes: ["user:inference"],
    },
    mcpOAuth: { server: { accessToken: "keep-me" } },
  });
  await json(CODEX_FILE(), {
    tokens: {
      access_token: jwt({ iat: overrides.nativeCodexIat ?? 1_700_000_400, exp: 1_700_000_400 + MS_DAY / 1000 }),
      refresh_token: "codex-ref",
    },
    last_refresh: new Date((overrides.nativeCodexIat ?? 1_700_000_400) * 1000).toISOString(),
    account_id: "acct-keep",
  });
  await json(GROK_FILE(), {
    "https://auth.x.ai::account-one": {
      key: jwt({ iat: 1_700_000_500, exp: 1_700_000_500 + 21_600 }),
      refresh_token: "grok-ref",
      expires_at: new Date(1_900_000_600_000).toISOString(),
      email: "one@example.com",
    },
    "https://auth.x.ai::account-two": {
      key: jwt({ iat: 1_690_000_000, exp: 1_690_000_000 + 21_600 }),
      refresh_token: "grok-2-ref",
      expires_at: new Date(1_800_000_000_000).toISOString(),
      email: "two@example.com",
    },
  });
  await mkdir(join(dirs.kimi, "credentials"), { recursive: true });
  await json(KIMI_FILE(), { access_token: "kimi-acc", refresh_token: "kimi-ref", expires_at: 1_900_000_700 });
  await json(PI_AUTH(), {
    "other-provider": { type: "api_key", key: "keep-me" },
    anthropic: overrides.piAnthropic ?? {
      type: "oauth",
      access: "claude-pi-access",
      refresh: "claude-pi-refresh",
      expires: 1_700_000_000_000,
    },
    "openai-codex": {
      type: "oauth",
      access: jwt({ iat: overrides.piCodexIat ?? 1_690_000_100, exp: (overrides.piCodexIat ?? 1_690_000_100) + MS_DAY / 1000 }),
      refresh: "codex-pi-refresh",
      expires: (overrides.piCodexIat ?? 1_690_000_100) * 1000 + MS_DAY,
    },
    xai: { type: "oauth", access: "grok-pi-access", refresh: "grok-pi-refresh", expires: 1_700_000_200_000 },
    "kimi-coding": { type: "oauth", access: "kimi-pi-access", refresh: "kimi-pi-refresh", expires: 1_700_000_300_000 },
  });
}

describe("grantFingerprint", () => {
  test("is a stable 8-hex prefix that never contains the token", () => {
    const print = grantFingerprint({ access_token: "a", refresh_token: "secret-ref" });
    expect(print).toMatch(/^[0-9a-f]{8}$/);
    expect(print).toBe(grantFingerprint({ access_token: "a", refresh_token: "secret-ref" }));
    expect(print).not.toContain("secret");
    expect(print).not.toBe(grantFingerprint({ access_token: "a", refresh_token: "other-ref" }));
  });

  test("falls back to the access token when no refresh token exists", () => {
    expect(grantFingerprint({ access_token: "solo" })).toBe(grantFingerprint({ access_token: "solo", refresh_token: "  " }));
  });
});

describe("reconcilePiOAuthStores (dry run)", () => {
  test("reports diverged pairs and rewrites NOTHING", async () => {
    await seedStores();
    const before = await readFile(PI_AUTH(), "utf8");
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    expect(report.healed).toBe(0);
    const byProvider = Object.fromEntries(report.entries.map((entry) => [entry.provider, entry]));
    expect(byProvider["anthropic"]?.status).toBe("forked");
    expect(byProvider["anthropic"]?.adoptedFrom).toBe("native");
    expect(byProvider["openai-codex"]?.status).toBe("forked");
    expect(byProvider["openai-codex"]?.adoptedFrom).toBe("native");
    expect(byProvider["xai"]?.status).toBe("forked");
    expect(byProvider["kimi-coding"]?.status).toBe("forked");
    expect(await readFile(PI_AUTH(), "utf8")).toBe(before);
    expect((await readMaybe(CLAUDE_FILE()))?.claudeAiOauth).toMatchObject({ accessToken: "claude-acc" });
  });

  test("a pi-fresher pair reports pi as the adopted source", async () => {
    await seedStores({ piCodexIat: 1_710_000_000, nativeCodexIat: 1_700_000_400 });
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    const codex = report.entries.find((entry) => entry.provider === "openai-codex");
    expect(codex?.adoptedFrom).toBe("pi");
  });

  test("drift is reported in real units (the stamps are seconds apart)", async () => {
    await seedStores();
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    // anthropic fixture: native 1_900_000_000 s vs pi 1_700_000_000 s
    // = 2e8 s = 3_333_333.3 minutes = 2314.8 days.
    const anthropic = report.entries.find((entry) => entry.provider === "anthropic");
    expect(anthropic?.divergenceMinutes).toBe(3_333_333.3);
    const lines = renderOAuthReconcileReport(report).join("\n");
    expect(lines).toContain("2314.8d between copies");
  });
});

describe("reconcilePiOAuthStores (write)", () => {
  test("adopts the fresher NATIVE copy and rewrites pi in pi's shape", async () => {
    await seedStores();
    const report = await reconcilePiOAuthStores(acmePi(), { write: true });
    expect(report.healed).toBe(4);
    const pi = await readMaybe(PI_AUTH());
    // anthropic: expires mapped to pi's millisecond field
    expect(pi?.["anthropic"]).toMatchObject({
      type: "oauth",
      access: "claude-acc",
      refresh: "claude-ref",
      expires: 1_900_000_000_000,
    });
    // codex: pi's expires carries the native JWT's exp in ms
    const codex = pi?.["openai-codex"] as Record<string, unknown>;
    expect(codex.refresh).toBe("codex-ref");
    expect(codex.expires).toBe(1_700_000_400 * 1000 + MS_DAY);
    // xai + kimi converge on the native tokens
    expect(pi?.["xai"]).toMatchObject({ access: expect.stringContaining("."), refresh: "grok-ref" });
    expect(pi?.["kimi-coding"]).toMatchObject({ access: "kimi-acc", expires: 1_900_000_700_000 });
    // unrelated pi entries survive
    expect(pi?.["other-provider"]).toMatchObject({ key: "keep-me" });
  });

  test("adopts the fresher PI copy and rewrites the native store in ITS shape", async () => {
    await seedStores({ piCodexIat: 1_710_000_000, nativeCodexIat: 1_700_000_400 });
    const report = await reconcilePiOAuthStores(acmePi(), { write: true });
    const codex = report.entries.find((entry) => entry.provider === "openai-codex");
    expect(codex?.status).toBe("rewrote-native");
    const codexStore = await readMaybe(CODEX_FILE());
    expect(codexStore?.account_id).toBe("acct-keep");
    expect(codexStore?.last_refresh).toBe(new Date(1_710_000_000 * 1000).toISOString());
    const tokens = codexStore?.tokens as Record<string, unknown>;
    expect(String(tokens.access_token)).toContain("eyJ");
    expect(tokens.refresh_token).toBe("codex-pi-refresh");
  });

  test("the anthropic write-through preserves claude's unknown keys", async () => {
    await seedStores();
    await reconcilePiOAuthStores(acmePi(), { write: true });
    const claude = await readMaybe(CLAUDE_FILE());
    const auth = claude?.claudeAiOauth as Record<string, unknown>;
    expect(auth.refreshTokenExpiresAt).toBe(1_999_000_000_000);
    expect(auth.scopes).toEqual(["user:inference"]);
    expect(claude?.mcpOAuth).toMatchObject({ server: { accessToken: "keep-me" } });
  });

  test("the xai write-through targets the matching account entry and leaves siblings untouched", async () => {
    await seedStores({ piCodexIat: 1_710_000_000, nativeCodexIat: 1_700_000_400 });
    await reconcilePiOAuthStores(acmePi(), { write: true });
    const grok = await readMaybe(GROK_FILE());
    const matched = grok?.["https://auth.x.ai::account-one"] as Record<string, unknown>;
    const sibling = grok?.["https://auth.x.ai::account-two"] as Record<string, unknown>;
    expect(matched.refresh_token).toBe("grok-ref");
    expect(matched.email).toBe("one@example.com");
    expect(typeof matched.expires_at).toBe("string");
    expect(sibling.refresh_token).toBe("grok-2-ref");
    expect(sibling.email).toBe("two@example.com");
  });

  test("is idempotent: the second run finds everything in sync and writes nothing", async () => {
    await seedStores();
    await reconcilePiOAuthStores(acmePi(), { write: true });
    const piBefore = await readFile(PI_AUTH(), "utf8");
    const claudeBefore = await readFile(CLAUDE_FILE(), "utf8");
    const second = await reconcilePiOAuthStores(acmePi(), { write: true });
    expect(second.healed).toBe(0);
    for (const entry of second.entries) expect(entry.status).toBe("in-sync");
    expect(await readFile(PI_AUTH(), "utf8")).toBe(piBefore);
    expect(await readFile(CLAUDE_FILE(), "utf8")).toBe(claudeBefore);
  });

  test("leaves a 0600 backup beside each rewritten native store", async () => {
    await seedStores({ piCodexIat: 1_710_000_000, nativeCodexIat: 1_700_000_400 });
    await reconcilePiOAuthStores(acmePi(), { write: true });
    const backup = JSON.parse(await readFile(`${CODEX_FILE()}.ais-bak`, "utf8"));
    expect(backup.tokens.refresh_token).toBe("codex-ref");
  });
});

describe("reconcilePiOAuthStores (degenerate shapes)", () => {
  test("a missing native FILE is a single-copy pair, never a rewrite", async () => {
    await seedStores();
    await rm(CLAUDE_FILE());
    const report = await reconcilePiOAuthStores(acmePi(), { write: true });
    const anthropic = report.entries.find((entry) => entry.provider === "anthropic");
    expect(anthropic?.status).toBe("single-copy");
    const pi = await readMaybe(PI_AUTH());
    expect((pi?.["anthropic"] as Record<string, unknown>).access).toBe("claude-pi-access");
  });

  test("a logged-out native store (empty tokens) counts as no copy", async () => {
    await seedStores();
    await json(CLAUDE_FILE(), { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } });
    const report = await reconcilePiOAuthStores(acmePi(), { write: true });
    const anthropic = report.entries.find((entry) => entry.provider === "anthropic");
    expect(anthropic?.status).toBe("single-copy");
  });

  test("providers with no native counterpart identity are simply absent", async () => {
    await seedStores();
    await rm(CODEX_CONFIG.identitiesJsonPath);
    const report = await reconcilePiOAuthStores(acmePi(), { write: true });
    expect(report.entries.map((entry) => entry.provider)).not.toContain("openai-codex");
  });
});

describe("renderOAuthReconcileReport", () => {
  test("names fingerprints and remediation without ever printing a token", async () => {
    await seedStores();
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    const lines = renderOAuthReconcileReport(report);
    const joined = lines.join("\n");
    expect(joined).toContain("DIVERGED");
    expect(joined).toMatch(/native [0-9a-f]{8}/);
    expect(joined).toContain("freshest = native");
    expect(joined).not.toContain("claude-ref");
    expect(joined).not.toContain("codex-pi-refresh");
  });
});

describe("reconcilePiConfigDirOnLaunch", () => {
  test("heals a diverged identity on launch and says so on stderr", async () => {
    await seedStores();
    const warnings: string[] = [];
    await reconcilePiConfigDirOnLaunch(dirs.pi, { warn: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("anthropic");
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    expect(report.entries.every((entry) => entry.status !== "forked")).toBe(true);
  });

  test("stays silent when everything is already in sync", async () => {
    await seedStores();
    await reconcilePiOAuthStores(acmePi(), { write: true });
    const warnings: string[] = [];
    await reconcilePiConfigDirOnLaunch(dirs.pi, { warn: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(0);
  });

  test("an unregistered configDir (bare env override) is skipped silently", async () => {
    await seedStores();
    const warnings: string[] = [];
    await reconcilePiConfigDirOnLaunch("/tmp/not-a-registered-pi-identity", { warn: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(0);
    const report = await reconcilePiOAuthStores(acmePi(), { write: false });
    expect(report.entries.some((entry) => entry.status === "forked")).toBe(true);
  });
});
