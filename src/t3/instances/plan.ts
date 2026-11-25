// Maps the live gateway app list to the T3 provider instances that must exist. Pure: no file, no network, no cached list.
// A new app of a known provider gives its instances with no code change. Pattern (the one `src/t3/favourites/mapping.ts` reads):
//   claude, codex: pool `<provider>-pool`, pin `t3-<provider>-<identity>`
//   opencode:      pool `t3-opencode-pool`, pin `t3-opencode-<identity>`
//   grok:          `t3-grok-<x>` and the ACP twin `t3-grok-<x>-acp`
//   kimi, zai:     ACP only, `t3-<provider>-<x>-acp`
// where <x> is `pool` for a pool app and the pinned identity for a pin.

/** The fields of one gateway app (`GET /apps`) that the plan reads. */
export interface GatewayApp {
  name: string;
  provider: string;
  target: { kind: "pool" | "pin"; identity?: string };
  state: string;
}

export type InstanceKind = "claude" | "codex" | "opencode" | "grok" | "acp-grok" | "acp-kimi" | "acp-zai";

export interface PlannedInstance {
  id: string;
  kind: InstanceKind;
  provider: string;
  app: string;
  /** `pool` or the pinned identity. */
  who: string;
}

interface ProviderShape {
  /** Instance kinds with the id suffix each adds. */
  kinds: ReadonlyArray<{ kind: InstanceKind; suffix: string }>;
  /** The `<provider>-pool` form (claude, codex) instead of `t3-<provider>-pool`. */
  barePool?: boolean;
}

const PROVIDERS: Record<string, ProviderShape> = {
  claude: { kinds: [{ kind: "claude", suffix: "" }], barePool: true },
  codex: { kinds: [{ kind: "codex", suffix: "" }], barePool: true },
  opencode: { kinds: [{ kind: "opencode", suffix: "" }] },
  grok: { kinds: [{ kind: "grok", suffix: "" }, { kind: "acp-grok", suffix: "-acp" }] },
  kimi: { kinds: [{ kind: "acp-kimi", suffix: "-acp" }] },
  zai: { kinds: [{ kind: "acp-zai", suffix: "-acp" }] },
};

const baseId = (provider: string, shape: ProviderShape, who: string): string => (who === "pool" && shape.barePool ? `${provider}-pool` : `t3-${provider}-${who}`);

/** Who the app serves, or undefined when it is not a T3 app of a known provider. */
function appWho(app: GatewayApp): string | undefined {
  const shape = PROVIDERS[app.provider];
  if (!shape || app.state !== "active") return undefined;
  const who = app.target.kind === "pool" ? "pool" : app.target.identity;
  if (!who || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(who)) return undefined;
  // These pin names would take the id of another instance (the pool, an ACP twin, a usage twin): no instance is made for them.
  if (app.target.kind === "pin" && (who === "pool" || /-(?:acp|usage)$/.test(who))) return undefined;
  if (app.target.kind === "pool") return app.name === `agents-${app.provider}` || app.name === `t3-${app.provider}-pool` ? who : undefined;
  return app.name.startsWith(`t3-${app.provider}-`) ? who : undefined;
}

/** The instance ids one app owns (empty when it is no T3 app). */
export function instanceIdsForApp(app: GatewayApp): string[] {
  const who = appWho(app);
  const shape = PROVIDERS[app.provider];
  if (!who || !shape) return [];
  return shape.kinds.map((k) => `${baseId(app.provider, shape, who)}${k.suffix}`);
}

/** The instances the live app list asks for. Sorted by id. */
export function planT3Instances(apps: readonly GatewayApp[]): PlannedInstance[] {
  const byId = new Map<string, PlannedInstance>();
  for (const app of apps) {
    const who = appWho(app);
    const shape = PROVIDERS[app.provider];
    if (!who || !shape) continue;
    for (const k of shape.kinds) {
      const id = `${baseId(app.provider, shape, who)}${k.suffix}`;
      const next: PlannedInstance = { id, kind: k.kind, provider: app.provider, app: app.name, who };
      const have = byId.get(id);
      // Two active apps for one instance: the app named after the instance wins, then the first by name.
      const named = (a: string): boolean => a === baseId(app.provider, shape, who) || (who === "pool" && a === `agents-${app.provider}`);
      if (!have || (!named(have.app) && (named(app.name) || app.name < have.app))) byId.set(id, next);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const MANAGED = /^(?:(?:claude|codex)-pool|t3-(?:claude|codex|opencode|grok|kimi|zai)-[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * True for an instance id this tool owns: a pool id or `t3-<provider>-...` of a known provider. Usage-only (`-usage`) and
 * ZCode (`t3-zcode-*`) instances are never owned. A kimi or zai id must end in `-acp` (the sync only makes those).
 */
export function isManagedInstanceId(id: string): boolean {
  if (!MANAGED.test(id) || id.endsWith("-usage")) return false;
  if (/^t3-(?:kimi|zai)-/.test(id)) return id.endsWith("-acp");
  return true;
}

/** The instance ids for a provider and a pool (`who` = "pool") or identity, best first. Empty for an unknown provider. */
export function instanceIdsFor(provider: string, who: string): string[] {
  const shape = PROVIDERS[provider];
  return shape ? shape.kinds.map((k) => `${baseId(provider, shape, who)}${k.suffix}`) : [];
}

/**
 * The provider and the pool or identity an instance id stands for, or undefined for an id that is not a gateway instance.
 * Inverse of `instanceIdsFor`. The Claude homes that route to Kimi or Z.ai models (`t3-claude-kimi-*`, `t3-claude-zai-*`)
 * are retired and map to nothing.
 */
export function parseInstanceId(id: string): { provider: string; who: string } | undefined {
  // Lenient on the identity part (T3 and the favourites accept `+`, `:` and `@`): only the sync's removal rule is strict (`isManagedInstanceId`).
  const known = /^(?:(?:claude|codex)-pool|t3-(?:claude|codex|opencode|grok|kimi|zai)-.+)$/.test(id) && !id.endsWith("-usage") && !(/^t3-(?:kimi|zai)-/.test(id) && !id.endsWith("-acp"));
  if (!known || /^t3-claude-(?:kimi|zai)(?:-|$)/.test(id)) return undefined;
  for (const [provider, shape] of Object.entries(PROVIDERS)) {
    // Longest suffix first, so `t3-grok-x-acp` is the ACP twin of `t3-grok-x`.
    for (const k of [...shape.kinds].sort((a, b) => b.suffix.length - a.suffix.length)) {
      const prefix = shape.barePool && id === `${provider}-pool${k.suffix}` ? `${provider}-` : `t3-${provider}-`;
      if (!id.startsWith(prefix) || !id.endsWith(k.suffix) || id.length <= prefix.length + k.suffix.length) continue;
      return { provider, who: id.slice(prefix.length, id.length - k.suffix.length) };
    }
  }
  return undefined;
}
