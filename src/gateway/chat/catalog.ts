// The picker catalogue: which identities and pools a provider offers, with their models.
// Identities come from the agent runtime ConfigMap. Models come from the gateway app that serves the identity.
import { CHAT_PROVIDERS, type ChatCatalogProvider, type ChatProvider } from "../../browser/chat-protocol.ts";
import type { GatewayApp } from "../types.ts";
import type { AgentRuntimeConfig, PodTransport } from "./kube.ts";

export const MODELS_UNAVAILABLE = "Models are unavailable. The agent's default will be used.";
/** Efforts known before a pod runs. They are empty until an adapter is shown to expose `thought_level`: the config item after the start lists them. */
export const PRE_START_EFFORTS: Record<ChatProvider, string[]> = { claude: [], codex: [], kimi: [], grok: [], zai: [], opencode: [] };
/** A good model list is kept 5 minutes, a failed one 30 seconds, and the ConfigMap 30 seconds. */
const MODELS_OK_TTL_MS = 300_000;
const MODELS_FAIL_TTL_MS = 30_000;
const CONFIG_TTL_MS = 30_000;
const MAX_IDENTITIES = 200;
const MAX_MODELS = 1000;

export interface ChatCatalogDeps {
  transport: Pick<PodTransport, "catalog">;
  /** The gateway app that serves an identity. `appName` is the ConfigMap's `identityApps[identity]`, else its `app`. */
  appFor(provider: ChatProvider, identity: string, appName?: string): Promise<GatewayApp | undefined>;
  models(app: GatewayApp): Promise<Array<{ id: string; name: string }>>;
  isPool(name: string): Promise<boolean>;
  now?: () => number;
}

type CatalogIdentity = ChatCatalogProvider["identities"][number];
type Models = Array<{ id: string; name: string }>;
/** `identity`: the pair is not in the ConfigMap. `model`: the identity has a model list and the model is not in it. */
export type SelectionCheck = "ok" | "identity" | "model";

export class ChatCatalog {
  private readonly cache = new Map<string, { at: number; models: Models; failed: boolean }>();
  private cfg: { at: number; value: AgentRuntimeConfig } | undefined;
  private cfgFlight: Promise<AgentRuntimeConfig> | undefined;
  /** One get per provider at a time. Later callers wait for it. */
  private readonly flights = new Map<string, Promise<ChatCatalogProvider[]>>();

  constructor(private readonly d: ChatCatalogDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** The ConfigMap, read at most once in 30 seconds. A failed read is not kept. */
  private config(): Promise<AgentRuntimeConfig> {
    if (this.cfg && this.now() - this.cfg.at < CONFIG_TTL_MS) return Promise.resolve(this.cfg.value);
    this.cfgFlight ??= this.d.transport
      .catalog()
      .then((value) => {
        this.cfg = { at: this.now(), value };
        return value;
      })
      .finally(() => {
        this.cfgFlight = undefined;
      });
    return this.cfgFlight;
  }

  /** Throws when the ConfigMap cannot be read. A failing model list never throws: it gives `modelsError`. */
  get(provider?: ChatProvider): Promise<ChatCatalogProvider[]> {
    const key = provider ?? "*";
    let f = this.flights.get(key);
    if (!f) {
      f = this.load(provider).finally(() => this.flights.delete(key));
      this.flights.set(key, f);
    }
    return f;
  }

  /** Is this provider and identity listed, and is the model in the identity's list (when that list is not empty)? Throws when the ConfigMap cannot be read. */
  async check(provider: ChatProvider, identity: string, model?: string): Promise<SelectionCheck> {
    const pc = (await this.config()).providers?.[provider];
    if (!pc?.identities?.includes(identity)) return "identity";
    if (model === undefined) return "ok";
    const i = await this.identity(provider, identity, pc.identityApps?.[identity] ?? pc.app);
    return i.models.length > 0 && !i.models.some((m) => m.id === model) ? "model" : "ok";
  }

  private async load(provider?: ChatProvider): Promise<ChatCatalogProvider[]> {
    const cfg = await this.config();
    const out: ChatCatalogProvider[] = [];
    for (const p of CHAT_PROVIDERS) {
      if (provider !== undefined && p !== provider) continue;
      const pc = cfg.providers?.[p];
      if (!pc) continue;
      const names = (pc.identities ?? []).filter((n): n is string => typeof n === "string" && n !== "").slice(0, MAX_IDENTITIES);
      const identities = await Promise.all(names.map((n) => this.identity(p, n, pc.identityApps?.[n] ?? pc.app)));
      out.push({ provider: p, identities, efforts: [...PRE_START_EFFORTS[p]] });
    }
    return out;
  }

  private async identity(provider: ChatProvider, name: string, appName: string | undefined): Promise<CatalogIdentity> {
    const kind = await this.d.isPool(name).then((pool) => (pool ? ("pool" as const) : ("identity" as const)), () => "identity" as const);
    try {
      const models = await this.modelsFor(provider, name, appName);
      return { name, kind, models };
    } catch {
      return { name, kind, models: [], modelsError: MODELS_UNAVAILABLE };
    }
  }

  private async modelsFor(provider: ChatProvider, name: string, appName: string | undefined): Promise<Models> {
    const key = `${provider}/${name}/${appName ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (hit.failed ? MODELS_FAIL_TTL_MS : MODELS_OK_TTL_MS)) {
      if (hit.failed) throw new Error("model list failed");
      return hit.models;
    }
    let models: Models;
    try {
      const app = await this.d.appFor(provider, name, appName);
      if (!app || app.state !== "active") throw new Error("no gateway app");
      models = (await this.d.models(app)).slice(0, MAX_MODELS);
    } catch (e) {
      this.keep(key, { at: this.now(), models: [], failed: true });
      throw e;
    }
    this.keep(key, { at: this.now(), models, failed: false });
    return models;
  }

  private keep(key: string, v: { at: number; models: Models; failed: boolean }): void {
    this.cache.delete(key);
    this.cache.set(key, v);
    while (this.cache.size > 500) {
      const k = this.cache.keys().next();
      if (k.done) break;
      this.cache.delete(k.value);
    }
  }
}
