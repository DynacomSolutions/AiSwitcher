import { afterAll, describe, expect, test } from "bun:test";
import aisIdentityExtension, {
  AIS_EXTENSION_VERSION,
  asCredential,
  baseProviderOf,
  buildIdentityListings,
  buildProviderRows,
  filterOptionIndices,
  findModelInCatalog,
  formatIdentityTable,
  formatProviderTable,
  formatTable,
  identityLabelFor,
  interpolateConfigValue,
  matchIdentityForCwd,
  namespacedProviderId,
  needsCredentialRefresh,
  parseNamespacedProviderId,
  parseRegistryIdentities,
  parseUseTarget,
  pickDefaultIdentityName,
  readAisState,
  resolveModel,
  SearchableSelect,
  settingsWithDefaultModel,
  statusLine,
  type AiModel,
  type AuthMap,
  type ExtensionApiSubset,
  type ExtensionContextSubset,
  type RegistryIdentity,
  type RenderRequester,
  type SearchableComponent,
} from "../../src/pi-extension/ais-identity-extension.ts";
import { EXTENSION_SOURCE_TEXT } from "../../src/identities/pi-extension-install.ts";

// --- shared fixture models -------------------------------------------------

const sonnet: AiModel = { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" };
const opus: AiModel = { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" };
const glm: AiModel = { id: "glm-4.6", provider: "zai", name: "GLM 4.6" };
const codex: AiModel = { id: "gpt-5.6-luna", provider: "openai-codex", name: "GPT-5.6 Luna" };

const HOME = "/home/example";

// Raw terminal key data as pi's TUI delivers it to a focused custom component.
const KEY = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
  backspace: "\u007f",
} as const;

const REGISTRY = {
  version: 1,
  identities: [
    {
      name: "personal",
      label: "Personal",
      configDir: "/home/example/.pi/identities/personal",
      directories: ["/home/example/projects/personal/*"],
    },
    {
      name: "work",
      label: "Work",
      configDir: "/home/example/.pi/identities/work",
      directories: ["/home/example/projects/work"],
      aliases: ["wk"],
    },
  ],
};

// Per-identity auth.json fixtures (secrets never asserted, only shapes).
const IDENTITY_AUTH: Record<string, AuthMap> = {
  "/home/example/.pi/identities/personal": { anthropic: { type: "oauth" }, zai: { type: "api_key" } },
  "/home/example/.pi/identities/work": { anthropic: { type: "oauth" }, "openai-codex": { type: "oauth" } },
};

// --- pure-helper fixtures --------------------------------------------------

function nativeProvider(id: string, name: string, models: AiModel[], extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    baseUrl: `https://api.${id}.test`,
    auth: {
      apiKey: {
        name: `${name} key`,
        async resolve(input: { credential?: { key?: string } }) {
          return input.credential?.key ? { auth: { apiKey: input.credential.key }, source: "key" } : undefined;
        },
      },
      ...(extra.oauth ? { oauth: extra.oauth } : {}),
    },
    getModels: () => models.map((model) => ({ ...model, provider: id })),
    stream: () => ({}),
    streamSimple: () => ({}),
    ...(extra.filterModels ? { filterModels: extra.filterModels } : {}),
  };
}

const NATIVES = [
  nativeProvider("anthropic", "Anthropic", [sonnet, opus]),
  nativeProvider("zai", "ZAI", [glm]),
  nativeProvider("openai-codex", "OpenAI Codex", [codex]),
];

describe("namespacing", () => {
  test("namespacedProviderId joins provider and identity with the separator", () => {
    expect(namespacedProviderId("anthropic", "personal")).toBe("anthropic--personal");
    expect(namespacedProviderId("openai-codex", "identity-team")).toBe("openai-codex--identity-team");
  });

  test("parseNamespacedProviderId splits on the LAST separator", () => {
    expect(parseNamespacedProviderId("anthropic--personal")).toEqual({ provider: "anthropic", identityName: "personal" });
    expect(parseNamespacedProviderId("openai-codex--identity-team")).toEqual({
      provider: "openai-codex",
      identityName: "identity-team",
    });
    expect(parseNamespacedProviderId("anthropic")).toBeUndefined();
    expect(parseNamespacedProviderId("--personal")).toBeUndefined();
    expect(parseNamespacedProviderId("anthropic--")).toBeUndefined();
  });

  test("baseProviderOf strips the namespace", () => {
    expect(baseProviderOf("anthropic--personal")).toBe("anthropic");
    expect(baseProviderOf("anthropic")).toBe("anthropic");
  });
});

describe("registry parsing and labels", () => {
  test("parseRegistryIdentities reads the version-1 shape and defaults labels to names", () => {
    const parsed = parseRegistryIdentities({
      version: 1,
      identities: [
        { name: "work", label: "Work", configDir: "/w" },
        { name: "bare", configDir: "/b" },
      ],
    });
    expect(parsed).toBeDefined();
    expect(parsed?.[0]?.label).toBe("Work");
    expect(parsed?.[1]?.label).toBe("bare");
  });

  test("parseRegistryIdentities rejects bad shapes with undefined", () => {
    expect(parseRegistryIdentities(undefined)).toBeUndefined();
    expect(parseRegistryIdentities({ version: 2, identities: [] })).toBeUndefined();
    expect(parseRegistryIdentities({ version: 1 })).toBeUndefined();
  });

  test("identityLabelFor returns the REAL label, not the id", () => {
    const identities = parseRegistryIdentities(REGISTRY) as RegistryIdentity[];
    expect(identityLabelFor(identities, "personal")).toBe("Personal");
    expect(identityLabelFor(identities, "work")).toBe("Work");
    expect(identityLabelFor(identities, "ghost")).toBe("ghost");
    expect(identityLabelFor(identities, undefined)).toBeUndefined();
  });

  test("buildIdentityListings marks the active identity and reports bad registries", () => {
    const { listings } = buildIdentityListings(REGISTRY, "work");
    expect(listings.find((l) => l.name === "work")?.current).toBe(true);
    expect(listings.find((l) => l.name === "personal")?.current).toBe(false);
    expect(buildIdentityListings(undefined, "work").note).toContain("not readable");
    expect(buildIdentityListings({ version: 9 }, "work").note).toContain("unexpected shape");
  });

  test("formatIdentityTable renders launch commands", () => {
    const { listings } = buildIdentityListings(REGISTRY, "personal");
    const lines = formatIdentityTable(listings);
    expect(lines.find((l) => l.includes("> personal"))).toBeDefined();
    expect(lines.find((l) => l.includes("ais pi --identity=work"))).toBeDefined();
  });
});

describe("directory matching (match.ts grammar, replicated)", () => {
  const identities = parseRegistryIdentities(REGISTRY) as RegistryIdentity[];

  test("recursive /* matches the directory and everything beneath it", () => {
    expect(matchIdentityForCwd(identities, "/home/example/projects/personal/sub/deep", HOME)?.name).toBe("personal");
  });

  test("exact pattern matches only that directory", () => {
    expect(matchIdentityForCwd(identities, "/home/example/projects/work", HOME)?.name).toBe("work");
    expect(matchIdentityForCwd(identities, "/home/example/projects/work/sub", HOME)).toBeUndefined();
  });

  test("no match returns undefined", () => {
    expect(matchIdentityForCwd(identities, "/tmp/elsewhere", HOME)).toBeUndefined();
  });

  test("most-specific (longest base) match wins", () => {
    const two = parseRegistryIdentities({
      version: 1,
      identities: [
        { name: "broad", label: "Broad", configDir: "/b", directories: ["/home/example/projects/*"] },
        { name: "narrow", label: "Narrow", configDir: "/n", directories: ["/home/example/projects/narrow/*"] },
      ],
    }) as RegistryIdentity[];
    expect(matchIdentityForCwd(two, "/home/example/projects/narrow/x", HOME)?.name).toBe("narrow");
    expect(matchIdentityForCwd(two, "/home/example/projects/other", HOME)?.name).toBe("broad");
  });
});

describe("default-identity chain", () => {
  const identities = parseRegistryIdentities(REGISTRY) as RegistryIdentity[];

  test("wrapper marker wins when it names a registry identity", () => {
    expect(
      pickDefaultIdentityName({ identities, envMarker: "work", persisted: "personal", cwdMatch: "personal" }),
    ).toBe("work");
  });

  test("an unknown marker is ignored in favour of the persisted identity", () => {
    expect(
      pickDefaultIdentityName({ identities, envMarker: "agent", persisted: "personal", cwdMatch: undefined }),
    ).toBe("personal");
  });

  test("falls back to cwd match, then the first identity", () => {
    expect(
      pickDefaultIdentityName({ identities, envMarker: undefined, persisted: undefined, cwdMatch: "work" }),
    ).toBe("work");
    expect(
      pickDefaultIdentityName({ identities, envMarker: undefined, persisted: undefined, cwdMatch: undefined }),
    ).toBe("personal");
    expect(pickDefaultIdentityName({ identities: [], envMarker: undefined, persisted: undefined, cwdMatch: undefined })).toBeUndefined();
  });
});

describe("credentials", () => {
  test("asCredential narrows oauth and api_key, rejects malformed", () => {
    expect(asCredential({ type: "oauth", access: "a", refresh: "r", expires: 123 })).toEqual({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 123,
    });
    expect(asCredential({ type: "oauth", access: "a" })).toBeUndefined();
    expect(asCredential({ type: "api_key", key: "k" })).toEqual({ type: "api_key", key: "k" });
    expect(asCredential({ type: "api_key" })).toBeUndefined();
    expect(asCredential({ type: "mystery" })).toBeUndefined();
    expect(asCredential(undefined)).toBeUndefined();
  });

  test("needsCredentialRefresh refreshes near/at expiry but not fresh or unknown", () => {
    const now = 1_000_000;
    expect(needsCredentialRefresh({ type: "oauth", access: "a", refresh: "r", expires: now + 1_000 }, now)).toBe(true);
    expect(needsCredentialRefresh({ type: "oauth", access: "a", refresh: "r", expires: now + 600_000 }, now)).toBe(false);
    expect(needsCredentialRefresh({ type: "oauth", access: "a", refresh: "r", expires: 0 }, now)).toBe(false);
    expect(needsCredentialRefresh({ type: "api_key", key: "k" }, now)).toBe(false);
  });

  test("interpolateConfigValue handles env, braces, literals and rejects !command", () => {
    const env = (name: string) => (name === "TOKEN" ? "secret-value" : undefined);
    expect(interpolateConfigValue("$TOKEN", env)).toBe("secret-value");
    expect(interpolateConfigValue("${TOKEN}", env)).toBe("secret-value");
    expect(interpolateConfigValue("literal-key", env)).toBe("literal-key");
    expect(interpolateConfigValue("!cat /secret", env)).toBeUndefined();
  });
});

describe("settings + state persistence", () => {
  test("settingsWithDefaultModel sets the startup default and preserves other keys", () => {
    const out = JSON.parse(settingsWithDefaultModel({ theme: "dark", defaultProvider: "old" }, sonnet));
    expect(out.theme).toBe("dark");
    expect(out.defaultProvider).toBe("anthropic");
    expect(out.defaultModel).toBe("claude-sonnet-4-5");
  });

  test("settingsWithDefaultModel starts from empty when existing is not an object", () => {
    const out = JSON.parse(settingsWithDefaultModel(undefined, glm));
    expect(out.defaultProvider).toBe("zai");
    expect(out.defaultModel).toBe("glm-4.6");
  });

  test("readAisState tolerates bad JSON with an empty state", () => {
    expect(readAisState("/nonexistent/ais-state.json")).toEqual({});
  });
});

describe("tables", () => {
  test("formatTable aligns columns to the widest cell", () => {
    const lines = formatTable(["A", "BB"], [["x", "y"], ["longer", "z"]]);
    expect(lines[0]).toBe("A       BB");
    expect(lines[1]).toBe("------  --");
    expect(lines[2]).toBe("x       y");
    expect(lines[3]).toBe("longer  z");
  });

  test("buildProviderRows marks the current row via the BASE provider of a namespaced model", () => {
    const namespacedSonnet = { ...sonnet, provider: "anthropic--personal" };
    const rows = buildProviderRows(
      { anthropic: { type: "oauth" }, zai: { type: "api_key" } },
      [namespacedSonnet, glm],
      namespacedSonnet,
      (p) => p,
    );
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    expect(byProvider.get("anthropic")?.current).toBe(true);
    expect(byProvider.get("anthropic")?.models).toBe(1);
    expect(byProvider.get("zai")?.current).toBe(false);
  });

  test("buildProviderRows surfaces gap notes for credential-less and catalogue-less providers", () => {
    const rows = buildProviderRows({ "kimi-coding": { type: "oauth" } }, [glm], glm, (p) => p);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    expect(byProvider.get("kimi-coding")?.note).toBe("credential present but no models in Pi's catalogue");
    expect(byProvider.get("zai")?.note).toBe("active via environment or provider defaults");
  });

  test("formatProviderTable marks the current provider", () => {
    const rows = buildProviderRows({ zai: { type: "api_key" } }, [glm, sonnet], glm, (p) => p);
    const lines = formatProviderTable(rows, glm);
    expect(lines.find((l) => l.includes("zai"))).toStartWith("> ");
  });
});

describe("/ais use parsing", () => {
  const keys = ["personal", "work", "wk"];

  test("accepts provider and provider/model", () => {
    expect(parseUseTarget("zai", keys)).toEqual({ provider: "zai" });
    expect(parseUseTarget("zai/glm-4.6", keys)).toEqual({ provider: "zai", modelId: "glm-4.6" });
  });

  test("accepts an identity-scoped form (name or alias)", () => {
    expect(parseUseTarget("work anthropic/claude-opus-5", keys)).toEqual({
      identity: "work",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    expect(parseUseTarget("wk anthropic", keys)).toEqual({ identity: "wk", provider: "anthropic" });
  });

  test("accepts a fully namespaced provider id", () => {
    expect(parseUseTarget("anthropic--personal/claude-opus-5", keys)).toEqual({
      identity: "personal",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
  });

  test("rejects empty input and unknown second tokens", () => {
    expect("error" in parseUseTarget("", keys)).toBe(true);
    expect("error" in parseUseTarget("zai extra junk", keys)).toBe(true);
  });
});

describe("model resolution", () => {
  test("findModelInCatalog prefers exact, then substring, then first", () => {
    const catalog = [sonnet, opus];
    expect(findModelInCatalog(catalog, "anthropic", "claude-opus-5")).toEqual(opus);
    expect(findModelInCatalog(catalog, "anthropic", "opus")).toEqual(opus);
    expect(findModelInCatalog(catalog, "anthropic", undefined)).toEqual(sonnet);
    expect(findModelInCatalog(catalog, "anthropic", "nope")).toBeUndefined();
    expect(findModelInCatalog(catalog, "zai", undefined)).toBeUndefined();
  });

  test("findModelInCatalog matches on the BASE provider of namespaced models", () => {
    const catalog = [{ ...sonnet, provider: "anthropic--personal" }];
    expect(findModelInCatalog(catalog, "anthropic", "claude-sonnet-4-5")?.provider).toBe("anthropic--personal");
  });

  test("resolveModel over pi's native registry prefers exact then partial then first", () => {
    const reg = {
      getAvailable: () => [sonnet, glm],
      find: (p: string, id: string) => [sonnet, glm].find((m) => m.provider === p && m.id === id),
      hasConfiguredAuth: () => true,
      getProviderDisplayName: (p: string) => p,
    };
    expect(resolveModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" }, reg)).toEqual({ model: sonnet });
    expect(resolveModel({ provider: "anthropic", modelId: "sonnet" }, reg)).toEqual({ model: sonnet });
    expect(resolveModel({ provider: "anthropic" }, reg)).toEqual({ model: sonnet });
    expect("error" in resolveModel({ provider: "amazon-bedrock" }, reg)).toBe(true);
  });
});

describe("status line", () => {
  test("uses the REAL label and the base provider", () => {
    expect(statusLine("Personal", { ...sonnet, provider: "anthropic--personal" })).toBe(
      "ais Personal: anthropic/claude-sonnet-4-5",
    );
  });

  test("reports an honest fallback when no identity resolved", () => {
    expect(statusLine(undefined, undefined)).toBe("ais: no model selected (no AIS identity resolved)");
  });
});

// --- factory / command behaviour -------------------------------------------

// The extension derives its state/settings/auth paths from
// PI_CODING_AGENT_DIR (falling back to $HOME/.pi/agent). Pin it to the
// fixture home for the whole file so injected-store paths are deterministic,
// and restore the ambient value afterwards.
const SAVED_PI_DIR = process.env.PI_CODING_AGENT_DIR;
const INSTANCE_DIR = `${HOME}/.pi/agent`;
process.env.PI_CODING_AGENT_DIR = INSTANCE_DIR;
afterAll(() => {
  if (SAVED_PI_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = SAVED_PI_DIR;
});

interface RegisteredProvider {
  id: string;
  name: string;
  getModels(): AiModel[];
  auth: { apiKey?: { resolve(input: unknown): Promise<unknown> } };
}

function harness(options: {
  ctx?: Partial<ExtensionContextSubset>;
  registry?: unknown;
  identityAuth?: Record<string, AuthMap>;
  natives?: unknown[];
  setModelResult?: boolean;
  selectResponses?: Array<string | undefined>;
  /** Scripted raw key data per `ctx.ui.custom` dialog. Providing this enables
   * the fake `custom`; without it the harness omits `custom` entirely so the
   * extension takes its `select` fallback path. */
  customKeys?: string[][];
  argv?: string[];
}) {
  const registered: RegisteredProvider[] = [];
  const setModelCalls: AiModel[] = [];
  const writes: Array<{ path: string; data: unknown; mode: number }> = [];
  const jsonStore = new Map<string, unknown>();
  let setModelResult = options.setModelResult ?? true;
  const selectResponses = [...(options.selectResponses ?? [])];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const customKeys = [...(options.customKeys ?? [])];
  const customCalls: Array<{ keys: string[]; component: SearchableComponent }> = [];

  const handlers = new Map<string, (event: never, ctx: ExtensionContextSubset) => unknown>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContextSubset) => unknown }>();

  const widgets: Array<readonly string[] | undefined> = [];
  const statuses: string[] = [];
  const notes: Array<[string, string | undefined]> = [];

  const baseCtx: ExtensionContextSubset = {
    hasUI: true,
    cwd: "/home/example/projects/personal/app",
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
      getProviderDisplayName: (p: string) => p,
    },
    ui: {
      notify: (m, t) => notes.push([m, t]),
      setStatus: (_k, text) => {
        if (text !== undefined) statuses.push(text);
      },
      setWidget: (_k, content) => widgets.push(content),
      select: async (title: string, opts: string[]) => {
        selectCalls.push({ title, options: opts });
        return selectResponses.shift();
      },
      ...(options.customKeys !== undefined
        ? {
            custom: async <T,>(
              factory: (tui: RenderRequester, theme: unknown, keybindings: unknown, done: (result: T) => void) => SearchableComponent,
            ): Promise<T> => {
              const keys = customKeys.shift() ?? [];
              let result: T | undefined;
              let finished = false;
              const component = factory({ requestRender() {} }, {}, {}, (value: T) => {
                result = value;
                finished = true;
              });
              customCalls.push({ keys, component });
              for (const key of keys) {
                component.handleInput(key);
                if (finished) break;
              }
              return result as T;
            },
          }
        : {}),
    },
    ...(options.ctx ?? {}),
  };

  const api = {
    on(event: string, handler: (event: never, ctx: ExtensionContextSubset) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: ExtensionContextSubset) => unknown }) {
      commands.set(name, opts);
    },
    registerProvider(provider: RegisteredProvider) {
      registered.push(provider);
    },
    async setModel(model: AiModel) {
      setModelCalls.push(model);
      baseCtx.model = model;
      return setModelResult;
    },
  } as unknown as ExtensionApiSubset;

  const promise = aisIdentityExtension(api, {
    readRegistry: () => (options.registry ?? REGISTRY),
    identityName: () => undefined,
    readAuth: () => ({}),
    readIdentityAuth: (configDir: string) =>
      structuredClone((options.identityAuth ?? IDENTITY_AUTH)[configDir] ?? {}),
    readIdentityModels: () => ({}),
    natives: () => (options.natives ?? NATIVES) as never,
    writeJson: (path, data, mode) => {
      writes.push({ path, data, mode });
      jsonStore.set(path, data);
    },
    readJson: (path) => jsonStore.get(path),
    now: () => 1_000_000,
    cwd: () => baseCtx.cwd ?? "/home/example/projects/personal/app",
    argv: options.argv ?? [],
    home: () => HOME,
  });

  return {
    promise,
    api,
    ctx: baseCtx,
    registered,
    setModelCalls,
    setModelResultSetter: (v: boolean) => {
      setModelResult = v;
    },
    writes,
    jsonStore,
    widgets,
    statuses,
    notes,
    selectCalls,
    customCalls,
    handlers,
    commands,
  };
}

describe("provider registration", () => {
  test("registers a namespaced provider per (identity, provider) credential", async () => {
    const h = harness({});
    await h.promise;
    const ids = h.registered.map((p) => p.id).sort();
    expect(ids).toContain("anthropic--personal");
    expect(ids).toContain("zai--personal");
    expect(ids).toContain("anthropic--work");
    expect(ids).toContain("openai-codex--work");
    // display names carry the identity LABEL
    expect(h.registered.find((p) => p.id === "anthropic--personal")?.name).toBe("Anthropic (Personal)");
  });

  test("namespaced models are remapped to the namespaced provider id", async () => {
    const h = harness({});
    await h.promise;
    const personal = h.registered.find((p) => p.id === "anthropic--personal");
    const models = personal?.getModels() ?? [];
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "anthropic--personal")).toBe(true);
  });

  test("oauth credentials resolve through the native provider and refresh writes back to the SOURCE identity", async () => {
    let refreshCalls = 0;
    const natives = [
      nativeProvider("anthropic", "Anthropic", [sonnet], {
        oauth: {
          name: "Anthropic OAuth",
          async refresh(cred: { refresh: string }) {
            refreshCalls += 1;
            return { type: "oauth", access: "rotated-access", refresh: `${cred.refresh}-rotated`, expires: 9_999_999_999 };
          },
          async toAuth(cred: { access: string }) {
            return { apiKey: cred.access };
          },
        },
      }),
    ];
    // expired oauth credential for personal/anthropic
    const identityAuth = {
      "/home/example/.pi/identities/personal": {
        anthropic: { type: "oauth", access: "old", refresh: "r0", expires: 1_000_000 - 10 },
      },
    };
    const h = harness({ natives, identityAuth, registry: { version: 1, identities: [REGISTRY.identities[0]] } });
    await h.promise;
    const provider = h.registered.find((p) => p.id === "anthropic--personal");
    const resolved = (await provider?.auth.apiKey?.resolve({
      ctx: {},
      credential: undefined,
      signal: new AbortController().signal,
    })) as { auth: { apiKey: string }; source: string };
    expect(refreshCalls).toBe(1);
    expect(resolved.auth.apiKey).toBe("rotated-access");
    expect(resolved.source).toContain("Personal");
    // write-back landed in the SOURCE identity's auth.json at mode 0600
    const writeBack = h.writes.find((w) => w.path === "/home/example/.pi/identities/personal/auth.json");
    expect(writeBack?.mode).toBe(0o600);
    expect((writeBack?.data as AuthMap).anthropic).toMatchObject({ type: "oauth", access: "rotated-access" });
  });

  test("api_key credentials resolve through the native apiKey resolve", async () => {
    const h = harness({
      registry: { version: 1, identities: [REGISTRY.identities[0]] },
      identityAuth: {
        "/home/example/.pi/identities/personal": { zai: { type: "api_key", key: "SYNTHETIC_FIXTURE_KEY" } },
      },
    });
    await h.promise;
    const zai = h.registered.find((p) => p.id === "zai--personal");
    expect(zai).toBeDefined();
    const resolved = (await zai?.auth.apiKey?.resolve({
      ctx: {},
      credential: undefined,
      signal: new AbortController().signal,
    })) as { auth: { apiKey: string } };
    expect(resolved.auth.apiKey).toBe("SYNTHETIC_FIXTURE_KEY");
  });
});

describe("/ais command behaviour", () => {
  test("/ais runs the interactive switcher: pick identity then model, then setModel", async () => {
    const h = harness({ selectResponses: ["Work", "openai-codex/gpt-5.6-luna — GPT-5.6 Luna"] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.selectCalls[0]?.title).toContain("Switch AIS identity");
    expect(h.selectCalls[0]?.options).toContain("Personal (current)");
    expect(h.selectCalls[1]?.title).toContain("Model for Work");
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "openai-codex--work", id: "gpt-5.6-luna" });
  });

  test("/ais switcher is a no-op when the identity selection is cancelled", async () => {
    const h = harness({ selectResponses: [undefined] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.setModelCalls).toHaveLength(0);
    expect(h.selectCalls).toHaveLength(1);
  });

  test("/ais searchable switcher: typed filters pick identity then model via ctx.ui.custom", async () => {
    const h = harness({ customKeys: [["w", "o", "r", "k", KEY.enter], ["l", "u", "n", "a", KEY.enter]] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.customCalls).toHaveLength(2);
    expect(h.selectCalls).toHaveLength(0);
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "openai-codex--work", id: "gpt-5.6-luna" });
    const stateWrite = h.writes.filter((w) => w.path.endsWith("/ais-state.json")).at(-1);
    expect((stateWrite?.data as { activeIdentity?: string }).activeIdentity).toBe("work");
  });

  test("esc at the identity step cancels the whole switcher", async () => {
    const h = harness({ customKeys: [[KEY.escape]] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.customCalls).toHaveLength(1);
    expect(h.setModelCalls).toHaveLength(0);
  });

  test("esc at the model step keeps the identity switch but changes no model", async () => {
    const h = harness({ customKeys: [["w", "o", "r", "k", KEY.enter], [KEY.escape]] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    h.writes.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.setModelCalls).toHaveLength(0);
    const stateWrite = h.writes.filter((w) => w.path.endsWith("/ais-state.json")).at(-1);
    expect((stateWrite?.data as { activeIdentity?: string }).activeIdentity).toBe("work");
  });

  test("hosts without ctx.ui.custom fall back to ctx.ui.select", async () => {
    const h = harness({ selectResponses: ["Work", "openai-codex/gpt-5.6-luna \u2014 GPT-5.6 Luna"] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    h.setModelCalls.length = 0;
    await h.commands.get("ais")?.handler("", h.ctx);
    expect(h.customCalls).toHaveLength(0);
    expect(h.selectCalls).toHaveLength(2);
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "openai-codex--work", id: "gpt-5.6-luna" });
  });

  test("/ais show renders the context widget with the active identity label", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.commands.get("ais")?.handler("show", h.ctx);
    const widget = h.widgets.at(-1) as readonly string[];
    expect(widget.join("\n")).toContain("ais identity:");
    expect(widget.length).toBeLessThanOrEqual(12);
  });

  test("/ais use switches an active-identity namespaced model", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.commands.get("ais")?.handler("use anthropic/claude-opus-5", h.ctx);
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "anthropic--personal", id: "claude-opus-5" });
  });

  test("/ais use <identity> <provider> switches identity scope", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.commands.get("ais")?.handler("use work openai-codex", h.ctx);
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "openai-codex--work" });
  });

  test("/ais use surfaces a refusal honestly when pi rejects the switch", async () => {
    const h = harness({ setModelResult: false });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.commands.get("ais")?.handler("use anthropic", h.ctx);
    expect(h.notes.at(-1)?.[1]).toBe("error");
    expect(h.notes.at(-1)?.[0]).toContain("no authentication configured");
  });

  test("/ais identities renders the table without the old relaunch-only wording", async () => {
    const h = harness({});
    await h.promise;
    await h.commands.get("ais")?.handler("identities", h.ctx);
    const widget = h.widgets.at(-1) as readonly string[];
    expect(widget.join("\n")).toContain("Switch in-app");
    expect(widget.join("\n")).not.toContain("requires a relaunch");
  });

  test("unknown /ais arguments warn", async () => {
    const h = harness({});
    await h.promise;
    await h.commands.get("ais")?.handler("frobnicate", h.ctx);
    expect(h.notes.at(-1)?.[1]).toBe("warning");
  });

  test("a provider the active identity lacks but SEVERAL others have asks the user to disambiguate", async () => {
    const registry = {
      version: 1,
      identities: [
        { name: "aaa", label: "AAA", configDir: "/home/example/.pi/identities/aaa" },
        { name: "bbb", label: "BBB", configDir: "/home/example/.pi/identities/bbb" },
        { name: "ccc", label: "CCC", configDir: "/home/example/.pi/identities/ccc" },
      ],
    };
    const identityAuth = {
      "/home/example/.pi/identities/aaa": {} as AuthMap,
      "/home/example/.pi/identities/bbb": { zai: { type: "api_key", key: "SYNTHETIC_FIXTURE_B" } } as AuthMap,
      "/home/example/.pi/identities/ccc": { zai: { type: "api_key", key: "SYNTHETIC_FIXTURE_C" } } as AuthMap,
    };
    const h = harness({ registry, identityAuth, ctx: { cwd: "/tmp/no-match" } });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.commands.get("ais")?.handler("use zai", h.ctx);
    expect(h.notes.at(-1)?.[1]).toBe("warning");
    expect(h.notes.at(-1)?.[0]).toContain("several identities");
  });

  test("a provider only ONE other identity has switches to it and adopts that identity", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    // openai-codex exists only for work; the active identity is personal
    await h.commands.get("ais")?.handler("use openai-codex", h.ctx);
    expect(h.setModelCalls.at(-1)).toMatchObject({ provider: "openai-codex--work" });
    const stateWrite = h.writes.filter((w) => w.path.endsWith("/ais-state.json")).at(-1);
    expect((stateWrite?.data as { activeIdentity?: string }).activeIdentity).toBe("work");
  });
});

describe("model_select persistence", () => {
  test("model_select writes the settings default (last-used model) and the state", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.handlers.get("model_select")?.({ model: { ...opus, provider: "anthropic--personal" } } as never, h.ctx);
    const settingsWrite = h.writes.find((w) => w.path.endsWith("/settings.json"));
    expect((settingsWrite?.data as Record<string, unknown>).defaultProvider).toBe("anthropic--personal");
    expect((settingsWrite?.data as Record<string, unknown>).defaultModel).toBe("claude-opus-5");
    const stateWrite = h.writes.find((w) => w.path.endsWith("/ais-state.json"));
    expect((stateWrite?.data as { activeIdentity?: string }).activeIdentity).toBe("personal");
  });

  test("a one-off --model flag does NOT overwrite the persisted settings default", async () => {
    const h = harness({ argv: ["pi", "--model", "anthropic--work/claude-opus-5"] });
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.handlers.get("model_select")?.({ model: { ...opus, provider: "anthropic--work" } } as never, h.ctx);
    expect(h.writes.find((w) => w.path.endsWith("/settings.json"))).toBeUndefined();
  });

  test("status line follows model_select with the identity LABEL", async () => {
    const h = harness({});
    await h.promise;
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    await h.handlers.get("model_select")?.({ model: { ...glm, provider: "zai--personal" } } as never, h.ctx);
    expect(h.statuses.at(-1)).toBe("ais Personal: zai/glm-4.6");
  });
});

describe("session_start default model", () => {
  test("picks the active identity's model when none is usable", async () => {
    const h = harness({});
    await h.promise;
    // cwd matches personal/* so personal is the default identity
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    expect(h.setModelCalls.length).toBeGreaterThan(0);
    expect(h.setModelCalls[0]?.provider).toEndWith("--personal");
  });

  test("leaves a settings-default native model alone", async () => {
    const h = harness({ ctx: { model: { id: "some-model", provider: "openai" } } });
    await h.promise;
    h.jsonStore.set(`${INSTANCE_DIR}/settings.json`, { defaultProvider: "openai", defaultModel: "some-model" });
    await h.handlers.get("session_start")?.(undefined as never, h.ctx);
    expect(h.setModelCalls).toHaveLength(0);
  });
});

describe("jiti loadability", () => {
  test("the extension source transpiles cleanly (pi loads extensions via jiti)", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const source = EXTENSION_SOURCE_TEXT;
    expect(() => transpiler.transformSync(source)).not.toThrow();
    expect(transpiler.transformSync(source)).toContain("aisIdentityExtension");
  });

  test("version stamp is present and well-formed", () => {
    expect(AIS_EXTENSION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("filterOptionIndices (pure)", () => {
  const options = ["anthropic/claude-opus-5 — Claude Opus 5", "anthropic/claude-sonnet-5", "openai-codex/gpt-5.6-luna — GPT-5.6 Luna"];

  test("an empty query matches everything in original order", () => {
    expect(filterOptionIndices("", options)).toEqual([0, 1, 2]);
    expect(filterOptionIndices("   ", options)).toEqual([0, 1, 2]);
  });

  test("tokens AND case-insensitively in any order", () => {
    expect(filterOptionIndices("LUNA", options)).toEqual([2]);
    expect(filterOptionIndices("anthropic opus", options)).toEqual([0]);
    expect(filterOptionIndices("opus anthropic", options)).toEqual([0]);
    expect(filterOptionIndices("anthropic", options)).toEqual([0, 1]);
    expect(filterOptionIndices("claude 5", options)).toEqual([0, 1]);
  });

  test("an impossible token matches nothing", () => {
    expect(filterOptionIndices("zzz", options)).toEqual([]);
    expect(filterOptionIndices("anthropic luna", options)).toEqual([]);
  });
});

describe("SearchableSelect component", () => {
  const OPTIONS = [
    "anthropic/claude-opus-5 — Claude Opus 5",
    "anthropic/claude-sonnet-5 — Claude Sonnet 5",
    "openai-codex/gpt-5.6-luna — GPT-5.6 Luna",
  ];

  function picker(options: readonly string[] = OPTIONS) {
    const results: Array<string | undefined> = [];
    const sel = new SearchableSelect("Pick a model:", options, (value) => results.push(value));
    return { sel, results };
  }

  test("enter returns the highlighted ORIGINAL option string", () => {
    const { sel, results } = picker();
    sel.handleInput("luna");
    sel.handleInput(KEY.enter);
    expect(results).toEqual([OPTIONS[2]]);
  });

  test("typing narrows the list and arrows move within the filtered subset", () => {
    const { sel, results } = picker();
    sel.handleInput("anthropic");
    expect(sel.render(100).filter((line) => line.includes("anthropic/"))).toHaveLength(2);
    sel.handleInput(KEY.down);
    sel.handleInput(KEY.enter);
    expect(results).toEqual([OPTIONS[1]]);
  });

  test("down past the last match clamps; up returns", () => {
    const { sel, results } = picker();
    sel.handleInput("anthropic");
    sel.handleInput(KEY.down);
    sel.handleInput(KEY.down); // clamps at 1
    sel.handleInput(KEY.up); // back to 0
    sel.handleInput(KEY.enter);
    expect(results).toEqual([OPTIONS[0]]);
  });

  test("escape cancels with undefined", () => {
    const { sel, results } = picker();
    sel.handleInput(KEY.escape);
    expect(results).toEqual([undefined]);
  });

  test("backspace edits the query", () => {
    const { sel, results } = picker();
    for (const ch of "lunax") sel.handleInput(ch);
    sel.handleInput(KEY.backspace);
    sel.handleInput(KEY.enter);
    expect(results).toEqual([OPTIONS[2]]);
  });

  test("unrecognised escape sequences are ignored, not typed as filter text", () => {
    const { sel } = picker();
    sel.handleInput("\u001b[1;5C"); // ctrl+right: unmapped
    expect(sel.render(100)[1]).toBe("Search: \u2588");
  });

  test("enter with no matches does not resolve; escape still cancels", () => {
    const { sel, results } = picker();
    sel.handleInput("zzz");
    sel.handleInput(KEY.enter);
    expect(results).toEqual([]);
    sel.handleInput(KEY.escape);
    expect(results).toEqual([undefined]);
  });

  test("the component is inert after completion", () => {
    const { sel, results } = picker();
    sel.handleInput(KEY.enter);
    sel.handleInput(KEY.enter);
    sel.handleInput(KEY.escape);
    expect(results).toHaveLength(1);
  });

  test("render shows title, query with cursor, marker and match counts", () => {
    const { sel } = picker();
    sel.handleInput("opus");
    const lines = sel.render(100);
    expect(lines[0]).toBe("Pick a model:");
    expect(lines[1]).toBe("Search: opus\u2588");
    expect(lines[2]).toBe(`> ${OPTIONS[0]}`);
    expect(lines.at(-1)).toBe("1/3 \u00b7 type to search \u00b7 enter select \u00b7 esc cancel");
  });

  test("render reports no matches honestly", () => {
    const { sel } = picker();
    sel.handleInput("zzz");
    const lines = sel.render(100);
    expect(lines.some((line) => line.includes("(no matches"))).toBe(true);
    expect(lines.at(-1)).toContain("0/3");
  });

  test("long lists scroll: the window follows the selection", () => {
    const many = Array.from({ length: 30 }, (_, i) => `opt-${String(i).padStart(2, "0")}`);
    const { sel } = picker(many);
    const first = sel.render(60);
    // title + search + 12 visible rows + count footer
    expect(first).toHaveLength(15);
    expect(first[2]).toBe("> opt-00");
    expect(first.some((line) => line.includes("opt-12"))).toBe(false);
    for (let i = 0; i < 13; i++) sel.handleInput(KEY.down);
    const scrolled = sel.render(60);
    expect(scrolled.some((line) => line === "> opt-13")).toBe(true);
    expect(scrolled.some((line) => line.includes("opt-01"))).toBe(false);
    expect(scrolled.at(-1)).toContain("30/30");
  });

  test("render output is width-truncated and cached per width", () => {
    const { sel } = picker();
    const wide = sel.render(200);
    const cached = sel.render(200);
    expect(cached).toBe(wide); // identical array reference while cached
    const narrow = sel.render(10);
    expect(narrow).not.toBe(wide);
    expect(narrow.every((line) => line.length <= 40)).toBe(true);
  });
});
