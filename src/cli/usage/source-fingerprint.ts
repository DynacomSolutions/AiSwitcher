import { createHash, type Hash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { UsageTarget } from "./run.ts";

/**
 * Whether a Claude or Codex source changed since its last native export,
 * decided by stat alone.
 *
 * Every export of a source loads that source's whole Tokscale message cache
 * (tens to hundreds of MB), even when nothing changed and Tokscale only
 * answers "unchanged". Those reads are cheap only while the cache files sit
 * in the page cache; once the kernel reclaims them (memory pressure during a
 * host update, a collector restart), each 15-minute export of an idle source
 * becomes real disk reads. A source whose fingerprint equals the one recorded
 * at its last export is not exported again: its committed batch and report
 * are what a fresh export would produce.
 *
 * The fingerprint covers every input of the pinned Tokscale v4.20.0 Claude and
 * Codex parsers (vendor/tokscale): each file under the roots its scanner walks
 * for this source (path, size, mtime, ctime, inode), the exporter binary, its
 * isolated settings and its pricing data. Anything it cannot vouch for (a
 * symlink in a source tree, a configured extra scan path, another tool)
 * returns undefined, which always means "export".
 */

/** Bumped whenever what the fingerprint covers changes; a new value never
 * matches a fingerprint recorded by an older collector. */
const FINGERPRINT_SCHEME = "ais-native-source-fingerprint-v1";

export interface NativeSourceFingerprintEnv {
  /** Home directory the exporter runs with (its default and home-wide roots). */
  home?: string;
  /** Tokscale's headless root override, inherited by the exporter. */
  headlessDir?: string;
  /** The exporter binary. */
  binaryPath: string;
  /** The exporter's isolated config directory (settings.json, pricing cache). */
  configDir: string;
  /** Where digests of the binary and the pricing files are remembered with
   * the stat they were taken at, so a collector cycle (a fresh process) does
   * not re-read 30 MB of binary and 14 MB of pricing each time. */
  digestMemoPath?: string;
}

/** Inputs every source of one cycle shares: the exporter binary, its settings
 * and its pricing data. Undefined when one of them cannot be read. */
export function sharedNativeExportInputs(env: NativeSourceFingerprintEnv): string | undefined {
  const memo = new DigestMemo(env.digestMemoPath);
  try {
    const hash = createHash("sha256").update(`${FINGERPRINT_SCHEME}\0`);
    // A host update installs a rebuilt binary (a new inode) each time;
    // hashing its bytes keeps the fingerprint when the build is the same.
    hash.update(`binary\0${memo.digest(env.binaryPath, (bytes) => bytes)}\0`);
    hash.update(`settings\0${optionalFileSha256(join(env.configDir, "settings.json"))}\0`);
    // Tokscale refreshes its pricing caches hourly and stamps each refresh,
    // so only the data after the leading timestamp counts: unchanged prices
    // keep the fingerprint, changed prices change every source's.
    const cacheDir = join(env.configDir, "cache");
    let names: string[] = [];
    try { names = readdirSync(cacheDir).filter((name) => /^pricing-.*\.json$/.test(name)).sort(); } catch { /* no pricing cache yet */ }
    for (const name of names) hash.update(`pricing\0${name}\0${memo.digest(join(cacheDir, name), withoutPricingStamp)}\0`);
    return hash.digest("hex");
  } catch {
    return undefined;
  } finally {
    memo.save();
  }
}

function withoutPricingStamp(bytes: Buffer): Buffer {
  const prefix = /^\{"timestamp":\d+,/.exec(bytes.subarray(0, 64).toString("latin1"));
  return prefix ? bytes.subarray(prefix[0].length) : bytes;
}

/** The fingerprint of one Claude or Codex source, or undefined when it cannot
 * be decided by stat (then the source is always exported). */
export function nativeSourceFingerprint(
  target: Pick<UsageTarget, "toolName" | "identity">,
  shared: string | undefined,
  env: NativeSourceFingerprintEnv,
): string | undefined {
  if (!shared) return undefined;
  const roots = nativeSourceRoots(target, env);
  if (!roots) return undefined;
  const hash = createHash("sha256").update(`${FINGERPRINT_SCHEME}\0${shared}\0${target.toolName}\0${resolve(target.identity.configDir)}\0`);
  for (const root of roots) {
    hash.update(`root\0${root}\0`);
    if (!walk(hash, root, "")) return undefined;
  }
  return hash.digest("hex");
}

/** The roots Tokscale v4.20.0 scans for this source, or undefined when the
 * source has inputs a stat walk cannot cover. Claude: `<config>/projects`,
 * its sibling `transcripts` and the Claude desktop session stores (no source
 * is decided while `~/.cc-mirror` exists). Codex: `<home>/sessions`, `<home>/archived_sessions` and the
 * headless roots' `codex` directories. Missing roots are covered too: one
 * appearing changes the fingerprint. */
function nativeSourceRoots(target: Pick<UsageTarget, "toolName" | "identity">, env: NativeSourceFingerprintEnv): string[] | undefined {
  const home = env.home ?? homedir();
  const configDir = resolve(target.identity.configDir);
  if (configuredExtraScanPaths(env.configDir, target.toolName)) return undefined;
  if (target.toolName === "claude") {
    // A cc-mirror variant names its config directory in variant.json, which
    // may be anywhere: with any variant present, always export.
    if (pathExists(join(home, ".cc-mirror"))) return undefined;
    return [
      join(configDir, "projects"),
      join(configDir, "transcripts"),
      ...["Library/Application Support/Claude", "AppData/Roaming/Claude", ".config/Claude"].flatMap((app) =>
        ["local-agent-mode-sessions", "claude-code-sessions"].map((name) => join(home, app, name))),
    ];
  }
  if (target.toolName === "codex") {
    const headless = env.headlessDir
      ? [env.headlessDir]
      : [join(home, ".config/tokscale/headless"), join(home, "Library/Application Support/tokscale/headless")];
    return [join(configDir, "sessions"), join(configDir, "archived_sessions"), ...headless.map((root) => join(root, "codex"))];
  }
  return undefined;
}

/** Whether the isolated settings configure extra scan paths for this tool:
 * those can point anywhere, so such a source is always exported. */
function configuredExtraScanPaths(configDir: string, toolName: string): boolean {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
  } catch (error) {
    // No settings file: Tokscale's defaults have no extra paths. Unreadable or invalid: unknown.
    return (error as { code?: string }).code !== "ENOENT";
  }
  const extra = (settings as { scanner?: { extraScanPaths?: Record<string, unknown> } } | null)?.scanner?.extraScanPaths;
  const paths = extra && typeof extra === "object" ? extra[toolName] : undefined;
  return Array.isArray(paths) ? paths.length > 0 : paths !== undefined && paths !== null;
}

/** Hash one tree by stat: every entry's relative path and type, and each
 * file's size, mtime, ctime and inode. A missing root hashes as absent.
 * False on a symlink (Tokscale may follow it to files this walk would not
 * see) or an unreadable entry. */
function walk(hash: Hash, path: string, relative: string): boolean {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") return false;
    hash.update(`absent\0${relative}\0`);
    return true;
  }
  if (info.isSymbolicLink()) return false;
  if (info.isFile()) {
    hash.update(`file\0${relative}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\0`);
    return true;
  }
  if (!info.isDirectory()) {
    hash.update(`other\0${relative}\0`);
    return true;
  }
  let names: string[];
  try {
    names = readdirSync(path).sort();
  } catch {
    return false;
  }
  hash.update(`dir\0${relative}\0${names.length}\0`);
  for (const name of names) {
    if (!walk(hash, join(path, name), relative ? `${relative}/${name}` : name)) return false;
  }
  return true;
}

function statKey(path: string): string {
  const { dev: device, ino, size, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
  return `${device}\0${ino}\0${size}\0${mtimeNs}\0${ctimeNs}`;
}

/** Digests of whole files, remembered with the stat (ctime included, which
 * cannot be set back) they were taken at. A file is hashed again whenever its
 * stat differs; a digest is remembered only when the stat held across the read. */
export class DigestMemo {
  private entries: Record<string, { key: string; sha256: string }> = {};
  private changed = false;

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown; entries?: unknown };
      if (value.schema === 1 && value.entries && typeof value.entries === "object") {
        for (const [file, entry] of Object.entries(value.entries as Record<string, { key?: unknown; sha256?: unknown }>)) {
          if (typeof entry?.key === "string" && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)) {
            this.entries[file] = { key: entry.key, sha256: entry.sha256 };
          }
        }
      }
    } catch { /* nothing remembered yet */ }
  }

  digest(file: string, select: (bytes: Buffer) => Buffer): string {
    const absolute = resolve(file);
    const key = statKey(absolute);
    const known = this.entries[absolute];
    if (known?.key === key) return known.sha256;
    const sha256 = createHash("sha256").update(select(readFileSync(absolute))).digest("hex");
    if (statKey(absolute) === key) {
      this.entries[absolute] = { key, sha256 };
      this.changed = true;
    }
    return sha256;
  }

  save(): void {
    if (!this.path || !this.changed) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, entries: this.entries }), { mode: 0o600 });
      renameSync(temporary, this.path);
      this.changed = false;
    } catch {
      try { unlinkSync(temporary); } catch { /* none written */ }
    }
  }
}

function optionalFileSha256(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "absent";
    throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}
