import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { downloadAsset } from "../../shared/release-assets.ts";
import { CliUsageError } from "../errors.ts";
import { aisCommand, installNativeHost, runNativeHost } from "./native-host.ts";

export const EXTENSION_REPO = "DynacomSolutions/AiSwitcher";
export const EXTENSION_ASSET = "ais-browser-extension.zip";

export const defaultExtensionDir = (): string => join(homedir(), ".ais", "browser-extension");

export interface CommandResult {
  code: number;
  stderr: string;
  stdout?: string;
}

export interface ExtensionDeps {
  /** Fixed folder the user loads unpacked in Chrome. Defaults to ~/.ais/browser-extension. */
  extensionDir: string;
  /** Home folder for the helper launcher and Chrome's NativeMessagingHosts. */
  home: string;
  fetch: typeof fetch;
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Runs a command; a missing binary must resolve with code 127 rather than throw. */
  run(cmd: string[]): Promise<CommandResult>;
}

async function defaultRun(cmd: string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr, stdout };
  } catch (e) {
    return { code: 127, stderr: e instanceof Error ? e.message : String(e) };
  }
}

const defaults = (): ExtensionDeps => ({
  extensionDir: defaultExtensionDir(),
  home: homedir(),
  fetch,
  out: (line) => console.info(line),
  env: process.env,
  platform: process.platform,
  run: defaultRun,
});

/** Public download through the shared release-asset helper, never sending credentials. */
async function download(deps: ExtensionDeps, dest: string): Promise<void> {
  await downloadAsset(EXTENSION_ASSET, join(dest, EXTENSION_ASSET), { fetchImpl: deps.fetch, anonymous: true });
}

/** True for absolute, drive-letter or `..` entry names. */
export const unsafeEntry = (name: string): boolean => name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes("..");

async function unzip(deps: ExtensionDeps, zip: string, dest: string): Promise<void> {
  const list = deps.platform === "darwin" ? ["zipinfo", "-1", zip] : ["unzip", "-Z1", zip];
  const l = await deps.run(list);
  if (l.code !== 0) throw new Error(`${list[0]} failed: ${l.stderr.trim() || `exit ${l.code}`}`);
  const bad = (l.stdout ?? "").split("\n").map((n) => n.trim()).find((n) => n && unsafeEntry(n));
  if (bad) throw new Error(`zip entry escapes the extension folder: ${bad}`);
  const cmd = deps.platform === "darwin" ? ["ditto", "-x", "-k", zip, dest] : ["unzip", "-q", "-o", zip, "-d", dest];
  const r = await deps.run(cmd);
  if (r.code !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  await assertContained(dest);
}

/** Rejects any symlink, or entry whose realpath is outside root. */
async function assertContained(root: string): Promise<void> {
  const base = await realpath(root);
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`zip contains a symlink: ${p.slice(root.length + 1)}`);
      const real = await realpath(p);
      if (real !== base && !real.startsWith(base + sep)) throw new Error(`zip entry resolves outside the extension folder: ${p.slice(root.length + 1)}`);
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(root);
}

/** Renames old aside, new in; removes the aside copy only after the new one is in place (a cleanup failure only warns). */
export async function swapIn(target: string, fresh: string, warn: (line: string) => void): Promise<void> {
  const old = `${target}.old`;
  await rm(old, { recursive: true, force: true });
  const hadOld = existsSync(target);
  if (hadOld) await rename(target, old);
  try {
    await rename(fresh, target);
  } catch (e) {
    if (hadOld) await rename(old, target).catch(() => undefined);
    throw e;
  }
  if (hadOld) {
    try {
      await rm(old, { recursive: true, force: true });
    } catch (e) {
      warn(`warning: could not remove ${old}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Registers the self-update helper with Chrome for the extension folder. */
export async function installHost(deps: Pick<ExtensionDeps, "extensionDir" | "home" | "platform" | "out">): Promise<string[]> {
  return installNativeHost({ extensionDir: resolve(deps.extensionDir), home: deps.home, platform: deps.platform, command: aisCommand(), out: deps.out });
}

async function replaceExtension(from: string | undefined, deps: ExtensionDeps): Promise<void> {
  const target = resolve(deps.extensionDir);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  // A crashed earlier swap may have left only .old: restore it before anything else.
  if (!existsSync(target) && existsSync(`${target}.old`)) await rename(`${target}.old`, target);
  const tmp = await mkdtemp(join(parent, ".browser-extension-"));
  try {
    let zip: string;
    if (from !== undefined) {
      zip = resolve(from);
      if (!existsSync(zip)) throw new CliUsageError(`zip not found: ${zip}`);
    } else {
      const dl = join(tmp, "download");
      await mkdir(dl);
      await download(deps, dl);
      zip = join(dl, EXTENSION_ASSET);
      if (!existsSync(zip)) throw new Error(`download produced no ${EXTENSION_ASSET}`);
    }
    const fresh = join(tmp, "extracted");
    await mkdir(fresh);
    await unzip(deps, zip, fresh);
    const manifest = await readFile(join(fresh, "manifest.json"), "utf8").catch(() => undefined);
    if (manifest === undefined) throw new Error(`${EXTENSION_ASSET} has no manifest.json at its root; the old extension was left in place`);
    JSON.parse(manifest);
    await swapIn(target, fresh, deps.out);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function updateExtension(from: string | undefined, deps: ExtensionDeps): Promise<void> {
  const target = resolve(deps.extensionDir);
  await replaceExtension(from, deps);
  await installHost(deps);
  deps.out(`extension installed at ${target}`);
  deps.out("First time: chrome://extensions, enable Developer mode, Load unpacked, choose that folder (once per Chrome profile).");
  deps.out("Reload the extension in each Chrome profile (chrome://extensions, reload icon on AIS Browser).");
}

export async function runBrowserExtension(rest: string[], flags: ParsedArgs["flags"], overrides: Partial<ExtensionDeps> = {}): Promise<void> {
  const deps = { ...defaults(), ...overrides };
  switch (rest[0]) {
    case "path":
      deps.out(resolve(deps.extensionDir));
      return;
    case "update":
      await updateExtension(stringFlag(flags, "from"), deps);
      return;
    case "install-host": {
      const written = await installHost(deps);
      for (const p of written) deps.out(`registered ${p}`);
      return;
    }
    case "host": {
      // Started by Chrome: stdout carries only native-messaging frames, so every message goes to stderr.
      const quiet = { ...deps, out: (line: string) => console.error(line) };
      await runNativeHost({ extensionDir: resolve(deps.extensionDir), fetch: deps.fetch, update: () => replaceExtension(undefined, quiet) });
      return;
    }
    default:
      throw new CliUsageError("Usage: ais browser extension path | update [--from=<zip>] | install-host");
  }
}
