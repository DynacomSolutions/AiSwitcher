import { expect, test } from "bun:test";
import type { GatewayDeps } from "../../src/gateway/app.ts";
import { ChatCatalog, MODELS_UNAVAILABLE } from "../../src/gateway/chat/catalog.ts";
import type { AgentRuntimeConfig } from "../../src/gateway/chat/kube.ts";
import { listAppModels } from "../../src/gateway/models-union.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const app = (name: string, target: GatewayApp["target"], over: Partial<GatewayApp> = {}): GatewayApp => ({
  name,
  owner: "o",
  namespace: "ns",
  provider: "claude",
  style: "anthropic",
  target,
  state: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const config: AgentRuntimeConfig = {
  providers: {
    claude: { identities: ["alpha", "team"], app: "claude-chat", identityApps: { team: "claude-team" } },
    codex: { identities: ["beta"], app: "codex-chat" },
    kimi: { identities: [] },
  },
};

const make = (over: Partial<ConstructorParameters<typeof ChatCatalog>[0]> = {}) => {
  const asked: Array<[string, string, string | undefined]> = [];
  const modelCalls: string[] = [];
  const catalog = new ChatCatalog({
    transport: { catalog: async () => config },
    appFor: async (p, identity, appName) => {
      asked.push([p, identity, appName]);
      return appName ? app(appName, { kind: "pin", identity }) : undefined;
    },
    models: async (a) => {
      modelCalls.push(a.name);
      return [{ id: `${a.name}-m1`, name: `${a.name} one` }];
    },
    isPool: async (n) => n === "team",
    ...over,
  });
  return { catalog, asked, modelCalls };
};

test("identities and pools come from the ConfigMap per provider", async () => {
  const { catalog, asked } = make();
  const all = await catalog.get();
  expect(all.map((p) => p.provider)).toEqual(["claude", "codex", "kimi"]);
  const claude = all[0]!;
  expect(claude.identities.map((i) => [i.name, i.kind])).toEqual([["alpha", "identity"], ["team", "pool"]]);
  // The app is the identity's own entry, else the provider's.
  expect(asked).toContainEqual(["claude", "alpha", "claude-chat"]);
  expect(asked).toContainEqual(["claude", "team", "claude-team"]);
  expect(claude.identities[0]?.models).toEqual([{ id: "claude-chat-m1", name: "claude-chat one" }]);
  expect(claude.efforts).toEqual([]);
  expect(all[2]?.identities).toEqual([]);
  // One provider only.
  expect((await catalog.get("codex")).map((p) => p.provider)).toEqual(["codex"]);
});

test("an identity that is a known pool is kind pool", async () => {
  const { catalog } = make({ isPool: async (n) => n === "alpha" });
  const claude = (await catalog.get("claude"))[0]!;
  expect(claude.identities.find((i) => i.name === "alpha")?.kind).toBe("pool");
  expect(claude.identities.find((i) => i.name === "team")?.kind).toBe("identity");
});

test("a failing model list gives modelsError and an empty list, not an error", async () => {
  const { catalog } = make({
    models: async (a) => {
      if (a.name === "claude-team") throw new Error("upstream down");
      return [{ id: "x", name: "X" }];
    },
  });
  const claude = (await catalog.get("claude"))[0]!;
  expect(claude.identities.find((i) => i.name === "team")).toEqual({ name: "team", kind: "pool", models: [], modelsError: MODELS_UNAVAILABLE });
  expect(claude.identities.find((i) => i.name === "alpha")?.modelsError).toBeUndefined();
  expect(MODELS_UNAVAILABLE).toBe("Models are unavailable. The agent's default will be used.");
});

test("an identity with no gateway app gets modelsError, and a good list is cached for a minute", async () => {
  let t = 1_000;
  const { catalog, modelCalls } = make({ now: () => t, appFor: async (_p, identity, appName) => (identity === "beta" ? undefined : appName ? app(appName, { kind: "pin", identity }) : undefined) });
  const codex = (await catalog.get("codex"))[0]!;
  expect(codex.identities[0]).toMatchObject({ name: "beta", models: [], modelsError: MODELS_UNAVAILABLE });
  await catalog.get("claude");
  await catalog.get("claude");
  expect(modelCalls.filter((n) => n === "claude-chat")).toHaveLength(1);
  t += 61_000;
  await catalog.get("claude");
  expect(modelCalls.filter((n) => n === "claude-chat")).toHaveLength(2);
});

test("listAppModels returns the union of a pool and the single list of a pin", async () => {
  const lists: Record<string, unknown> = {
    m1: { data: [{ id: "model-a", display_name: "Model A" }, { id: "model-b", display_name: "Model B" }] },
    m2: { data: [{ id: "model-b", display_name: "Model B" }, { id: "model-c", display_name: "Model C" }] },
  };
  const urls: string[] = [];
  const seenVersion: Array<string | null> = [];
  const deps = {
    poolMembers: async () => ["m1", "m2"],
    creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}` }) },
    fetch: (async (url: string, init: RequestInit) => {
      urls.push(url);
      seenVersion.push(new Headers(init.headers).get("anthropic-version"));
      const who = new Headers(init.headers).get("authorization")?.replace("Bearer tok-", "") ?? "";
      return Response.json(lists[who] ?? { data: [] });
    }) as unknown as typeof fetch,
  } as unknown as GatewayDeps;
  const signal = new AbortController().signal;
  const pool = await listAppModels(app("p", { kind: "pool" }), deps, signal);
  expect(pool).toEqual([
    { id: "model-a", name: "Model A" },
    { id: "model-b", name: "Model B" },
    { id: "model-c", name: "Model C" },
  ]);
  expect(urls.every((u) => u.endsWith("/v1/models"))).toBe(true);
  expect(seenVersion.every((v) => v === "2023-06-01")).toBe(true);
  const pin = await listAppModels(app("q", { kind: "pin", identity: "m2" }), deps, signal);
  expect(pin).toEqual([
    { id: "model-b", name: "Model B" },
    { id: "model-c", name: "Model C" },
  ]);
  // A pool whose members all fail has no list: the catalogue shows its fixed notice.
  const broken = { ...deps, fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch } as GatewayDeps;
  await expect(listAppModels(app("p", { kind: "pool" }), broken, signal)).rejects.toThrow();
});
