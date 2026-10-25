import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchOpencodeLimits,
  fetchableOpencodeProviders,
  pendingOpencodeProviders,
  windowsFromOpencodeGoUsage,
  type OpencodeAuthFile,
} from "../../../src/cli/limits/opencode-limits.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeIdentity(auth: OpencodeAuthFile | undefined): Promise<Identity> {
  const dir = await mkdtemp(join(tmpdir(), "ais-opencode-limits-test-"));
  tempDirs.push(dir);
  if (auth !== undefined) {
    // OpenCode's auth lives under its XDG data root, redirected one level
    // into the identity's data/ directory (see OPENCODE_CONFIG).
    await mkdir(join(dir, "data", "opencode"), { recursive: true });
    await writeFile(join(dir, "data", "opencode", "auth.json"), JSON.stringify(auth));
  }
  return { name: "acme", label: "Acme", configDir: dir };
}

interface V2CredentialFixtureRow {
  id: string;
  integrationId: string;
  value: unknown;
  active: number | null;
  timeUpdated: number;
}

/** Writes a v2 credential store (data/opencode/opencode.db, table
 * `credential`, live 2026-10 schema) into the identity's data root. */
async function writeV2CredentialRows(identity: Identity, rows: V2CredentialFixtureRow[]): Promise<void> {
  await mkdir(join(identity.configDir, "data", "opencode"), { recursive: true });
  const db = new Database(join(identity.configDir, "data", "opencode", "opencode.db"));
  db.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
  );
  for (const row of rows) {
    db.run("INSERT INTO credential (id, integration_id, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)", [
      row.id,
      row.integrationId,
      JSON.stringify(row.value),
      row.active,
      row.timeUpdated,
      row.timeUpdated,
    ]);
  }
  db.close();
}

describe("fetchableOpencodeProviders", () => {
  test("keeps providers with a usable key, dropping native-covered and unknown ones", () => {
    // Hyphenated ids are what OpenCode actually writes on disk (confirmed
    // live 2026-09-03); the underscore spellings appear in tokscale output
    // and are aliased separately in usage/providers.ts.
    const auth: OpencodeAuthFile = {
      "zai-coding-plan": { type: "api", key: "zai-key" },
      "opencode-go": { type: "api", key: "go-key" },
      "alibaba-token-plan": { type: "api", key: "ali-key" },
      "some-future-provider": { type: "api", key: "k" },
      empty_key: { type: "api" },
    };
    // alibaba is native-covered (ali's console-cookie fetch is the only
    // path to its quota), unknown ids are never guessed at, and a keyless
    // entry has nothing to fetch with. zai and opencode-go both have live
    // quota endpoints.
    expect(fetchableOpencodeProviders(auth)).toEqual([
      { provider: "zai", entry: { type: "api", key: "zai-key" } },
      { provider: "opencode-go", entry: { type: "api", key: "go-key" } },
    ]);
  });
});

describe("windowsFromOpencodeGoUsage", () => {
  test("maps the live wire shape (captured mid-weekly-limit) to session/week/month windows", () => {
    // Verbatim shape confirmed live 2026-09-03 against the user's own Go
    // plan while the weekly window was exhausted.
    const windows = windowsFromOpencodeGoUsage({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-09-03T22:08:19.829Z" },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-07T00:00:00.829Z" },
        monthly: { status: "ok", percent: 53, resetsAt: "2026-09-24T08:39:02.829Z" },
      },
    });
    expect(windows).toHaveLength(3);
    const [session, week, month] = windows;
    expect(session).toMatchObject({ label: "session (5h)", category: "session", usedPercent: 0 });
    expect(session!.resetsAt).toBeTruthy();
    expect(week).toMatchObject({ label: "week", category: "week", usedPercent: 100, note: "rate-limited" });
    expect(week!.resetsAt).toBeTruthy();
    expect(month).toMatchObject({ label: "month", category: "month", usedPercent: 53 });
  });

  test("an empty usage block yields no windows rather than fabricated ones", () => {
    expect(windowsFromOpencodeGoUsage({})).toEqual([]);
    expect(windowsFromOpencodeGoUsage({ usage: {} })).toEqual([]);
  });
});

describe("fetchOpencodeLimits", () => {
  test("with no readable auth.json, an unscoped report contributes nothing; an explicit --tool=opencode query gets an honest row", async () => {
    const identity = await makeIdentity(undefined);
    expect(await fetchOpencodeLimits(identity)).toEqual([]);
    const explicit = await fetchOpencodeLimits(identity, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.provider).toBe("unattributed");
    expect(explicit[0]!.error).toContain("no readable OpenCode auth.json");
  });

  test("with only native-covered providers, an unscoped report contributes nothing; explicit still answers", async () => {
    const identity = await makeIdentity({
      alibaba_token_plan: { type: "api", key: "ali-key" },
    });
    expect(await fetchOpencodeLimits(identity)).toEqual([]);
    const explicit = await fetchOpencodeLimits(identity, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.error).toContain("no fetchable OpenCode providers");
  });

  test("a fresh OpenCode v2 credential (opencode.db) overrides the stale legacy auth.json key", async () => {
    // OpenCode v2 migrates legacy auth.json credentials once, then writes
    // new/updated credentials to data/opencode/opencode.db table
    // `credential`; auth.json keeps the STALE key, which is the live 401
    // this regression test pins (2026-10-25). The v2 Console login lands as
    // integration_id `opencode` (the Go plan's v2 id) with an OAuth value.
    const identity = await makeIdentity({
      "opencode-go": { type: "api", key: "SYNTHETIC_FIXTURE-stale-legacy-opencode-go-key" },
    });
    // The explicitly inactive row must never be used, even with a newer
    // timestamp.
    await writeV2CredentialRows(identity, [
      {
        id: "cred-SYNTHETIC_FIXTURE-v2-opencode",
        integrationId: "opencode",
        value: {
          type: "oauth",
          access: "SYNTHETIC_FIXTURE-fresh-v2-opencode-access",
          refresh: "SYNTHETIC_FIXTURE-fresh-v2-opencode-refresh",
          expires: 1893456000000,
        },
        active: 1,
        timeUpdated: 1761000000000,
      },
      {
        id: "cred-SYNTHETIC_FIXTURE-v2-inactive",
        integrationId: "opencode",
        value: { type: "oauth", access: "SYNTHETIC_FIXTURE-disabled-v2-opencode-access" },
        active: 0,
        timeUpdated: 1761000000001,
      },
    ]);

    const realFetch = globalThis.fetch;
    const authorizations: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authorizations.push(String(headers.Authorization ?? ""));
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 5, resetsAt: "2026-10-25T20:00:00.000Z" },
            weekly: { status: "ok", percent: 42, resetsAt: "2026-10-26T00:00:00.000Z" },
            monthly: { status: "ok", percent: 17, resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const results = await fetchOpencodeLimits(identity, true);
      expect(results).toHaveLength(1);
      expect(results[0]!.provider).toBe("opencode-go");
      expect(results[0]!.status).toBe("live");
      expect(authorizations).toEqual(["Bearer SYNTHETIC_FIXTURE-fresh-v2-opencode-access"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a readable v2 db holding only a native-covered provider reports no fetchable providers, not an unreadable store", async () => {
    // The store WAS read fine; it just has nothing this adapter can fetch
    // (alibaba's quota comes from the ali tool's console-cookie path).
    const identity = await makeIdentity(undefined);
    await writeV2CredentialRows(identity, [
      {
        id: "cred-SYNTHETIC_FIXTURE-v2-alibaba",
        integrationId: "alibaba-token-plan",
        value: { type: "key", key: "SYNTHETIC_FIXTURE-v2-alibaba-key" },
        active: 1,
        timeUpdated: 1761000000000,
      },
    ]);
    expect(await fetchOpencodeLimits(identity)).toEqual([]);
    const explicit = await fetchOpencodeLimits(identity, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.error).toContain("no fetchable OpenCode providers");
  });

  test("a null-active imported v2 row is usable and seeds the pending provider list without any auth.json", async () => {
    const identity = await makeIdentity(undefined);
    await writeV2CredentialRows(identity, [
      {
        id: "cred-SYNTHETIC_FIXTURE-v2-imported",
        integrationId: "opencode",
        value: { type: "oauth", access: "SYNTHETIC_FIXTURE-imported-v2-opencode-access" },
        active: null,
        timeUpdated: 1761000000000,
      },
    ]);
    expect(await pendingOpencodeProviders(identity)).toEqual(["opencode-go"]);
  });
});
