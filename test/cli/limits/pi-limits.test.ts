import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPiLimits, fetchablePiProviders, type PiAuthFile } from "../../../src/cli/limits/pi-limits.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeIdentity(auth: PiAuthFile | undefined): Promise<Identity> {
  const dir = await mkdtemp(join(tmpdir(), "ais-pi-limits-test-"));
  tempDirs.push(dir);
  if (auth !== undefined) {
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
  }
  return { name: "acme", label: "Acme", configDir: dir };
}

describe("fetchablePiProviders", () => {
  test("keeps fetchable providers, drops native-covered and unknown ones", () => {
    const auth: PiAuthFile = {
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 },
      xai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      "alibaba-plan": { type: "api_key", key: "k" },
      zai: { type: "api_key", key: "zai-key" },
      "kimi-coding": { type: "oauth", access: "a", refresh: "r", expires: 1750000000000 },
      "opencode-go": { type: "api_key", key: "go-key" },
      "some-future-provider": { type: "api_key", key: "k" },
    };
    // Native-covered providers get their limits branch from claude/codex/
    // grok/ali instead of a duplicate Pi row; unknown providers are never
    // guessed at; only zai / kimi / opencode-go survive.
    expect(fetchablePiProviders(auth).map(({ provider }) => provider).sort()).toEqual(["kimi", "opencode-go", "zai"]);
  });

  test("drops entries whose credential is not in the shape the fetch needs", () => {
    const auth: PiAuthFile = {
      zai: { type: "api_key" },
      "kimi-coding": { type: "oauth", refresh: "r" },
    };
    expect(fetchablePiProviders(auth)).toEqual([]);
  });
});

describe("fetchPiLimits", () => {
  test("with no readable auth.json, an unscoped report contributes nothing; an explicit --tool=pi query gets an honest row", async () => {
    const identity = await makeIdentity(undefined);
    expect(await fetchPiLimits(identity)).toEqual([]);
    const explicit = await fetchPiLimits(identity, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.provider).toBe("unattributed");
    expect(explicit[0]!.error).toContain("no readable Pi auth.json");
  });

  test("with only native-covered providers, an unscoped report contributes nothing; explicit still answers", async () => {
    const identity = await makeIdentity({
      anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    });
    expect(await fetchPiLimits(identity)).toEqual([]);
    const explicit = await fetchPiLimits(identity, true);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.error).toContain("no fetchable Pi providers");
  });
});
