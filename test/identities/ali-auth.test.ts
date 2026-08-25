import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAliApiKey, writeAliAuthFile } from "../../src/identities/ali-auth.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-ali-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("writeAliAuthFile", () => {
  test("writes a crush.json with a fully self-contained alibaba provider entry, mode 0600", async () => {
    const configDir = await makeConfigDir();
    await writeAliAuthFile(configDir, "sk-test-key");

    const authPath = join(configDir, "crush.json");
    const contents = await Bun.file(authPath).json();
    expect(contents.providers.alibaba.type).toBe("anthropic");
    expect(contents.providers.alibaba.base_url).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    );
    expect(contents.providers.alibaba.api_key).toBe("sk-test-key");
    expect(Array.isArray(contents.providers.alibaba.models)).toBe(true);
    expect(contents.providers.alibaba.models.length).toBe(8);
    expect(contents.providers.alibaba.models.map((m: { id: string }) => m.id)).toContain("qwen3.8-max");

    // Alibaba's Token plan endpoint has no model-list endpoint at all (only
    // /v1/messages), so discover_models must be omitted entirely, unlike zai's
    // entry, which sets it to true. Live discovery would simply fail here.
    expect(contents.providers.alibaba.discover_models).toBeUndefined();

    // disable_default_providers is what actually restricts Crush's model
    // picker/`crush models` output to just Alibaba's models, same
    // requirement as zai's entry, see ali-auth.ts's own comment.
    expect(contents.options.disable_default_providers).toBe(true);

    const mode = (await stat(authPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("creates the configDir if it doesn't exist yet", async () => {
    const parent = await makeConfigDir();
    const configDir = join(parent, "not-yet-created");
    await writeAliAuthFile(configDir, "sk-test-key");
    expect(await Bun.file(join(configDir, "crush.json")).exists()).toBe(true);
  });

  test("preserves other providers/settings already in crush.json (read-modify-write, not overwrite)", async () => {
    const configDir = await makeConfigDir();
    await writeFile(
      join(configDir, "crush.json"),
      JSON.stringify({ providers: { openai: { id: "openai", api_key: "sk-openai" } }, options: { theme: "dark" } }),
    );

    await writeAliAuthFile(configDir, "sk-alibaba-key");

    const contents = await Bun.file(join(configDir, "crush.json")).json();
    expect(contents.providers.openai).toEqual({ id: "openai", api_key: "sk-openai" });
    expect(contents.providers.alibaba.api_key).toBe("sk-alibaba-key");
    expect(contents.options).toEqual({ theme: "dark", disable_default_providers: true });
  });

  test("rotating the key overwrites only the previous alibaba entry", async () => {
    const configDir = await makeConfigDir();
    await writeAliAuthFile(configDir, "sk-old-key");
    await writeAliAuthFile(configDir, "sk-new-key");

    const contents = await Bun.file(join(configDir, "crush.json")).json();
    expect(contents.providers.alibaba.api_key).toBe("sk-new-key");
  });
});

describe("readAliApiKey", () => {
  test("reads back the key writeAliAuthFile wrote", async () => {
    const configDir = await makeConfigDir();
    await writeAliAuthFile(configDir, "sk-round-trip");
    expect(await readAliApiKey(configDir)).toBe("sk-round-trip");
  });

  test("returns undefined when crush.json doesn't exist yet", async () => {
    const configDir = await makeConfigDir();
    expect(await readAliApiKey(configDir)).toBeUndefined();
  });

  test("returns undefined for an env-var-reference-style value (not a literal key)", async () => {
    const configDir = await makeConfigDir();
    await writeFile(
      join(configDir, "crush.json"),
      JSON.stringify({ providers: { alibaba: { api_key: "$ALI_API_KEY" } } }),
    );
    expect(await readAliApiKey(configDir)).toBeUndefined();
  });

  test("returns undefined when crush.json has no alibaba provider at all", async () => {
    const configDir = await makeConfigDir();
    await writeFile(join(configDir, "crush.json"), JSON.stringify({ providers: { openai: { api_key: "sk-openai" } } }));
    expect(await readAliApiKey(configDir)).toBeUndefined();
  });
});
