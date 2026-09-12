import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
} from "./tool-configs.ts";
import { expandPath } from "./match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "./store.ts";
import type { Identity } from "./types.ts";

/**
 * ONE credential per (identity, provider): the AIS model, generalised
 * beyond kimi (see src/cli/limits/kimi-store.ts for the original law).
 * The native CLIs (claude, codex, grok, kimi) each keep the account's OAuth
 * grant in their own private store, and pi holds an imported copy of the
 * same grant in its auth.json. Left independent, TWO tools refresh ONE
 * grant: whichever refreshes first rotates the refresh token out from
 * under the other copy, whose next refresh then fails; on providers
 * with reuse detection it can even revoke the whole grant and force a
 * re-login of the account everywhere. Observed live 2026-09-12: 8 of 9
 * paired accounts held diverged refresh tokens, pi's copies 10-24 days
 * staler.
 *
 * The reconcile is the coordinated-access boundary AIS actually owns (pi's
 * internal refresh is not hookable): compare every copy of an account,
 * adopt the FRESHEST, and rewrite the staler stores in each store's own
 * shape (units, field names, wrapping). Copies converge instead of racing;
 * pi's entries become live projections of the native stores, not forks.
 */

/** Canonical OAuth grant: all times in SECONDS since the epoch. */
export interface OAuthGrant {
  access_token: string;
  refresh_token?: string;
  /** When the access token expires (seconds). */
  expires_at?: number;
  /** When this copy was minted by a refresh (seconds), from the access
   * token's JWT iat or the store's own refresh timestamp. Primary recency
   * signal where both stores can supply it (codex, xai); the kimi law's
   * expires_at comparison stays the signal where only expiries exist
   * (anthropic, kimi). */
  minted_at?: number;
}

interface StoreCopy {
  side: "native" | "pi";
  path: string;
  grant: OAuthGrant;
  /** grok's multi-account map: the entry this copy was read from. */
  entryKey?: string;
}

/** sha256 prefix (8 hex chars) of the credential that identifies the grant
 * (the refresh token when present, else the access token). NEVER the token
 * itself: fingerprints exist to compare copies, never to display. */
export function grantFingerprint(grant: Pick<OAuthGrant, "refresh_token" | "access_token">): string {
  const basis = grant.refresh_token?.trim() || grant.access_token;
  return createHash("sha256").update(basis).digest("hex").slice(0, 8);
}

function recency(grant: OAuthGrant): number {
  return grant.minted_at ?? grant.expires_at ?? -1;
}

/** Decodes ONLY the iat/exp claims of a JWT access token. Returns {} for
 * opaque tokens (claude's) or malformed input; claims are timestamps,
 * never secrets. */
function jwtTimestamps(token: string): { iat?: number; exp?: number } {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return {};
    const claims = decoded as { iat?: unknown; exp?: unknown };
    return {
      ...(typeof claims.iat === "number" ? { iat: claims.iat } : {}),
      ...(typeof claims.exp === "number" ? { exp: claims.exp } : {}),
    };
  } catch {
    return {};
  }
}

function secondsFromMs(value: number): number {
  return value < 10_000_000_000 ? value : Math.floor(value / 1000);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable or absent store: the reconcile sees "no copy", same as the
    // kimi-store readers.
  }
  return undefined;
}

/** Atomic rewrite, mode 0600, temp file + rename in the destination
 * directory (the kimi-store pattern; a crash mid-write can never truncate
 * a credentials file). */
async function writeJsonAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** One-time safety net before a store's first rewrite in a run: a 0600
 * byte-for-byte copy the user can restore by hand. */
async function backupOnce(path: string, done: Set<string>): Promise<void> {
  if (done.has(path)) return;
  done.add(path);
  try {
    await writeFile(`${path}.ais-bak`, await readFile(path), { mode: 0o600 });
  } catch {
    // No backup is better than aborting the heal: the write itself stays
    // atomic, the backup only guards against a bad freshest pick.
  }
}

function usableToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* Per-store readers/writers. Every read yields the canonical grant or */
/* undefined (no usable copy); every write preserves unknown keys and  */
/* maps the token fields into the store's own shape.                   */
/* ------------------------------------------------------------------ */

interface NativeAnthropicFile {
  claudeAiOauth?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readNativeAnthropic(path: string): Promise<StoreCopy | undefined> {
  const raw = (await readJson(path)) as NativeAnthropicFile | undefined;
  const auth = raw?.claudeAiOauth;
  if (!auth || !usableToken(auth.accessToken)) return undefined;
  return {
    side: "native",
    path,
    grant: {
      access_token: auth.accessToken,
      ...(usableToken(auth.refreshToken) ? { refresh_token: auth.refreshToken } : {}),
      ...(typeof auth.expiresAt === "number" ? { expires_at: secondsFromMs(auth.expiresAt) } : {}),
    },
  };
}

async function writeNativeAnthropic(path: string, grant: OAuthGrant, backups: Set<string>): Promise<void> {
  const raw = ((await readJson(path)) as NativeAnthropicFile | undefined) ?? {};
  const auth = (raw.claudeAiOauth && typeof raw.claudeAiOauth === "object" ? raw.claudeAiOauth : {}) as Record<string, unknown>;
  await backupOnce(path, backups);
  await writeJsonAtomic(path, {
    ...raw,
    claudeAiOauth: {
      ...auth,
      accessToken: grant.access_token,
      ...(grant.refresh_token ? { refreshToken: grant.refresh_token } : {}),
      // refreshTokenExpiresAt has no counterpart in pi's shape; preserving
      // the old value is conservative (claude re-mints it on its own next
      // refresh).
      ...(grant.expires_at !== undefined ? { expiresAt: grant.expires_at * 1000 } : {}),
    },
  });
}

async function readPiEntry(path: string, provider: string): Promise<StoreCopy | undefined> {
  const raw = await readJson(path);
  const entry = raw?.[provider] as { type?: unknown; access?: unknown; refresh?: unknown; expires?: unknown } | undefined;
  if (entry?.type !== "oauth" || !usableToken(entry.access)) return undefined;
  const jwt = jwtTimestamps(entry.access);
  return {
    side: "pi",
    path,
    grant: {
      access_token: entry.access,
      ...(usableToken(entry.refresh) ? { refresh_token: entry.refresh } : {}),
      ...(typeof entry.expires === "number" ? { expires_at: secondsFromMs(entry.expires) } : {}),
      ...(jwt.iat !== undefined ? { minted_at: jwt.iat } : {}),
    },
  };
}

async function writePiEntry(path: string, provider: string, grant: OAuthGrant, backups: Set<string>): Promise<void> {
  const raw = (await readJson(path)) ?? {};
  const entry = (raw[provider] && typeof raw[provider] === "object" ? (raw[provider] as Record<string, unknown>) : {});
  await backupOnce(path, backups);
  await writeJsonAtomic(path, {
    ...raw,
    [provider]: {
      ...entry,
      type: "oauth",
      access: grant.access_token,
      ...(grant.refresh_token ? { refresh: grant.refresh_token } : {}),
      ...(grant.expires_at !== undefined ? { expires: grant.expires_at * 1000 } : {}),
    },
  });
}

interface NativeCodexFile {
  tokens?: Record<string, unknown>;
  last_refresh?: unknown;
  [key: string]: unknown;
}

async function readNativeCodex(path: string): Promise<StoreCopy | undefined> {
  const raw = (await readJson(path)) as NativeCodexFile | undefined;
  const tokens = raw?.tokens;
  if (!tokens || !usableToken(tokens.access_token)) return undefined;
  const jwt = jwtTimestamps(tokens.access_token);
  const lastRefresh = typeof raw.last_refresh === "string" ? Date.parse(raw.last_refresh) / 1000 : NaN;
  return {
    side: "native",
    path,
    grant: {
      access_token: tokens.access_token,
      ...(usableToken(tokens.refresh_token) ? { refresh_token: tokens.refresh_token } : {}),
      ...(jwt.exp !== undefined ? { expires_at: jwt.exp } : {}),
      ...(jwt.iat !== undefined || Number.isFinite(lastRefresh)
        ? { minted_at: jwt.iat ?? lastRefresh }
        : {}),
    },
  };
}

async function writeNativeCodex(path: string, grant: OAuthGrant, backups: Set<string>): Promise<void> {
  const raw = ((await readJson(path)) as NativeCodexFile | undefined) ?? {};
  const tokens = (raw.tokens && typeof raw.tokens === "object" ? raw.tokens : {}) as Record<string, unknown>;
  await backupOnce(path, backups);
  await writeJsonAtomic(path, {
    ...raw,
    tokens: {
      ...tokens,
      access_token: grant.access_token,
      ...(grant.refresh_token ? { refresh_token: grant.refresh_token } : {}),
    },
    // Keep codex's own bookkeeping truthful about whose refresh won.
    ...(grant.minted_at !== undefined ? { last_refresh: new Date(grant.minted_at * 1000).toISOString() } : {}),
  });
}

/** The grok store holds one entry per account (keyed by issuer + principal).
 * The account of interest is the entry matching the counterpart copy's
 * fingerprint; with no counterpart to match, the freshest expires_at wins
 * (the same selection pi-auth's importer makes). */
function grokEntryKey(raw: Record<string, unknown>, matchFingerprint?: string): string | undefined {
  let freshest: { key: string; at: number } | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!usableToken(entry.refresh_token)) continue;
    if (matchFingerprint !== undefined && grantFingerprint({ access_token: String(entry.key ?? ""), refresh_token: entry.refresh_token }) === matchFingerprint) {
      return key;
    }
    const at =
      typeof entry.expires_at === "number"
        ? secondsFromMs(entry.expires_at)
        : typeof entry.expires_at === "string"
          ? Date.parse(entry.expires_at) / 1000
          : -1;
    if (freshest === undefined || at > freshest.at) freshest = { key, at };
  }
  return freshest?.key;
}

async function readNativeGrok(path: string, matchFingerprint?: string): Promise<StoreCopy | undefined> {
  const raw = await readJson(path);
  if (!raw) return undefined;
  const key = grokEntryKey(raw, matchFingerprint);
  if (key === undefined) return undefined;
  const entry = raw[key] as Record<string, unknown>;
  if (!usableToken(entry.key)) return undefined;
  const jwt = jwtTimestamps(entry.key);
  const parsedExpiry =
    typeof entry.expires_at === "number"
      ? secondsFromMs(entry.expires_at)
      : typeof entry.expires_at === "string"
        ? Date.parse(entry.expires_at) / 1000
        : NaN;
  return {
    side: "native",
    path,
    entryKey: key,
    grant: {
      access_token: entry.key,
      ...(usableToken(entry.refresh_token) ? { refresh_token: entry.refresh_token } : {}),
      ...(Number.isFinite(parsedExpiry) ? { expires_at: parsedExpiry } : {}),
      ...(jwt.iat !== undefined ? { minted_at: jwt.iat } : {}),
    },
  };
}

async function writeNativeGrok(path: string, entryKey: string, grant: OAuthGrant, backups: Set<string>): Promise<void> {
  const raw = (await readJson(path)) ?? {};
  const entry = (raw[entryKey] && typeof raw[entryKey] === "object" ? (raw[entryKey] as Record<string, unknown>) : {});
  await backupOnce(path, backups);
  await writeJsonAtomic(path, {
    ...raw,
    // Sibling account entries are preserved untouched.
    [entryKey]: {
      ...entry,
      key: grant.access_token,
      ...(grant.refresh_token ? { refresh_token: grant.refresh_token } : {}),
      ...(grant.expires_at !== undefined
        ? {
            expires_at:
              typeof entry.expires_at === "string"
                ? new Date(grant.expires_at * 1000).toISOString()
                : grant.expires_at,
          }
        : {}),
    },
  });
}

async function readNativeKimi(path: string): Promise<StoreCopy | undefined> {
  const raw = await readJson(path);
  if (!raw || !usableToken(raw.access_token)) return undefined;
  return {
    side: "native",
    path,
    grant: {
      access_token: raw.access_token,
      ...(usableToken(raw.refresh_token) ? { refresh_token: raw.refresh_token } : {}),
      ...(typeof raw.expires_at === "number" ? { expires_at: raw.expires_at } : {}),
    },
  };
}

async function writeNativeKimi(path: string, grant: OAuthGrant, backups: Set<string>): Promise<void> {
  const raw = (await readJson(path)) ?? {};
  await backupOnce(path, backups);
  await writeJsonAtomic(path, {
    ...raw,
    access_token: grant.access_token,
    ...(grant.refresh_token ? { refresh_token: grant.refresh_token } : {}),
    ...(grant.expires_at !== undefined ? { expires_at: grant.expires_at } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Pairing: the pi identity's four projected providers against the     */
/* same-named identities in the native registries (the kimi law's      */
/* same-named-identity rule, no flags and no single-registry guesses). */
/* ------------------------------------------------------------------ */

interface ProviderPairing {
  provider: string;
  readNative: () => Promise<StoreCopy | undefined>;
  /** `native` is the copy this run scanned (grok needs its entryKey to
   * rewrite the right account entry: after a rotation the fresh refresh
   * token matches no fingerprint in the native store). */
  writeNative: (native: StoreCopy, grant: OAuthGrant, backups: Set<string>) => Promise<void>;
  readPi: () => Promise<StoreCopy | undefined>;
  writePi: (grant: OAuthGrant, backups: Set<string>) => Promise<void>;
}

async function configDirFor(identitiesJsonPath: string, identityName: string): Promise<string | undefined> {
  try {
    const file = await loadIdentitiesFile(identitiesJsonPath);
    const identity = findIdentityByNameOrAlias(file.identities, identityName);
    return identity ? expandPath(identity.configDir) : undefined;
  } catch {
    return undefined;
  }
}

/** The four projected providers and their native counterpart stores for one
 * pi identity. A provider pairs only when the SAME-NAMED identity exists in
 * the native registry (never guess a source). */
async function providerPairings(piIdentity: Identity): Promise<ProviderPairing[]> {
  const piAuthPath = join(expandPath(piIdentity.configDir), "auth.json");
  const [claudeDir, codexDir, grokDir, kimiDir] = await Promise.all([
    configDirFor(CLAUDE_CONFIG.identitiesJsonPath, piIdentity.name),
    configDirFor(CODEX_CONFIG.identitiesJsonPath, piIdentity.name),
    configDirFor(GROK_CONFIG.identitiesJsonPath, piIdentity.name),
    configDirFor(KIMI_CONFIG.identitiesJsonPath, piIdentity.name),
  ]);
  const pairings: ProviderPairing[] = [];
  if (claudeDir) {
    const nativePath = join(claudeDir, ".credentials.json");
    pairings.push({
      provider: "anthropic",
      readNative: () => readNativeAnthropic(nativePath),
      writeNative: (native, grant, backups) => writeNativeAnthropic(native.path, grant, backups),
      readPi: () => readPiEntry(piAuthPath, "anthropic"),
      writePi: (grant, backups) => writePiEntry(piAuthPath, "anthropic", grant, backups),
    });
  }
  if (codexDir) {
    const nativePath = join(codexDir, "auth.json");
    pairings.push({
      provider: "openai-codex",
      readNative: () => readNativeCodex(nativePath),
      writeNative: (native, grant, backups) => writeNativeCodex(native.path, grant, backups),
      readPi: () => readPiEntry(piAuthPath, "openai-codex"),
      writePi: (grant, backups) => writePiEntry(piAuthPath, "openai-codex", grant, backups),
    });
  }
  if (grokDir) {
    const nativePath = join(grokDir, "auth.json");
    // grok's store holds one entry per account: scan time picks the entry
    // whose refresh token matches pi's copy (same account), falling back to
    // grok's own freshest entry; the write reuses that resolved entry.
    const xaiFingerprint = async (): Promise<string | undefined> => {
      const pi = await readPiEntry(piAuthPath, "xai");
      return pi ? grantFingerprint(pi.grant) : undefined;
    };
    pairings.push({
      provider: "xai",
      readNative: async () => readNativeGrok(nativePath, await xaiFingerprint()),
      writeNative: (native, grant, backups) => {
        if (native.entryKey === undefined) throw new Error("no matching grok account entry to rewrite");
        return writeNativeGrok(native.path, native.entryKey, grant, backups);
      },
      readPi: () => readPiEntry(piAuthPath, "xai"),
      writePi: (grant, backups) => writePiEntry(piAuthPath, "xai", grant, backups),
    });
  }
  if (kimiDir) {
    const nativePath = join(kimiDir, "credentials", "kimi-code.json");
    pairings.push({
      provider: "kimi-coding",
      readNative: () => readNativeKimi(nativePath),
      writeNative: (native, grant, backups) => writeNativeKimi(native.path, grant, backups),
      readPi: () => readPiEntry(piAuthPath, "kimi-coding"),
      writePi: (grant, backups) => writePiEntry(piAuthPath, "kimi-coding", grant, backups),
    });
  }
  return pairings;
}

export interface OAuthReconcileEntry {
  provider: string;
  nativePath?: string;
  piPath?: string;
  nativeFingerprint?: string;
  piFingerprint?: string;
  /** Minutes the staler copy trails the freshest (absent when neither side
   * carries a comparable timestamp). */
  divergenceMinutes?: number;
  status:
    | "in-sync"
    | "forked"
    | "single-copy"
    | "unreadable"
    | "rewrote-native"
    | "rewrote-pi"
    | "failed";
  /** Which store's copy was adopted when the pair diverged. */
  adoptedFrom?: "native" | "pi";
  detail?: string;
}

export interface OAuthReconcileReport {
  identity: string;
  entries: OAuthReconcileEntry[];
  /** Pairs actually rewritten (0 in read-only mode). */
  healed: number;
}

function minutesBetween(a: OAuthGrant, b: OAuthGrant): number | undefined {
  const fresher = recency(a) >= recency(b) ? a : b;
  const staler = recency(a) >= recency(b) ? b : a;
  const stamp = (grant: OAuthGrant): number | undefined => grant.minted_at ?? grant.expires_at;
  const newest = stamp(fresher);
  const oldest = stamp(staler);
  if (newest === undefined || oldest === undefined) return undefined;
  // Stamps are seconds; minutes = delta / 60.
  return Math.round(((newest - oldest) / 60) * 10) / 10;
}

/** Human drift for reports: minutes under an hour, hours under a day, then
 * days (the fork windows this law heals are measured in days). */
function driftLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round((minutes / 60) * 10) / 10}h`;
  return `${Math.round((minutes / 1440) * 10) / 10}d`;
}

/**
 * Reconcile every projected OAuth provider of one pi identity against its
 * native counterpart stores. With `write` (default false) the freshest copy
 * is adopted and the staler store rewritten in its own shape; without it the
 * run only reports (dry-run and the doctor's probe). A failing store is
 * reported, never fatal to the run or the caller: the next reconcile heals
 * it.
 */
export async function reconcilePiOAuthStores(
  piIdentity: Identity,
  options: { write?: boolean } = {},
): Promise<OAuthReconcileReport> {
  const write = options.write ?? false;
  const entries: OAuthReconcileEntry[] = [];
  let healed = 0;
  const backups = new Set<string>();
  for (const pairing of await providerPairings(piIdentity)) {
    const entry: OAuthReconcileEntry = { provider: pairing.provider, status: "unreadable" };
    try {
      const [native, pi] = await Promise.all([pairing.readNative(), pairing.readPi()]);
      entry.nativePath = native?.path;
      entry.piPath = pi?.path;
      entry.nativeFingerprint = native ? grantFingerprint(native.grant) : undefined;
      entry.piFingerprint = pi ? grantFingerprint(pi.grant) : undefined;
      if (!native && !pi) {
        entry.status = "unreadable";
        entry.detail = "no copy in either store";
      } else if (!native || !pi) {
        entry.status = "single-copy";
        entry.detail = `only the ${native ? "native" : "pi"} store holds a copy; nothing to reconcile`;
      } else if (entry.nativeFingerprint === entry.piFingerprint) {
        entry.status = "in-sync";
        entry.divergenceMinutes = minutesBetween(native.grant, pi.grant);
      } else {
        entry.status = "forked";
        entry.divergenceMinutes = minutesBetween(native.grant, pi.grant);
        const nativeFresher = recency(native.grant) >= recency(pi.grant);
        entry.adoptedFrom = nativeFresher ? "native" : "pi";
        if (write) {
          try {
            if (nativeFresher) {
              await pairing.writePi(native.grant, backups);
              entry.status = "rewrote-pi";
            } else {
              await pairing.writeNative(native, pi.grant, backups);
              entry.status = "rewrote-native";
            }
            healed += 1;
          } catch (error) {
            entry.status = "failed";
            entry.detail = error instanceof Error ? error.message : String(error);
          }
        }
      }
    } catch (error) {
      entry.status = "failed";
      entry.detail = error instanceof Error ? error.message : String(error);
    }
    entries.push(entry);
  }
  return { identity: piIdentity.name, entries, healed };
}

/** Human-readable reconcile lines (fingerprints and minute deltas only,
 * never token values). */
export function renderOAuthReconcileReport(report: OAuthReconcileReport): string[] {
  const lines: string[] = [];
  for (const entry of report.entries) {
    const copies: string[] = [];
    if (entry.nativeFingerprint !== undefined) copies.push(`native ${entry.nativeFingerprint}`);
    if (entry.piFingerprint !== undefined) copies.push(`pi ${entry.piFingerprint}`);
    const copiesText = copies.length > 0 ? ` (${copies.join(", ")})` : "";
    const drift =
      entry.divergenceMinutes !== undefined && entry.status !== "in-sync"
        ? ` ${driftLabel(entry.divergenceMinutes)} between copies`
        : "";
    switch (entry.status) {
      case "in-sync":
        lines.push(`${entry.provider}: copies in sync${copiesText}`);
        break;
      case "forked":
        lines.push(
          `${entry.provider}: DIVERGED copies${copiesText},${drift} freshest = ${entry.adoptedFrom ?? "?"}; ` +
            "dry run only, rerun with writes to heal",
        );
        break;
      case "rewrote-pi":
        lines.push(`${entry.provider}: healed - adopted ${entry.adoptedFrom} copy into pi's auth.json${copiesText}`);
        break;
      case "rewrote-native":
        lines.push(`${entry.provider}: healed - adopted ${entry.adoptedFrom} copy into the native store${copiesText}`);
        break;
      case "single-copy":
        lines.push(`${entry.provider}: ${entry.detail ?? "single copy"}`);
        break;
      case "unreadable":
        lines.push(`${entry.provider}: no readable copy in either store`);
        break;
      case "failed":
        lines.push(`${entry.provider}: reconcile FAILED: ${entry.detail ?? "unknown error"} (next run retries)`);
        break;
    }
  }
  return lines;
}

/** The pi wrapper's cheap launch self-heal: resolve the launched configDir
 * to a registered pi identity, reconcile its four projected providers, and
 * never let a failure block the launch (one stderr line on a heal, one on
 * an unexpected error, silence when everything is already in sync). */
export async function reconcilePiConfigDirOnLaunch(
  configDir: string,
  deps: { warn?: (message: string) => void } = {},
): Promise<void> {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  try {
    const file = await loadIdentitiesFile(PI_CONFIG.identitiesJsonPath);
    const target = expandPath(configDir);
    const piIdentity = file.identities.find((identity) => expandPath(identity.configDir) === target);
    if (!piIdentity) return;
    const report = await reconcilePiOAuthStores(piIdentity, { write: true });
    const healed = report.entries.filter((entry) => entry.status === "rewrote-native" || entry.status === "rewrote-pi");
    if (healed.length > 0) {
      warn(
        `pi: reconciled diverged OAuth credential copies for ${healed.map((entry) => entry.provider).join(", ")} ` +
          `(freshest copy adopted; see src/identities/oauth-reconcile.ts)`,
      );
    }
  } catch (error) {
    warn(
      `pi: OAuth credential reconcile skipped: ${error instanceof Error ? error.message : String(error)} ` +
        "(continuing; the next launch or `ais auth sync --tool=pi` heals)",
    );
  }
}
