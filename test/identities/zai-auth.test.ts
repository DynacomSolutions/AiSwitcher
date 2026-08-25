import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZaiApiKey, writeZaiAuthFile } from "../../src/identities/zai-auth.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-zai-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("writeZaiAuthFile", () => {
  test("writes a crush.json with a fully self-contained zai provider entry, mode 0600", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-test-key");

    const authPath = join(configDir, "crush.json");
    const contents = await Bun.file(authPath).json();
    expect(contents.providers.zai.type).toBe("openai-compat");
    expect(contents.providers.zai.base_url).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(contents.providers.zai.api_key).toBe("sk-test-key");
    expect(contents.providers.zai.discover_models).toBe(true);
    expect(Array.isArray(contents.providers.zai.models)).toBe(true);
    expect(contents.providers.zai.models.length).toBeGreaterThan(0);
    expect(contents.providers.zai.models.map((m: { id: string }) => m.id)).toContain("glm-4.6");

    // disable_default_providers is what actually restricts Crush's model
    // picker/`crush models` output to just GLM — confirmed live, see
    // zai-auth.ts's own comment for why this can't be skipped.
    expect(contents.options.disable_default_providers).toBe(true);

    const mode = (await stat(authPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("creates the configDir if it doesn't exist yet", async () => {
    const parent = await makeConfigDir();
    const configDir = join(parent, "not-yet-created");
    await writeZaiAuthFile(configDir, "sk-test-key");
    expect(await Bun.file(join(configDir, "crush.json")).exists()).toBe(true);
  });

  test("preserves other providers/settings already in crush.json (read-modify-write, not overwrite)", async () => {
    const configDir = await makeConfigDir();
    await writeFile(
      join(configDir, "crush.json"),
      JSON.stringify({ providers: { openai: { id: "openai", api_key: "sk-openai" } }, options: { theme: "dark" } }),
    );

    await writeZaiAuthFile(configDir, "sk-zai-key");

    const contents = await Bun.file(join(configDir, "crush.json")).json();
    expect(contents.providers.openai).toEqual({ id: "openai", api_key: "sk-openai" });
    expect(contents.providers.zai.api_key).toBe("sk-zai-key");
    expect(contents.options).toEqual({ theme: "dark", disable_default_providers: true });
  });

  test("rotating the key overwrites only the previous zai entry", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-old-key");
    await writeZaiAuthFile(configDir, "sk-new-key");

    const contents = await Bun.file(join(configDir, "crush.json")).json();
    expect(contents.providers.zai.api_key).toBe("sk-new-key");
  });
});

describe("readZaiApiKey", () => {
  test("reads back the key writeZaiAuthFile wrote", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-round-trip");
    expect(await readZaiApiKey(configDir)).toBe("sk-round-trip");
  });

  test("returns undefined when crush.json doesn't exist yet", async () => {
    const configDir = await makeConfigDir();
    expect(await readZaiApiKey(configDir)).toBeUndefined();
  });

  test("returns undefined for an env-var-reference-style value (not a literal key)", async () => {
    const configDir = await makeConfigDir();
    await writeFile(
      join(configDir, "crush.json"),
      JSON.stringify({ providers: { zai: { api_key: "$ZAI_API_KEY" } } }),
    );
    expect(await readZaiApiKey(configDir)).toBeUndefined();
  });

  test("returns undefined when crush.json has no zai provider at all", async () => {
    const configDir = await makeConfigDir();
    await writeFile(join(configDir, "crush.json"), JSON.stringify({ providers: { openai: { api_key: "sk-openai" } } }));
    expect(await readZaiApiKey(configDir)).toBeUndefined();
  });
});
