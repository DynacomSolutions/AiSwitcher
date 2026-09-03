import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KIMI_CONFIG, PI_CONFIG } from "../../identities/tool-configs.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import type { Identity } from "../../identities/types.ts";
import type { KimiOAuthCredentials } from "./kimi-limits.ts";

/**
 * ONE credential per (identity, provider) — that is the AIS model. The kimi
 * CLI and Pi are third-party binaries with hard-coded private store layouts
 * (kimi: `<configDir>/credentials/kimi-code.json`; pi: one `auth.json`
 * holding every provider), so the single logical token necessarily has more
 * than one physical file. What AIS owns is keeping those files as views of
 * ONE token:
 *
 * - READ: the freshest copy wins (by expires_at), so a store whose
 *   counterpart was refreshed more recently self-heals instead of failing.
 * - WRITE: every refresh is persisted through to ALL of the account's
 *   stores at once, so the copies converge on the same token instead of
 *   racing.
 *
 * Without this, Kimi's rotate-on-every-refresh behaviour makes whichever
 * store refreshes first invalidate every other copy, stranding them with
 * HTTP 400 at the next expiry (every few days) until manual re-auth —
 * observed live 2026-09-03 on both kimi identities.
 *
 * The same law extends to the other OAuth providers pi holds copies of
 * (anthropic, openai-codex, xai); kimi is where API-driven rotation makes
 * the race an everyday failure, so it is the first wired through this
 * layer.
 */

const NATIVE_FILE_RELPATH = join("credentials", "kimi-code.json");

/** The pi auth.json "kimi-coding" entry: Pi's own OAuth shape (expires in
 * milliseconds), preserved verbatim apart from the three token fields. */
interface PiKimiEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}

interface NativeCredentialsFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  [key: string]: unknown;
}

interface Store {
  kind: "native" | "pi";
  /** credentials file path (native) or auth.json path (pi). */
  path: string;
  read: () => Promise<KimiOAuthCredentials | undefined>;
  write: (next: KimiOAuthCredentials) => Promise<void>;
}

function credentialsFromNative(raw: NativeCredentialsFile | undefined): KimiOAuthCredentials | undefined {
  if (!raw?.access_token) return undefined;
  return {
    access_token: raw.access_token,
    ...(typeof raw.refresh_token === "string" ? { refresh_token: raw.refresh_token } : {}),
    ...(typeof raw.expires_at === "number" ? { expires_at: raw.expires_at } : {}),
  };
}

function credentialsFromPi(raw: PiKimiEntry | undefined): KimiOAuthCredentials | undefined {
  if (raw?.type !== "oauth" || typeof raw.access !== "string") return undefined;
  return {
    access_token: raw.access,
    ...(typeof raw.refresh === "string" ? { refresh_token: raw.refresh } : {}),
    ...(typeof raw.expires === "number" ? { expires_at: Math.floor(raw.expires / 1000) } : {}),
  };
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write-through shared by both stores: temp file in the same
 * directory + rename, mode 0600, so a crash mid-write can't truncate a
 * credentials file. The parent directory is created if missing (a fresh
 * kimi identity may never have run the CLI yet). */
async function writeJsonAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function storeFor(kind: "native" | "pi", path: string): Store {
  if (kind === "native") {
    return {
      kind,
      path,
      read: async () => credentialsFromNative((await readJson(path)) as NativeCredentialsFile | undefined),
      write: async (next) => {
        const raw = (await readJson(path)) as NativeCredentialsFile | undefined;
        await writeJsonAtomic(path, { ...(raw ?? {}), access_token: next.access_token, ...(next.refresh_token ? { refresh_token: next.refresh_token } : {}), ...(next.expires_at !== undefined ? { expires_at: next.expires_at } : {}) });
      },
    };
  }
  return {
    kind: "pi",
    path,
    read: async () => {
      const raw = (await readJson(path)) as Record<string, unknown> | undefined;
      return credentialsFromPi(raw?.["kimi-coding"] as PiKimiEntry | undefined);
    },
    write: async (next) => {
      const raw = (await readJson(path)) as Record<string, unknown> | undefined;
      const entry = (raw?.["kimi-coding"] as PiKimiEntry | undefined) ?? {};
      await writeJsonAtomic(path, {
        ...(raw ?? {}),
        "kimi-coding": {
          ...entry,
          type: "oauth",
          access: next.access_token,
          ...(next.refresh_token ? { refresh: next.refresh_token } : {}),
          ...(next.expires_at !== undefined ? { expires: next.expires_at * 1000 } : {}),
        },
      });
    },
  };
}

async function configDirFor(toolName: "kimi" | "pi", identityName: string): Promise<string | undefined> {
  const config = toolName === "kimi" ? KIMI_CONFIG : PI_CONFIG;
  try {
    const file = await loadIdentitiesFile(config.identitiesJsonPath);
    return findIdentityByNameOrAlias(file.identities, identityName)?.configDir;
  } catch {
    return undefined;
  }
}

/** Every store holding this Kimi account's credentials for the given
 * identity, in a stable order. `self` names the registry the calling
 * identity came from (its own store always exists); the counterpart store
 * is included only when the same-named identity exists in the other
 * registry — the normal case for credentials imported via pi-auth. */
export async function kimiCredentialStores(identity: Identity, self: "kimi" | "pi"): Promise<Store[]> {
  const stores: Store[] = [];
  const nativeDir = self === "kimi" ? identity.configDir : await configDirFor("kimi", identity.name);
  if (nativeDir) stores.push(storeFor("native", join(nativeDir, NATIVE_FILE_RELPATH)));
  const piDir = self === "pi" ? identity.configDir : await configDirFor("pi", identity.name);
  if (piDir) stores.push(storeFor("pi", join(piDir, "auth.json")));
  return stores;
}

/** The freshest readable copy of this account's credentials, or undefined
 * when no store holds a usable access token. */
export async function readFreshestKimiCredentials(identity: Identity, self: "kimi" | "pi"): Promise<KimiOAuthCredentials | undefined> {
  let freshest: KimiOAuthCredentials | undefined;
  for (const store of await kimiCredentialStores(identity, self)) {
    const credentials = await store.read().catch(() => undefined);
    if (!credentials) continue;
    if (
      freshest === undefined ||
      (credentials.expires_at ?? -1) > (freshest.expires_at ?? -1)
    ) {
      freshest = credentials;
    }
  }
  return freshest;
}

/** Write the refreshed credentials through to EVERY store of this account,
 * preserving each store's unknown keys. A store that can't be written is
 * skipped (its copy will simply go stale), never fatal to the refresh. */
export async function persistKimiCredentials(identity: Identity, self: "kimi" | "pi", next: KimiOAuthCredentials): Promise<void> {
  for (const store of await kimiCredentialStores(identity, self)) {
    await store.write(next).catch(() => undefined);
  }
}
