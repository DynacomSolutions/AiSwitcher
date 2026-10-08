import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeRetiredIdentityCredentials } from "../../src/identities/retire-credentials.ts";
import type { Identity } from "../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function write(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, contents);
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ais-retire-creds-"));
  tempDirs.push(home);
  const piDir = join(home, ".pi", "identities", "old-team");
  await write(
    join(home, ".pi", "identities.json"),
    JSON.stringify({ version: 1, identities: [{ name: "old-team", label: "Pi", configDir: piDir }] }),
  );
  return { home, piDir, piRegistryPath: join(home, ".pi", "identities.json") };
}

function identity(home: string, tool: string): Identity {
  return { name: "old-team", label: "Old", configDir: join(home, `.${tool}`, "identities", "old-team") };
}

const noTimer = async () => false;

describe("purgeRetiredIdentityCredentials", () => {
  const fileCases: Array<[Parameters<typeof purgeRetiredIdentityCredentials>[0]["toolName"], string[]]> = [
    ["claude", [".credentials.json"]],
    ["codex", ["auth.json"]],
    ["grok", ["credentials.json", "auth.json", "auth.toml"]],
    ["kimi", ["credentials/kimi-code.json"]],
    ["pi", ["auth.json"]],
    ["opencode", ["data/opencode/auth.json", "opencode/auth.json"]],
  ];

  for (const [tool, files] of fileCases) {
    test(`removes the ${tool} credential files and leaves logs alone`, async () => {
      const { home, piRegistryPath } = await fixture();
      const id = identity(home, tool);
      for (const file of files) await write(join(id.configDir, file), "secret");
      await write(join(id.configDir, "sessions", "log.jsonl"), "line\n");
      await write(join(id.configDir, "usage.sqlite"), "db");

      const report = await purgeRetiredIdentityCredentials({
        toolName: tool,
        identity: id,
        home,
        piRegistryPath,
        removeAliTimer: noTimer,
      });

      for (const file of files) expect(await Bun.file(join(id.configDir, file)).exists()).toBe(false);
      expect(report.removed).toHaveLength(files.length);
      expect(await Bun.file(join(id.configDir, "sessions", "log.jsonl")).text()).toBe("line\n");
      expect(await Bun.file(join(id.configDir, "usage.sqlite")).exists()).toBe(true);
    });
  }

  test("is idempotent and never throws on missing files", async () => {
    const { home, piRegistryPath } = await fixture();
    const opts = { toolName: "claude" as const, identity: identity(home, "claude"), home, piRegistryPath };
    await write(join(opts.identity.configDir, ".credentials.json"), "secret");
    expect((await purgeRetiredIdentityCredentials(opts)).removed).toHaveLength(1);
    expect((await purgeRetiredIdentityCredentials(opts)).removed).toHaveLength(0);
  });

  test("zai: strips only the api key from crush.json", async () => {
    const { home, piRegistryPath } = await fixture();
    const id = identity(home, "zai");
    const crush = join(id.configDir, "crush.json");
    await write(
      crush,
      JSON.stringify({
        providers: { zai: { type: "openai-compat", api_key: "secret", base_url: "https://example.invalid" }, other: { api_key: "keep" } },
        options: { disable_default_providers: true },
      }),
    );
    const report = await purgeRetiredIdentityCredentials({ toolName: "zai", identity: id, home, piRegistryPath });
    const after = await Bun.file(crush).json();
    expect(after.providers.zai).toEqual({ type: "openai-compat", base_url: "https://example.invalid" });
    expect(after.providers.other.api_key).toBe("keep");
    expect(after.options.disable_default_providers).toBe(true);
    expect(report.removed.join("\n")).not.toContain("secret");
  });

  test("ali: key, console cookie, auth-browser state and timer", async () => {
    const { home, piRegistryPath } = await fixture();
    const id = identity(home, "ali");
    await write(join(id.configDir, "crush.json"), JSON.stringify({ providers: { alibaba: { api_key: "secret", name: "Ali" } } }));
    await write(join(id.configDir, "console-cookie.txt"), "cookie");
    await write(join(home, ".ais", "auth-browser", "old-team.json"), "{}");
    const timers: string[] = [];
    const report = await purgeRetiredIdentityCredentials({
      toolName: "ali",
      identity: id,
      home,
      piRegistryPath,
      removeAliTimer: async (name) => {
        timers.push(name);
        return true;
      },
    });
    expect((await Bun.file(join(id.configDir, "crush.json")).json()).providers.alibaba).toEqual({ name: "Ali" });
    expect(await Bun.file(join(id.configDir, "console-cookie.txt")).exists()).toBe(false);
    expect(await Bun.file(join(home, ".ais", "auth-browser", "old-team.json")).exists()).toBe(false);
    expect(timers).toEqual(["old-team"]);
    expect(report.removed.length).toBe(4);
  });

  test("removes only this provider from the same-named pi identity", async () => {
    const { home, piDir, piRegistryPath } = await fixture();
    await write(
      join(piDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "a" }, "openai-codex": { type: "oauth", access: "b" } }),
    );
    const report = await purgeRetiredIdentityCredentials({
      toolName: "claude",
      identity: identity(home, "claude"),
      home,
      piRegistryPath,
      platform: "linux",
    });
    expect(await Bun.file(join(piDir, "auth.json")).json()).toEqual({ "openai-codex": { type: "oauth", access: "b" } });
    expect(report.removed).toEqual([`${join(piDir, "auth.json")} (anthropic)`]);
    expect(report.warnings).toEqual([]);
  });

  test("claude on darwin warns about the Keychain", async () => {
    const { home, piRegistryPath } = await fixture();
    const report = await purgeRetiredIdentityCredentials({
      toolName: "claude",
      identity: identity(home, "claude"),
      home,
      piRegistryPath,
      platform: "darwin",
    });
    expect(report.warnings.join("\n")).toContain("Keychain");
  });
});
