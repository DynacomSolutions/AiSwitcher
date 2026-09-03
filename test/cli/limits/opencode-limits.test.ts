import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchOpencodeLimits,
  fetchableOpencodeProviders,
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

describe("fetchableOpencodeProviders", () => {
  test("keeps only providers with a usable key, dropping native-covered and unknown ones", () => {
    // Hyphenated ids are what OpenCode actually writes on disk (confirmed
    // live 2026-09-03); the underscore spellings appear in tokscale output
    // and are aliased separately in usage/providers.ts.
    const auth: OpencodeAuthFile = {
      "zai-coding-plan": { type: "api", key: "zai-key" },
      "alibaba-token-plan": { type: "api", key: "ali-key" },
      "some-future-provider": { type: "api", key: "k" },
      empty_key: { type: "api" },
    };
    // alibaba is native-covered (ali's console-cookie fetch is the only
    // path to its quota), unknown ids are never guessed at, and a keyless
    // entry has nothing to fetch with.
    expect(fetchableOpencodeProviders(auth)).toEqual([
      { provider: "zai", entry: { type: "api", key: "zai-key" } },
    ]);
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
});
