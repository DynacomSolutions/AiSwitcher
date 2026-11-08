import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshIdentityOAuthGrant } from "../../src/identities/oauth-refresh.ts";
import { CLAUDE_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity } from "../../src/identities/types.ts";

// Temp registries and stores only; token values are short synthetic strings.
const NAME = "acme";
const saved: Record<string, string> = {};
let root = "";
let claudeDir = "";
let piDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-claude-read-error-"));
  claudeDir = join(root, "claude", NAME);
  piDir = join(root, "pi", NAME);
  await mkdir(claudeDir, { recursive: true });
  await mkdir(piDir, { recursive: true });
  for (const [tool, cfg, dir] of [["claude", CLAUDE_CONFIG, claudeDir], ["pi", PI_CONFIG, piDir]] as const) {
    saved[tool] = cfg.identitiesJsonPath;
    (cfg as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}.json`);
    await writeFile(cfg.identitiesJsonPath, JSON.stringify({ version: 1, identities: [{ name: NAME, label: "Acme", configDir: dir }] }));
  }
});

afterEach(async () => {
  (CLAUDE_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.claude!;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi!;
  await rm(root, { recursive: true, force: true });
});

test("a torn native store beside a pi grant skips the refresh: readError, no POST, stores untouched", async () => {
  const native = join(claudeDir, ".credentials.json");
  await writeFile(native, "{ torn");
  const piAuth = JSON.stringify({ anthropic: { type: "oauth", access: "at-pi", refresh: "rt-other", expires: Date.now() - 3600_000 } });
  await writeFile(join(piDir, "auth.json"), piAuth);
  let posts = 0;
  const fetchImpl = (async () => {
    posts += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const identity: Identity = { name: NAME, label: "Acme", configDir: claudeDir };
  for (const force of [true, false]) {
    const result = await refreshIdentityOAuthGrant("claude", identity, { force, fetchImpl });
    expect(result.outcome).toBe("skipped-read-error");
    expect(result.readError).toBe(true);
  }
  expect(posts).toBe(0);
  expect(await Bun.file(native).text()).toBe("{ torn");
  expect(await Bun.file(join(piDir, "auth.json")).text()).toBe(piAuth);
});
