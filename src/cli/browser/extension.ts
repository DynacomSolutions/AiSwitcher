import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";

export const EXTENSION_REPO = "DynacomSolutions/AiSwitcher";
export const EXTENSION_ASSET = "ais-browser-extension.zip";

export const defaultExtensionDir = (): string => join(homedir(), ".ais", "browser-extension");

export interface CommandResult {
  code: number;
  stderr: string;
}

export interface ExtensionDeps {
  /** Fixed folder the user loads unpacked in Chrome. Defaults to ~/.ais/browser-extension. */
  extensionDir: string;
  fetch: typeof fetch;
  out: (line: string) => void;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Runs a command; a missing binary must resolve with code 127 rather than throw. */
  run(cmd: string[]): Promise<CommandResult>;
}

async function defaultRun(cmd: string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
  } catch (e) {
    return { code: 127, stderr: e instanceof Error ? e.message : String(e) };
  }
}

const defaults = (): ExtensionDeps => ({
  extensionDir: defaultExtensionDir(),
  fetch,
  out: (line) => console.info(line),
  env: process.env,
  platform: process.platform,
  run: defaultRun,
});

async function downloadWithGh(deps: ExtensionDeps, dest: string): Promise<boolean> {
  const r = await deps.run(["gh", "release", "download", "--repo", EXTENSION_REPO, "--pattern", EXTENSION_ASSET, "--dir", dest, "--clobber"]);
  if (r.code === 127) return false;
  if (r.code !== 0) throw new Error(`gh release download failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return true;
}

async function downloadWithApi(deps: ExtensionDeps, dest: string): Promise<void> {
  const token = deps.env.GITHUB_TOKEN || deps.env.GH_TOKEN;
  if (!token) throw new Error("gh is not installed and neither GITHUB_TOKEN nor GH_TOKEN is set; install gh or set a token");
  const headers = { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ais-cli" };
  const rel = await deps.fetch(`https://api.github.com/repos/${EXTENSION_REPO}/releases/latest`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
  if (!rel.ok) throw new Error(`GitHub latest release lookup failed: HTTP ${rel.status}`);
  const assets = ((await rel.json()) as { assets?: { name?: string; url?: string }[] }).assets ?? [];
  const asset = assets.find((a) => a.name === EXTENSION_ASSET);
  if (!asset?.url) throw new Error(`latest release has no ${EXTENSION_ASSET} asset`);
  const res = await deps.fetch(asset.url, { headers: { ...headers, Accept: "application/octet-stream" }, redirect: "follow" });
  if (!res.ok) throw new Error(`asset download failed: HTTP ${res.status}`);
  await writeFile(join(dest, EXTENSION_ASSET), new Uint8Array(await res.arrayBuffer()));
}

async function unzip(deps: ExtensionDeps, zip: string, dest: string): Promise<void> {
  const cmd = deps.platform === "darwin" ? ["ditto", "-x", "-k", zip, dest] : ["unzip", "-q", "-o", zip, "-d", dest];
  const r = await deps.run(cmd);
  if (r.code !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** Renames old aside, new in, then removes the aside copy; restores the old folder if the second rename fails. */
async function swapIn(target: string, fresh: string): Promise<void> {
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
  if (hadOld) await rm(old, { recursive: true, force: true });
}

async function updateExtension(from: string | undefined, deps: ExtensionDeps): Promise<void> {
  const target = resolve(deps.extensionDir);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(parent, ".browser-extension-"));
  try {
    let zip: string;
    if (from !== undefined) {
      zip = resolve(from);
      if (!existsSync(zip)) throw new CliUsageError(`zip not found: ${zip}`);
    } else {
      const dl = join(tmp, "download");
      await mkdir(dl);
      if (!(await downloadWithGh(deps, dl))) await downloadWithApi(deps, dl);
      zip = join(dl, EXTENSION_ASSET);
      if (!existsSync(zip)) throw new Error(`download produced no ${EXTENSION_ASSET}`);
    }
    const fresh = join(tmp, "extracted");
    await mkdir(fresh);
    await unzip(deps, zip, fresh);
    const manifest = await readFile(join(fresh, "manifest.json"), "utf8").catch(() => undefined);
    if (manifest === undefined) throw new Error(`${EXTENSION_ASSET} has no manifest.json at its root; the old extension was left in place`);
    JSON.parse(manifest);
    await swapIn(target, fresh);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
    default:
      throw new CliUsageError("Usage: ais browser extension path | update [--from=<zip>]");
  }
}
