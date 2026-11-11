// Native messaging helper for the AIS Browser extension. Chrome extensions cannot write their own files, so the
// extension asks this helper (started by Chrome over stdio) for the latest release and to replace its folder.
// `install` registers the helper with Chrome for the unpacked extension in ~/.ais/browser-extension.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { EXTENSION_REPO } from "./extension.ts";

/** Chrome's native host name: lower-case letters, digits, `_` and dots only. */
export const HOST_NAME = "ais_browser_extension";

/** Unpacked extension id: sha256 of the absolute path, first 32 hex digits mapped onto a-p (posix paths as UTF-8). */
export function unpackedExtensionId(absPath: string): string {
  return [...createHash("sha256").update(absPath).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/** NativeMessagingHosts folders of the Chrome-family browsers present for this user (only where the browser's data folder exists). */
export function nativeHostDirs(platform: NodeJS.Platform, home: string, exists: (p: string) => boolean = existsSync): string[] {
  const roots = platform === "darwin"
    ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium"].map((d) => join(home, "Library", "Application Support", d))
    : platform === "linux"
      ? ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"].map((d) => join(home, ".config", d))
      : [];
  return roots.filter((r) => exists(r)).map((r) => join(r, "NativeMessagingHosts"));
}

/** The command Chrome must run: the compiled ais binary, or bun plus the entry script when run from source. */
export function aisCommand(execPath: string = process.execPath, argv1: string | undefined = process.argv[1]): string[] {
  return /^bun(\.exe)?$/.test(basename(execPath)) && argv1 ? [execPath, resolve(argv1)] : [execPath];
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface HostInstallDeps {
  extensionDir: string;
  home: string;
  platform: NodeJS.Platform;
  command: string[];
  out: (line: string) => void;
}

/** Writes the helper launcher and Chrome's host manifest. Returns the manifest paths written. */
export async function installNativeHost(deps: HostInstallDeps): Promise<string[]> {
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    deps.out("AIS Browser self-update needs macOS or Linux; skipped.");
    return [];
  }
  const extPath = existsSync(deps.extensionDir) ? await realpath(deps.extensionDir) : resolve(deps.extensionDir);
  const launcherDir = join(deps.home, ".ais", "browser-host");
  await mkdir(launcherDir, { recursive: true });
  const launcher = join(launcherDir, "ais-browser-host");
  // Chrome starts the helper with a bare environment: the launcher names every path.
  await writeFile(launcher, `#!/bin/sh\nexec ${deps.command.map(shQuote).join(" ")} browser extension host "$@"\n`);
  await chmod(launcher, 0o755);
  const manifest = {
    name: HOST_NAME,
    description: "AIS Browser updater",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${unpackedExtensionId(extPath)}/`],
  };
  const written: string[] = [];
  for (const dir of nativeHostDirs(deps.platform, deps.home)) {
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${HOST_NAME}.json`);
    await writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`);
    written.push(p);
  }
  if (written.length === 0) deps.out("No Chrome found for this user: AIS Browser self-update not registered.");
  return written;
}

// ---- protocol ------------------------------------------------------------

/** Chrome's framing: 4-byte little-endian length, then UTF-8 JSON. */
export function encodeFrame(msg: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/** Reads one frame from a byte stream; undefined when the stream ends first. */
export async function readFrame(input: AsyncIterable<Uint8Array>): Promise<unknown> {
  let buf = new Uint8Array(0);
  for await (const chunk of input) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    if (buf.length >= 4) {
      const len = new DataView(buf.buffer).getUint32(0, true);
      if (len > 1024 * 1024) throw new Error("message too large");
      if (buf.length >= 4 + len) return JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len)));
    }
  }
  return undefined;
}

export const parseVersion = (v: string): number[] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** True when `a` is a newer x.y.z version than `b`; false when either does not parse. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** Latest release version ("0.5.46"), read from GitHub's /releases/latest redirect (no API quota), else the API. */
export async function latestVersion(fetchImpl: typeof fetch): Promise<string> {
  const r = await fetchImpl(`https://github.com/${EXTENSION_REPO}/releases/latest`, { redirect: "manual" });
  const tag = /\/releases\/tag\/(v?[^/?#]+)$/.exec(r.headers.get("location") ?? "")?.[1];
  if (tag && parseVersion(tag)) return tag.replace(/^v/, "");
  const api = await fetchImpl(`https://api.github.com/repos/${EXTENSION_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!api.ok) throw new Error(`could not look up the latest release: HTTP ${api.status}`);
  const name = ((await api.json()) as { tag_name?: string }).tag_name ?? "";
  if (!parseVersion(name)) throw new Error(`latest release has no x.y.z tag: ${name}`);
  return name.replace(/^v/, "");
}

export async function installedVersion(extensionDir: string): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface HostDeps {
  extensionDir: string;
  fetch: typeof fetch;
  /** Replaces the extension folder with the latest release. */
  update(): Promise<void>;
}

export type HostRequest = { type: "check" } | { type: "update" };
export type HostReply = { ok: true; latest?: string; installed?: string; updated?: boolean } | { ok: false; error: string };

export async function handleHostRequest(req: unknown, deps: HostDeps): Promise<HostReply> {
  const type = (req as { type?: unknown } | null)?.type;
  try {
    if (type === "check") {
      const [latest, installed] = await Promise.all([latestVersion(deps.fetch), installedVersion(deps.extensionDir)]);
      return { ok: true, latest, ...(installed ? { installed } : {}) };
    }
    if (type === "update") {
      const latest = await latestVersion(deps.fetch);
      const before = await installedVersion(deps.extensionDir);
      // Never downgrade or rewrite the same version.
      if (before && !isNewer(latest, before)) return { ok: true, latest, installed: before, updated: false };
      await deps.update();
      const installed = await installedVersion(deps.extensionDir);
      return { ok: true, latest, ...(installed ? { installed } : {}), updated: true };
    }
    return { ok: false, error: "unknown request" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Entry point Chrome runs: one request, one reply, then exit. Nothing else may reach stdout. */
export async function runNativeHost(deps: HostDeps, input: AsyncIterable<Uint8Array> = Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>, write: (b: Uint8Array) => void = (b) => process.stdout.write(b)): Promise<void> {
  let req: unknown;
  try {
    req = await readFrame(input);
  } catch (e) {
    write(encodeFrame({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (req === undefined) return;
  write(encodeFrame(await handleHostRequest(req, deps)));
}

export const defaultHome = (): string => homedir();
