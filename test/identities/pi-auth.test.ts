import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importPiCredentials } from "../../src/identities/pi-auth.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ais-pi-auth-test."));
  roots.push(root);
  return root;
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("importPiCredentials", () => {
  test("merges all AIS provider credentials and OpenCode Go without discarding existing Pi auth", async () => {
    const root = await temporaryRoot();
    const pi = join(root, "pi");
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const grok = join(root, "grok");
    const kimi = join(root, "kimi");
    const zai = join(root, "zai");
    const ali = join(root, "ali");

    await json(join(pi, "auth.json"), { existing: { type: "api_key", key: "keep-me" } });
    await json(join(pi, "models.json"), { providers: { existing: { baseUrl: "http://localhost" } } });
    await json(join(claude, ".credentials.json"), {
      claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh", expiresAt: 2_000_000_000_000 },
    });
    await json(join(codex, "auth.json"), {
      tokens: { access_token: "codex-access", refresh_token: "codex-refresh" },
    });
    await json(join(grok, "auth.json"), {
      account: { key: "grok-access", refresh_token: "grok-refresh", expires_at: 2_000_000_000 },
    });
    await json(join(kimi, "credentials", "kimi-code.json"), {
      access_token: "kimi-access", refresh_token: "kimi-refresh", expires_at: 2_000_000_000_000,
    });
    await json(join(zai, "crush.json"), { providers: { zai: { api_key: "zai-plan-key" } } });
    await json(join(ali, "crush.json"), {
      providers: {
        alibaba: {
          api_key: "ali-plan-key",
          base_url: "https://token-plan.example/apps/anthropic",
          models: [{ id: "qwen-test", name: "Qwen Test", can_reason: true, context_window: 131072 }],
        },
      },
    });

    const result = await importPiCredentials(pi, {
      claude,
      codex,
      grok,
      kimi,
      zai,
      ali,
      opencodeGoApiKey: "opencode-go-key",
    });
    expect(result.providers).toEqual([
      "anthropic",
      "openai-codex",
      "xai",
      "kimi-coding",
      "zai",
      "alibaba-plan",
      "opencode-go",
    ]);

    const auth = await Bun.file(join(pi, "auth.json")).json();
    expect(auth.existing.key).toBe("keep-me");
    expect(auth.anthropic).toMatchObject({ type: "oauth", access: "claude-access", refresh: "claude-refresh" });
    expect(auth["openai-codex"]).toMatchObject({ type: "oauth", access: "codex-access" });
    expect(auth.xai).toMatchObject({ type: "oauth", access: "grok-access", expires: 2_000_000_000_000 });
    expect(auth["kimi-coding"]).toMatchObject({ type: "oauth", access: "kimi-access" });
    expect(auth.zai).toEqual({ type: "api_key", key: "zai-plan-key" });
    expect(auth["alibaba-plan"]).toEqual({ type: "api_key", key: "ali-plan-key" });
    expect(auth["opencode-go"]).toEqual({ type: "api_key", key: "opencode-go-key" });

    const models = await Bun.file(join(pi, "models.json")).json();
    expect(models.providers.existing.baseUrl).toBe("http://localhost");
    expect(models.providers["alibaba-plan"]).toMatchObject({
      baseUrl: "https://token-plan.example/apps/anthropic",
      api: "anthropic-messages",
      authHeader: true,
    });
    expect(models.providers["alibaba-plan"].models[0]).toMatchObject({
      id: "qwen-test",
      reasoning: true,
      contextWindow: 131072,
    });
    expect((await stat(join(pi, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(pi, "models.json"))).mode & 0o777).toBe(0o600);
  });

  test("rejects an import with no selected credential sources", async () => {
    const root = await temporaryRoot();
    await expect(importPiCredentials(join(root, "pi"), {})).rejects.toThrow("No Pi credential sources");
  });
});
