import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { runT3ModelsCommand } from "../../src/cli/gateway/t3-models.ts";
import type { GatewayCliDeps } from "../../src/cli/gateway/apps.ts";
import { kimiCapabilities, parseGatewayModels, syncT3GatewayModels, transformKimiConfig } from "../../src/identities/t3-gateway-models.ts";
import { createT3ModelsTicker } from "../../src/sync/t3-models-ticker.ts";

const root = await mkdtemp(join(tmpdir(), "ais-t3models-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const KIMI_KEY = "aisg_SYNTHETIC_FIXTURE_kimi";
const OC_KEY = "aisg_SYNTHETIC_FIXTURE_opencode";

const kimiModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  display_name: id.toUpperCase(),
  context_length: 262144,
  supports_reasoning: true,
  supports_thinking_type: "only",
  supports_dynamic_tools: true,
  modalities: { input: ["text", "image", "video"], output: ["text"] },
  ...extra,
});

const kimiConfig = (models: string[]) =>
  [
    "# hand-written",
    'default_model = "old-a"',
    "",
    "[providers.gateway]",
    'type = "kimi"',
    'base_url = "https://gw.example.test/gateway/t3-kimi/v1"',
    `api_key = "${KIMI_KEY}"`,
    "",
    "[loop_control]",
    "max_steps_per_turn = 100",
    "",
    ...models.flatMap((id) => [`[models."${id}"]`, 'provider = "gateway"', `model = "${id}"`, `display_name = "${id}"`, "max_context_size = 1000", 'capabilities = ["thinking"]', 'custom_key = "kept"', ""]),
    '[models."local"]',
    'provider = "other"',
    'model = "local"',
    "",
  ].join("\n");

type Route = { status?: number; body: unknown };
function fakeFetch(routes: Record<string, Route>, seen: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url, headers });
    const r = routes[url];
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

let n = 0;
async function home(): Promise<{ home: string; gw: string }> {
  const h = join(root, `h${n++}`);
  const gw = join(h, ".t3", "gateway");
  await mkdir(gw, { recursive: true });
  return { home: h, gw };
}

test("parseGatewayModels: kimi shape to capabilities", () => {
  const [m] = parseGatewayModels({ data: [kimiModel("k3")] });
  expect(m).toMatchObject({ id: "k3", displayName: "K3", contextLength: 262144, alwaysThinking: true, dynamicTools: true });
  expect(kimiCapabilities(m!)).toEqual(["image_in", "video_in", "always_thinking", "dynamically_loaded_tools"]);
  const [plain] = parseGatewayModels({ data: [{ id: "x", supports_reasoning: true, modalities: { input: ["text"] } }] });
  expect(kimiCapabilities(plain!)).toEqual(["thinking"]);
  expect(() => parseGatewayModels({ nope: 1 })).toThrow();
});

test("transformKimiConfig: replaces only the provider's blocks, keeps every other key, idempotent", () => {
  const before = kimiConfig(["old-a", "keep-b"]);
  const models = parseGatewayModels({ data: [kimiModel("keep-b"), kimiModel("k3.1-pro")] });
  const after = transformKimiConfig(before, "gateway", models);
  const parsed = parseToml(after) as Record<string, any>;
  expect(Object.keys(parsed.models).sort()).toEqual(["k3.1-pro", "keep-b", "local"]);
  expect(parsed.models["keep-b"]).toEqual({
    provider: "gateway",
    model: "keep-b",
    display_name: "KEEP-B",
    max_context_size: 262144,
    capabilities: ["image_in", "video_in", "always_thinking", "dynamically_loaded_tools"],
    custom_key: "kept",
  });
  expect(parsed.models["k3.1-pro"].custom_key).toBeUndefined();
  expect(parsed.models.local).toEqual({ provider: "other", model: "local" });
  expect(parsed.providers.gateway.api_key).toBe(KIMI_KEY);
  expect(parsed.loop_control.max_steps_per_turn).toBe(100);
  expect(parsed.default_model).toBe("keep-b"); // old-a is gone
  expect(after).toContain("# hand-written");
  expect(transformKimiConfig(after, "gateway", models)).toBe(after);
});

test("transformKimiConfig: same content in other formatting is left untouched", () => {
  const models = parseGatewayModels({ data: [kimiModel("a")] });
  const once = transformKimiConfig(kimiConfig([]), "gateway", models);
  const reformatted = once.replace('capabilities = [ "image_in"', 'capabilities = ["image_in"').replace(/" \]/g, '"]');
  expect(reformatted).not.toBe(once);
  expect(transformKimiConfig(reformatted, "gateway", models)).toBe(reformatted);
});

test("sync: kimi and opencode folders follow the gateway; mode kept; key never sent elsewhere", async () => {
  const { home: h, gw } = await home();
  await mkdir(join(gw, "t3-kimi-x"));
  const kimiFile = join(gw, "t3-kimi-x", "config.toml");
  await writeFile(kimiFile, kimiConfig(["old-a"]));
  await chmod(kimiFile, 0o600);
  await mkdir(join(gw, "t3-opencode-x"));
  await writeFile(join(gw, "t3-opencode-x", "token"), `${OC_KEY}\n`);
  const ocFile = join(gw, "t3-opencode-x", "opencode.json");
  await writeFile(
    ocFile,
    JSON.stringify({
      $schema: "https://opencode.example.test/config.json",
      permission: { "*": "allow" },
      provider: {
        gateway: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://gw.example.test/gateway/t3-opencode", apiKey: "{file:./token}", headers: { "x-opencode-session": "t3-opencode-x" } },
          models: { "gone-1": { name: "Gone" }, "stay-2": { name: "Old name", limit: { context: 5 } } },
        },
      },
    }),
  );
  await mkdir(join(gw, "t3-claude-x")); // no model list: ignored
  await writeFile(join(gw, "t3-claude-x", "settings.json"), "{}");

  const seen: { url: string; headers: Record<string, string> }[] = [];
  const doFetch = fakeFetch(
    {
      "https://gw.example.test/gateway/t3-kimi/v1/models": { body: { data: [kimiModel("k3"), kimiModel("k3-256k")] } },
      "https://gw.example.test/gateway/t3-opencode/models": { body: { object: "list", data: [{ id: "stay-2", name: "Stay Two" }, { id: "new-3" }] } },
    },
    seen,
  );
  const results = await syncT3GatewayModels({ home: h, env: {}, fetch: doFetch });
  expect(results.map((r) => [r.provider, r.status])).toEqual([
    ["gateway", "updated"],
    ["gateway", "updated"],
  ]);

  const kimi = parseToml(await readFile(kimiFile, "utf8")) as Record<string, any>;
  expect(Object.keys(kimi.models).filter((id) => kimi.models[id].provider === "gateway")).toEqual(["k3", "k3-256k"]);
  expect((await stat(kimiFile)).mode & 0o777).toBe(0o600);

  const oc = JSON.parse(await readFile(ocFile, "utf8"));
  expect(oc.provider.gateway.models).toEqual({ "stay-2": { name: "Stay Two", limit: { context: 5 } }, "new-3": { name: "new-3" } });
  expect(oc.provider.gateway.options.apiKey).toBe("{file:./token}");
  expect(oc.permission).toEqual({ "*": "allow" });

  const byUrl = Object.fromEntries(seen.map((s) => [s.url, s.headers]));
  expect(byUrl["https://gw.example.test/gateway/t3-kimi/v1/models"]!.authorization).toBe(`Bearer ${KIMI_KEY}`);
  expect(byUrl["https://gw.example.test/gateway/t3-opencode/models"]!.authorization).toBe(`Bearer ${OC_KEY}`);
  expect(byUrl["https://gw.example.test/gateway/t3-opencode/models"]!["x-opencode-session"]).toBe("t3-opencode-x");

  const again = await syncT3GatewayModels({ home: h, env: {}, fetch: doFetch });
  expect(again.every((r) => r.status === "current")).toBe(true);
});

test("sync: a failing or empty list leaves the file as it is", async () => {
  const { home: h, gw } = await home();
  await mkdir(join(gw, "t3-kimi-y"));
  const file = join(gw, "t3-kimi-y", "config.toml");
  const text = kimiConfig(["old-a"]);
  await writeFile(file, text);
  const url = "https://gw.example.test/gateway/t3-kimi/v1/models";
  for (const route of [{ status: 401, body: { error: { code: "api_key_expired" } } }, { body: { data: [] } }]) {
    const [r] = await syncT3GatewayModels({ home: h, env: {}, fetch: fakeFetch({ [url]: route }) });
    expect(r!.status).toBe("failed");
    expect(await readFile(file, "utf8")).toBe(text);
  }
  const [r] = await syncT3GatewayModels({ home: h, env: {}, fetch: fakeFetch({ [url]: { status: 401, body: { error: { code: "api_key_expired" } } } }) });
  expect(r!.error).toContain("api_key_expired");
  expect(r!.error).not.toContain(KIMI_KEY);
});

test("ais gateway t3-models --check writes nothing and fails when out of date", async () => {
  const { home: h, gw } = await home();
  await mkdir(join(gw, "t3-kimi-z"));
  const file = join(gw, "t3-kimi-z", "config.toml");
  const text = kimiConfig(["old-a"]);
  await writeFile(file, text);
  const lines: string[] = [];
  const deps = { fetch: fakeFetch({ "https://gw.example.test/gateway/t3-kimi/v1/models": { body: { data: [kimiModel("k3")] } } }), out: (l: string) => lines.push(l) } as unknown as GatewayCliDeps;
  await expect(runT3ModelsCommand([], { check: true }, deps, { home: h, env: {} })).rejects.toThrow("1 out of date");
  expect(await readFile(file, "utf8")).toBe(text);
  expect(lines.join("\n")).toContain("out of date (1 models; +k3 -old-a)");
  expect(lines.join("\n")).not.toContain(KIMI_KEY);
  await runT3ModelsCommand([], {}, deps, { home: h, env: {} });
  await runT3ModelsCommand([], { check: true }, deps, { home: h, env: {} });
});

test("ticker: first tick runs, then waits the interval; one pass at a time; repeated failures logged once", async () => {
  let t = 0;
  let calls = 0;
  const logs: string[] = [];
  const failed = { dir: "/d", file: "/d/config.toml", provider: "gateway", status: "failed" as const, fileIds: [], error: "HTTP 401" };
  const ticker = createT3ModelsTicker({ now: () => t, log: (m) => logs.push(m), intervalMs: 1000, sync: async () => (calls++, [failed]) });
  await ticker.tick();
  await ticker.tick();
  await ticker.idle();
  expect(calls).toBe(1);
  t = 1000;
  await ticker.tick();
  await ticker.idle();
  expect(calls).toBe(2);
  expect(logs.length).toBe(1);
});
