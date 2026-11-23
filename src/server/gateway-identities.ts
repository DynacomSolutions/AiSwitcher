import { basename, dirname } from "node:path";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { HttpHomeStore, StoreApiError } from "../gateway/home-store-http.ts";
import type { HomeFileMeta, HomeStoreClient } from "../gateway/home-store.ts";
import { hostStoreConfig } from "../gateway/host-sync.ts";
import { isValidIdentityKey } from "../identities/match.ts";
import { isRetired } from "../identities/retired.ts";
import { findIdentityByNameOrAlias, parseIdentitiesFile } from "../identities/store.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import type { Identity } from "../identities/types.ts";
import { gatewayAdminConfig, type GatewayAppsDeps } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

/**
 * Adds a login slot (an identity) through the gateway credential store. The console never writes a host identity file or
 * a host login file: it reads the tool's registry row from the store over the gateway admin API, adds the entry, and
 * writes the row back with the version check (compare-and-swap). The gateway replicas, and the console pod, pick the new
 * entry up from the store on their own. The user then signs the identity in with the Login button on the Auth page.
 */

export const GATEWAY_IDENTITY_TOOLS = ["claude", "codex"] as const;
export type GatewayIdentityTool = (typeof GATEWAY_IDENTITY_TOOLS)[number];

export interface GatewayIdentityInput {
  name: string;
  label: string;
  description?: string;
  /** Name of an existing swap pool of the tool; the new identity joins its members. */
  pool?: string;
}

export interface GatewayIdentityAddResult {
  tool: GatewayIdentityTool;
  identity: Identity;
  /** The pool the identity joined, when one was asked for. */
  pool?: string;
  /** Row version after the write. */
  registryVersion: number;
}

export interface GatewayIdentitiesDeps extends Pick<GatewayAppsDeps, "admin" | "secretsPath" | "fetch"> {
  /** Tests: a store client instead of the one made from the admin address and the store key. */
  store?: Pick<HomeStoreClient, "list" | "get" | "put" | "close">;
}

const LABEL_MAX = 80;
const DESCRIPTION_MAX = 200;

const isTool = (v: string): v is GatewayIdentityTool => (GATEWAY_IDENTITY_TOOLS as readonly string[]).includes(v);

/** Validates the request body. Throws HttpError 400 with a short reason. */
export function parseGatewayIdentityInput(raw: unknown): GatewayIdentityInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HttpError(400, "body must be a JSON object");
  const r = raw as Record<string, unknown>;
  const text = (field: string, max: number, required: boolean): string | undefined => {
    const v = r[field];
    if (v === undefined || v === null || v === "") {
      if (required) throw new HttpError(400, `"${field}" must not be empty`);
      return undefined;
    }
    if (typeof v !== "string") throw new HttpError(400, `"${field}" must be a string`);
    const t = v.trim();
    if (t === "") {
      if (required) throw new HttpError(400, `"${field}" must not be empty`);
      return undefined;
    }
    if (t.length > max) throw new HttpError(400, `"${field}" must be at most ${max} characters`);
    return t;
  };
  const name = text("name", 64, true)!;
  if (!isValidIdentityKey(name)) throw new HttpError(400, `Invalid name "${name}": use lowercase letters, digits and single hyphens only (e.g. identity-a)`);
  const label = text("label", LABEL_MAX, true)!;
  const description = text("description", DESCRIPTION_MAX, false);
  const pool = text("pool", 64, false);
  return { name, label, ...(description ? { description } : {}), ...(pool ? { pool } : {}) };
}

/** The store path of a tool's registry, as the host mirror writes it (home-relative). */
const registryRowPattern = (tool: GatewayIdentityTool): RegExp => {
  const dir = basename(dirname(TOOL_CONFIGS[tool].identitiesJsonPath));
  return new RegExp(`(^|/)${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/identities\\.json$`);
};

/** Replaces the last path segment equal to `from` with `to`; undefined when no segment matches. */
function deriveConfigDir(configDir: string, from: string, to: string): string | undefined {
  const parts = configDir.split("/");
  const at = parts.lastIndexOf(from);
  if (at < 0) return undefined;
  parts[at] = to;
  return parts.join("/");
}

async function openStore(tool: GatewayIdentityTool, deps: GatewayIdentitiesDeps): Promise<{ store: NonNullable<GatewayIdentitiesDeps["store"]>; own: boolean }> {
  if (deps.store) return { store: deps.store, own: false };
  const admin = await gatewayAdminConfig(deps).catch(() => undefined);
  if (!admin) throw new HttpError(503, "gateway admin is not configured on this console");
  let key: Buffer | undefined;
  try {
    key = (await hostStoreConfig(process.env, deps.secretsPath))?.key;
  } catch {
    key = undefined;
  }
  if (!key) throw new HttpError(503, `gateway store key is not configured on this console, so the ${tool} registry cannot be changed`);
  return { store: new HttpHomeStore({ url: admin.url, token: admin.token, key, ...(deps.fetch ? { fetch: deps.fetch } : {}), warn: () => {} }), own: true };
}

/**
 * Adds an identity to the gateway store's registry of `tool`. With `pool` it copies the shape of that pool's existing
 * members (config folder pattern, Codex sign-in method) and joins the pool's member list; without it, it copies the
 * first other identity of the tool. Errors: 400 bad input, 404 no such pool, 409 name taken or the row changed under
 * the write (retry), 502 gateway store failed, 503 the console has no gateway admin or store key.
 */
export async function addGatewayIdentity(toolRaw: string, raw: unknown, deps: GatewayIdentitiesDeps = {}): Promise<GatewayIdentityAddResult> {
  if (!isTool(toolRaw)) throw new HttpError(400, `identities can be added for ${GATEWAY_IDENTITY_TOOLS.join(" and ")} only`);
  const tool = toolRaw;
  const input = parseGatewayIdentityInput(raw);
  const { store, own } = await openStore(tool, deps);
  try {
    let metas: HomeFileMeta[];
    let rows: Awaited<ReturnType<typeof store.get>>;
    const pattern = registryRowPattern(tool);
    try {
      metas = (await store.list(0)).filter((m) => m.kind === "registry" && pattern.test(m.path));
      if (metas.length === 0) throw new HttpError(404, `the gateway store holds no ${tool} registry`);
      rows = await store.get([metas[0]!.path]);
    } catch (e) {
      throw storeFailure(e);
    }
    const meta = metas[0]!;
    const row = rows[0];
    if (!row) throw new HttpError(502, `the gateway store could not read the ${tool} registry`);
    let file: Record<string, unknown>;
    try {
      file = JSON.parse(row.content.toString("utf8")) as Record<string, unknown>;
      parseIdentitiesFile(file);
    } catch {
      throw new HttpError(502, `the ${tool} registry in the gateway store is not valid`);
    }
    const identities = file.identities as Identity[];
    if (findIdentityByNameOrAlias(identities, input.name)) throw new HttpError(409, `"${input.name}" is already an identity name or alias`);

    let pool: Identity | undefined;
    if (input.pool) {
      pool = identities.find((i) => i.name === input.pool);
      if (!pool || !isSwapPool(pool)) throw new HttpError(404, `no pool named "${input.pool}"`);
    }
    // The shape donor: a pool member that still exists, else any other active identity of the tool.
    const members = pool ? new Set(pool.swapPool!.accounts) : undefined;
    const donors = identities.filter((i) => !isSwapPool(i) && !isRetired(i) && (!members || members.has(i.name)));
    const fallback = pool ? undefined : identities.filter((i) => !isSwapPool(i) && !isRetired(i));
    const sample = (members ? donors : fallback)?.[0];
    if (!sample) throw new HttpError(400, pool ? `pool "${pool.name}" has no member to copy the settings from` : `the ${tool} registry has no identity to copy the settings from`);
    const configDir = deriveConfigDir(sample.configDir, sample.name, input.name);
    if (!configDir) throw new HttpError(400, `cannot derive a config folder from "${sample.name}"`);

    const entry: Identity = {
      name: input.name,
      label: input.label,
      ...(input.description ? { description: input.description } : {}),
      configDir,
      ...(tool === "codex" && sample.codexLoginMethod ? { codexLoginMethod: sample.codexLoginMethod } : {}),
    };
    identities.push(entry);
    if (pool && !pool.swapPool!.accounts.includes(input.name)) pool.swapPool!.accounts.push(input.name);

    let put: Awaited<ReturnType<typeof store.put>>;
    try {
      put = await store.put(meta.path, Buffer.from(`${JSON.stringify(file, null, 2)}\n`), { account: meta.account ?? null, kind: "registry", expectedVersion: meta.version });
    } catch (e) {
      throw storeFailure(e);
    }
    if (!put.ok) throw new HttpError(409, "the registry changed while the identity was added; try again");
    return { tool, identity: entry, ...(pool ? { pool: pool.name } : {}), registryVersion: put.version };
  } finally {
    if (own) await store.close().catch(() => undefined);
  }
}

/** Maps a store failure to a console error without leaking the address or a token. */
function storeFailure(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof StoreApiError) return new HttpError(502, `gateway store answered ${e.status}`);
  const message = e instanceof Error ? e.message : String(e);
  return new HttpError(502, message.includes("unreachable") ? "gateway admin unreachable" : "gateway store failed");
}
