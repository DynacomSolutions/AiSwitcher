import { describe, expect, test } from "bun:test";
import aisIdentityExtension, {
  AIS_EXTENSION_VERSION,
  buildIdentityListings,
  buildProviderRows,
  formatIdentityTable,
  formatProviderTable,
  formatTable,
  parseUseTarget,
  resolveModel,
  statusLine,
  type AiModel,
  type AuthMap,
  type ExtensionApiSubset,
  type ExtensionContextSubset,
} from "../../src/pi-extension/ais-identity-extension.ts";
import { EXTENSION_SOURCE_TEXT } from "../../src/identities/pi-extension-install.ts";

function embeddedExtensionSourceText(): string {
  return EXTENSION_SOURCE_TEXT;
}

const sonnet: AiModel = { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" };
const glm: AiModel = { id: "glm-4.6", provider: "zai", name: "GLM 4.6" };
const codex: AiModel = { id: "gpt-5-codex", provider: "openai-codex" };

function registry(models: AiModel[], withAuth = true) {
  return {
    getAvailable: () => models,
    find: (provider: string, modelId: string) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth: (model: AiModel) => withAuth,
    getProviderDisplayName: (provider: string) => provider.toUpperCase(),
  };
}

function context(overrides: Partial<ExtensionContextSubset> = {}): ExtensionContextSubset {
  return {
    hasUI: true,
    model: sonnet,
    modelRegistry: registry([sonnet, glm, codex]),
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    ...overrides,
  };
}

const FIXTURE_AUTH: AuthMap = {
  anthropic: { type: "oauth" },
  zai: { type: "api_key" },
};

const FIXTURE_REGISTRY = {
  version: 1,
  identities: [
    { name: "identity-a", label: "Identity A", configDir: "/tmp/example/pi/identity-a" },
    { name: "identity-b", label: "Identity B", configDir: "/tmp/example/pi/identity-b" },
  ],
};

/** Test harness. Stubs every registration and UI call; readers are injected,
 * so tests never read auth.json, the registry or session env. */
function harness(ctx: ExtensionContextSubset, options: { setModelResult?: boolean } = {}) {
  const handlers = new Map<string, (event: never, ctx: ExtensionContextSubset) => unknown>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContextSubset) => unknown }>();
  const setModelCalls: AiModel[] = [];
  let setModelResult = options.setModelResult ?? true;
  const api = {
    on(event: string, handler: (event: never, ctx: ExtensionContextSubset) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContextSubset) => unknown }) {
      commands.set(name, options);
    },
    async setModel(model: AiModel) {
      setModelCalls.push(model);
      const next = ctx.model;
      ctx.model = model;
      return setModelResult;
    },
  } as unknown as ExtensionApiSubset & { setModelCalls: AiModel[] };
  aisIdentityExtension(api, {
    readAuth: () => FIXTURE_AUTH,
    readRegistry: () => FIXTURE_REGISTRY,
    identityName: () => "identity-a",
  });
  return {
    api,
    handlers,
    commands,
    setModelCalls,
    setModelResultSetter: (value: boolean) => {
      setModelResult = value;
    },
    ctx,
  };
}

describe("ais extension pure helpers", () => {
  test("version stamp is present and well-formed", async () => {
    expect(AIS_EXTENSION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("formatTable aligns columns to the widest cell", async () => {
    const lines = formatTable(["A", "BB"], [["x", "y"], ["longer", "z"]]);
    expect(lines[0]).toBe("A       BB");
    expect(lines[1]).toBe("------  --");
    expect(lines[2]).toBe("x       y");
    expect(lines[3]).toBe("longer  z");
  });

  test("buildProviderRows merges credentials with the catalogue and marks the current row", async () => {
    const auth: AuthMap = {
      anthropic: { type: "oauth" },
      zai: { type: "api_key" },
    };
    const rows = buildProviderRows(auth, [sonnet, glm, codex], sonnet, (provider) => provider);
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    expect(byProvider.get("anthropic")?.credential).toBe("oauth");
    expect(byProvider.get("anthropic")?.models).toBe(1);
    expect(byProvider.get("anthropic")?.current).toBe(true);
    expect(byProvider.get("anthropic")?.note).toBeUndefined();
    expect(byProvider.get("zai")?.current).toBe(false);
    expect(byProvider.get("openai-codex")?.credential).toBe("-");
    expect(byProvider.get("openai-codex")?.models).toBe(1);
    expect(byProvider.get("openai-codex")?.current).toBe(false);
  });

  test("buildProviderRows explains catalogue-less credentials and credential-less catalogue providers", async () => {
    const rows = buildProviderRows(
      { "kimi-coding": { type: "oauth" } },
      [glm],
      glm,
      (provider) => provider,
    );
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    expect(byProvider.get("kimi-coding")?.note).toBe("credential present but no models in Pi's catalogue");
    // zai is the current model's provider but has no auth.json entry.
    expect(byProvider.get("zai")?.note).toBe("active via environment or provider defaults");
  });

  test("buildProviderRows surfaces the known Amazon Bedrock gap", async () => {
    const rows = buildProviderRows({}, [], undefined, (provider) => provider);
    expect(rows).toHaveLength(0);
    const withBedrock = buildProviderRows({ "amazon-bedrock": { type: "api_key" } }, [], undefined, (p) => p);
    expect(withBedrock[0]?.note).toBe("credential present but no models in Pi's catalogue");
  });

  test("formatProviderTable marks the current provider and renders its model id", async () => {
    const auth: AuthMap = { zai: { type: "api_key" } };
    const rows = buildProviderRows(auth, [glm, sonnet], glm, (provider) => provider);
    const lines = formatProviderTable(rows, glm);
    expect(lines[0]).toContain("PROVIDER");
    const zaiRow = lines.find((line) => line.includes("zai"));
    expect(zaiRow).toStartWith("> ");
    expect(zaiRow).toContain("in use: glm-4.6");
  });

  test("parseUseTarget accepts provider and provider/model and rejects empty input", async () => {
    expect(parseUseTarget("")).toEqual({
      error: "usage: /ais use <provider>[/<model>] (example: /ais use zai/glm-4.6)",
    });
    expect(parseUseTarget("  zai ")).toEqual({ provider: "zai" });
    expect(parseUseTarget("zai/glm-4.6")).toEqual({ provider: "zai", modelId: "glm-4.6" });
  });

  test("resolveModel prefers an exact match, falls back to a partial id, then the first catalogue model", async () => {
    const reg = registry([sonnet, glm]);
    expect(resolveModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" }, reg)).toEqual({ model: sonnet });
    expect(resolveModel({ provider: "anthropic", modelId: "sonnet" }, reg)).toEqual({ model: sonnet });
    expect(resolveModel({ provider: "anthropic" }, reg)).toEqual({ model: sonnet });
    const miss = resolveModel({ provider: "anthropic", modelId: "opus" }, reg);
    expect("error" in miss).toBe(true);
    const noModels = resolveModel({ provider: "amazon-bedrock" }, reg);
    expect("error" in noModels && noModels.error).toContain("ambient AWS credential chain");
  });

  test("buildIdentityListings marks the active identity and reports bad registries honestly", async () => {
    const registryJson = {
      version: 1,
      identities: [
        { name: "work", label: "Work", configDir: "/home/example/.pi/identities/work" },
        { name: "personal", configDir: "/home/example/.pi/identities/personal" },
      ],
    };
    const { listings, note } = buildIdentityListings(registryJson, "personal");
    expect(note).toBeUndefined();
    expect(listings).toHaveLength(2);
    expect(listings[0]?.label).toBe("Work");
    expect(listings[0]?.current).toBe(false);
    expect(listings[1]?.current).toBe(true);
    expect(listings[1]?.label).toBe("personal");

    const bad = buildIdentityListings({ version: 2 }, "personal");
    expect(bad.listings).toHaveLength(0);
    expect(bad.note).toContain("unexpected shape");

    const unreadable = buildIdentityListings(undefined, "personal");
    expect(unreadable.note).toContain("not readable");

    const lines = formatIdentityTable(listings);
    expect(lines.find((line) => line.includes("personal"))).toContain("ais pi --identity=personal");
    expect(lines.find((line) => line.includes("> personal"))).toBeDefined();
  });

  test("statusLine reports an honest fallback outside the wrapper", async () => {
    expect(statusLine("work", glm)).toBe("ais work: zai/glm-4.6");
    expect(statusLine(undefined, undefined)).toBe("ais: no model selected (launched outside the ais wrapper)");
  });
});

describe("ais extension command behaviour", () => {
  test("/ais renders the context widget with the table and gap notes", async () => {
    const widgets: Array<readonly string[] | undefined> = [];
    const ctx = context({
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: (_key: string | undefined, content: readonly string[] | undefined) => widgets.push(content),
      },
    });
    const harnessOne = harness(ctx);
    harnessOne.handlers.get("session_start")?.(undefined as never, ctx);
    const handler = harnessOne.commands.get("ais")?.handler;
    expect(handler).toBeDefined();
    await handler!("", ctx);
    expect(widgets).toHaveLength(1);
    const widget = widgets[0] as readonly string[];
    expect(widget[0]).toContain("ais identity:");
    expect(widget[0]).toContain("anthropic/claude-sonnet-4-5");
    const joined = widget.join("\n");
    expect(joined).toContain("anthropic");
    expect(joined).toContain("amazon-bedrock: uses the ambient AWS credential chain");
    expect(widget.length).toBeLessThanOrEqual(10);
    expect(joined).toContain("/ais use <provider>[/<model>]");
  });

  test("/ais hides the widget path in non-UI modes and notifies compactly instead", async () => {
    const notes: string[] = [];
    const ctx = context({ hasUI: false, ui: { notify: (message) => notes.push(message), setStatus: () => undefined, setWidget: () => undefined } });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("", ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ais:");
  });

  test("/ais use switches the model through pi.setModel and reports the honest default note", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const ctx = context({
      ui: {
        notify: (message, type) => notes.push([message, type]),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("use zai/glm-4.6", ctx);
    expect(harnessOne.setModelCalls).toEqual([glm]);
    expect(notes[0]?.[0]).toContain("switched to zai/glm-4.6");
    expect(notes[0]?.[0]).toContain("new sessions still start on the identity's configured default");
    expect(ctx.model).toEqual(glm);
  });

  test("/ais use with a provider only picks the first catalogue model; a refusal surfaces the real reason", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const ctx = context({
      ui: {
        notify: (message, type) => notes.push([message, type]),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("use anthropic", ctx);
    expect(harnessOne.setModelCalls).toEqual([sonnet]);

    harnessOne.setModelResultSetter(false);
    await harnessOne.commands.get("ais")?.handler("use zai", ctx);
    expect(notes.at(-1)?.[0]).toContain("no authentication configured");
    expect(notes.at(-1)?.[1]).toBe("error");
  });

  test("/ais use explains unknown providers and models", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const ctx = context({
      ui: {
        notify: (message, type) => notes.push([message, type]),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("use nope", ctx);
    expect(notes[0]?.[1]).toBe("error");
    expect(notes[0]?.[0]).toContain("no models for provider");
  });

  test("/ais identities lists launch commands and the honest relaunch note", async () => {
    const widgets: Array<readonly string[] | undefined> = [];
    const ctx = context({
      ui: {
        notify: () => undefined,
        setStatus: () => undefined,
        setWidget: (_key: string | undefined, content: readonly string[] | undefined) => widgets.push(content),
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("identities", ctx);
    const widget = widgets[0] as readonly string[];
    const joined = widget.join("\n");
    expect(joined).toContain("requires a relaunch");
    expect(widget.length).toBeLessThanOrEqual(10);
    expect(joined).toContain("ais pi --identity=identity-b");
  });

  test("unknown /ais arguments warn instead of doing nothing", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const ctx = context({
      ui: {
        notify: (message, type) => notes.push([message, type]),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("frobnicate", ctx);
    expect(notes[0]?.[1]).toBe("warning");
  });

  test("the status line follows model_select and session_start", async () => {
    const statuses: string[] = [];
    const ctx = context({
      ui: {
        notify: () => undefined,
        setStatus: (_key, text) => {
          if (text !== undefined) statuses.push(text);
        },
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    harnessOne.handlers.get("session_start")?.(undefined as never, ctx);
    harnessOne.handlers.get("model_select")?.({ model: glm } as never, ctx);
    expect(statuses.at(-1)).toContain("zai/glm-4.6");
  });
});

describe("jiti loadability", () => {
  test("the extension source transpiles cleanly (pi loads extensions via jiti)", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const source = embeddedExtensionSourceText();
    expect(() => transpiler.transformSync(source)).not.toThrow();
    expect(transpiler.transformSync(source)).toContain("aisIdentityExtension");
  });
});

describe("credential honesty on switch", () => {
  test("a switch pi accepts without a stored credential carries the honest may-still-fail note", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const localKimi: AiModel = { id: "kimi-k2.6", provider: "local-kimi" };
    const reg = {
      ...registry([sonnet, localKimi]),
      hasConfiguredAuth: (model: AiModel) => model.provider !== "local-kimi",
    };
    const ctx = context({
      modelRegistry: reg,
      ui: {
        notify: (message, type) => notes.push([message, type]),
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    });
    const harnessOne = harness(ctx);
    await harnessOne.commands.get("ais")?.handler("use local-kimi", ctx);
    expect(harnessOne.setModelCalls).toEqual([localKimi]);
    expect(notes[0]?.[0]).toContain("switched to local-kimi/kimi-k2.6");
    expect(notes[0]?.[0]).toContain("auth.json holds no credential for this provider");
  });
});
