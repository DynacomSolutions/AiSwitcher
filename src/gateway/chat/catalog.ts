// The picker catalogue: which identities and pools a provider offers, with their models.
// Identities come from the agent runtime ConfigMap. Models come from the gateway app that serves the identity.
import { CHAT_PROVIDERS, type ChatCatalogProvider, type ChatProvider } from "../../browser/chat-protocol.ts";
import type { GatewayApp } from "../types.ts";
import type { PodTransport } from "./kube.ts";

export const MODELS_UNAVAILABLE = "Models are unavailable. The agent's default will be used.";
/** Efforts known before a pod runs. They are empty until an adapter is shown to expose `thought_level`: the config item after the start lists them. */
export const PRE_START_EFFORTS: Record<ChatProvider, string[]> = { claude: [], codex: [], kimi: [], grok: [], zai: [], opencode: [] };
const MODELS_TTL_MS = 60_000;
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

export class ChatCatalog {
  private readonly cache = new Map<string, { at: number; models: Array<{ id: string; name: string }> }>();

  constructor(private readonly d: ChatCatalogDeps) {}

  /** Throws when the ConfigMap cannot be read. A failing model list never throws: it gives `modelsError`. */
  async get(provider?: ChatProvider): Promise<ChatCatalogProvider[]> {
    const cfg = await this.d.transport.catalog();
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

  private async modelsFor(provider: ChatProvider, name: string, appName: string | undefined): Promise<Array<{ id: string; name: string }>> {
    const key = `${provider}/${name}/${appName ?? ""}`;
    const now = (this.d.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < MODELS_TTL_MS) return hit.models;
    const app = await this.d.appFor(provider, name, appName);
    if (!app || app.state !== "active") throw new Error("no gateway app");
    const models = (await this.d.models(app)).slice(0, MAX_MODELS);
    this.cache.set(key, { at: now, models });
    while (this.cache.size > 500) {
      const k = this.cache.keys().next();
      if (k.done) break;
      this.cache.delete(k.value);
    }
    return models;
  }
}
