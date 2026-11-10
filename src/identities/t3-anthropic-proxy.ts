import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T3 Code reads its Anthropic account data (usage, reset credits) from api.anthropic.com. To let the AIS gateway answer
 * that, only the T3 server binary routes api.anthropic.com through the gateway CONNECT proxy. This is done with a
 * preload (NODE_OPTIONS=--require in ~/.t3/service.env, which T3 passes to every child). HTTPS_PROXY must never be set
 * there: the CONNECT proxy refuses every other host, so git, gh, npm and codex would all break in every T3 thread.
 *
 * The preload acts only when process.execPath is ~/.t3/runtime/versions/<v>/t3, never throws, and leaves every host
 * other than api.anthropic.com on the untouched native fetch. Its exports (isT3Exe, install) exist for tests.
 */
export const PRELOAD_SOURCE = String.raw`// Loaded into every Node process T3 starts (NODE_OPTIONS=--require from ~/.t3/service.env).
// Managed by "ais gateway t3-proxy"; do not edit, it is rewritten on install.
// It acts ONLY inside the T3 server binary: there, requests to api.anthropic.com go through the AIS gateway
// CONNECT proxy (so T3's own usage/reset reads and redeems reach the gateway's account API); every other host
// stays direct. In any other process (node, npm, claude children) it does nothing. It never throws.
"use strict";
const T3_EXE = /[\\/]\.t3[\\/]runtime[\\/]versions[\\/][^\\/]+[\\/]t3$/;
function isT3Exe(exe) {
  return T3_EXE.test(String(exe));
}
function install(opts) {
  const path = require("node:path");
  const exe = opts.exe;
  const proxy = opts.proxy;
  if (!proxy || !isT3Exe(exe)) return false;
  const undici = opts.undici || require(path.join(path.dirname(exe), "node_modules", "undici"));
  const target = opts.target || globalThis;
  const HOSTS = new Set(["api.anthropic.com"]);
  const viaGateway = new undici.ProxyAgent({ uri: proxy });
  const nativeFetch = target.fetch;
  const hostOf = (input) => {
    try {
      const u = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
      return u.hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  // Only api.anthropic.com changes path: T3's own undici fetch with the proxy agent (same library version, so the
  // handler API matches). Every other request uses Node's untouched fetch.
  target.fetch = function aisT3Fetch(input, init) {
    if (!HOSTS.has(hostOf(input))) return nativeFetch.call(this, input, init);
    if (typeof input !== "string" && !(input instanceof URL)) {
      return input.arrayBuffer().then((buf) =>
        undici.fetch(input.url, { method: input.method, headers: input.headers, body: buf.byteLength ? buf : undefined, signal: input.signal, ...init, dispatcher: viaGateway }),
      );
    }
    return undici.fetch(input, { ...init, dispatcher: viaGateway });
  };
  return true;
}
module.exports = { isT3Exe, install };
try {
  const fs = require("node:fs");
  const proxy = process.env.AIS_T3_ANTHROPIC_PROXY;
  if (proxy) {
    const exe = fs.realpathSync(process.execPath);
    if (install({ exe, proxy }) && process.env.AIS_T3_PROXY_MARK) fs.writeFileSync(process.env.AIS_T3_PROXY_MARK, "active pid " + process.pid + "\n");
  }
} catch (err) {
  try {
    process.stderr.write("ais t3 anthropic proxy preload skipped: " + (err && err.message) + "\n");
  } catch {}
}
`;

export const FORBIDDEN_PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] as const;
const KEY_PROXY = "AIS_T3_ANTHROPIC_PROXY";
const KEY_CA = "NODE_EXTRA_CA_CERTS";
const KEY_OPTIONS = "NODE_OPTIONS";

export interface T3Paths {
  t3Home: string;
  serviceEnv: string;
  backupsDir: string;
  preload: string;
}

/** Paths honour T3CODE_HOME (from `env`) and a test-overridable `home` (default: the user's home). */
export function t3Paths(opts: { home?: string; env?: Record<string, string | undefined> } = {}): T3Paths {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const t3Home = env.T3CODE_HOME ? env.T3CODE_HOME : join(home, ".t3");
  return { t3Home, serviceEnv: join(t3Home, "service.env"), backupsDir: join(t3Home, "backups"), preload: join(home, ".ais", "t3", "anthropic-proxy.cjs") };
}

interface Parsed {
  key: string;
  value: string;
  quote: string;
}

function parseLine(line: string): Parsed | undefined {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!m) return undefined;
  let value = (m[2] ?? "").trim();
  let quote = "";
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!)) {
    quote = value[0]!;
    value = value.slice(1, -1);
  }
  return { key: m[1]!, value, quote };
}

/** The forbidden proxy variables (name as written) present in a service.env. */
export function forbiddenProxyVars(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const kv = parseLine(line);
    if (kv && (FORBIDDEN_PROXY_VARS as readonly string[]).includes(kv.key.toUpperCase())) found.push(kv.key);
  }
  return found;
}

function assertNoForbidden(text: string): void {
  const bad = forbiddenProxyVars(text);
  if (bad.length > 0) {
    throw new Error(`service.env sets ${bad.join(", ")}: that sends every T3 child (git, gh, npm, codex) through the gateway proxy, which refuses every host but api.anthropic.com. Remove it first.`);
  }
}

function optionTokens(value: string): string[] {
  return value.split(/\s+/).filter((t) => t !== "");
}

/** Whether the NODE_OPTIONS tokens already carry `--require <path>` (or `--require=<path>`). */
function hasRequire(tokens: string[], path: string): boolean {
  return tokens.some((t, i) => t === `--require=${path}` || (t === "--require" && tokens[i + 1] === path));
}

function withoutRequire(tokens: string[], path: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === `--require=${path}`) continue;
    if (t === "--require" && tokens[i + 1] === path) {
      i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

const render = (key: string, value: string, quote = ""): string => `${key}=${quote}${value}${quote}`;

/** Replaces the first line of `key` (dropping later duplicates) or appends one; `fn` gets the parsed old line. */
function setKey(lines: string[], key: string, fn: (old: Parsed | undefined) => string | undefined): string[] {
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    const kv = parseLine(line);
    if (kv?.key !== key) {
      out.push(line);
      continue;
    }
    if (done) continue;
    done = true;
    const next = fn(kv);
    if (next !== undefined) out.push(next);
  }
  if (!done) {
    const next = fn(undefined);
    if (next !== undefined) out.push(next);
  }
  return out;
}

/** Splits into lines without the final empty piece of a trailing newline. */
const toLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};
const fromLines = (lines: string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

export interface UpsertInput {
  preloadPath: string;
  proxyUrl: string;
  caPath: string;
}

/** Pure: the service.env text with the three keys set; every other line and the order is kept. Throws on HTTPS_PROXY & co. */
export function upsertServiceEnv(text: string, input: UpsertInput): string {
  assertNoForbidden(text);
  for (const [name, v] of [["proxy URL", input.proxyUrl], ["CA path", input.caPath], ["preload path", input.preloadPath]] as const) {
    if (/[\r\n]/.test(v)) throw new Error(`${name} must be one line`);
  }
  let lines = toLines(text);
  lines = setKey(lines, KEY_OPTIONS, (old) => {
    const tokens = old ? optionTokens(old.value) : [];
    if (!hasRequire(tokens, input.preloadPath)) tokens.push("--require", input.preloadPath);
    return render(KEY_OPTIONS, tokens.join(" "), old?.quote ?? "");
  });
  lines = setKey(lines, KEY_PROXY, () => render(KEY_PROXY, input.proxyUrl));
  lines = setKey(lines, KEY_CA, () => render(KEY_CA, input.caPath));
  return fromLines(lines);
}

/** Pure: drops the three keys, and from NODE_OPTIONS only our --require (the line goes when nothing else is left). */
export function removeFromServiceEnv(text: string, preloadPath: string): string {
  let lines = toLines(text);
  lines = setKey(lines, KEY_OPTIONS, (old) => {
    if (!old) return undefined;
    const tokens = withoutRequire(optionTokens(old.value), preloadPath);
    return tokens.length === 0 ? undefined : render(KEY_OPTIONS, tokens.join(" "), old.quote);
  });
  // setKey appends nothing when fn returns undefined for a missing key.
  lines = setKey(lines, KEY_PROXY, () => undefined);
  lines = setKey(lines, KEY_CA, () => undefined);
  return fromLines(lines);
}

/** Missing or wrong keys for an installed setup; empty when all three are right. */
export function missingKeys(text: string, preloadPath: string): string[] {
  const values = new Map<string, string>();
  for (const line of toLines(text)) {
    const kv = parseLine(line);
    if (kv && !values.has(kv.key)) values.set(kv.key, kv.value);
  }
  const missing: string[] = [];
  if (!hasRequire(optionTokens(values.get(KEY_OPTIONS) ?? ""), preloadPath)) missing.push(`${KEY_OPTIONS} (--require ${preloadPath})`);
  if (!values.get(KEY_PROXY)) missing.push(KEY_PROXY);
  if (!values.get(KEY_CA)) missing.push(KEY_CA);
  return missing;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeAtomicMode(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

async function backup(paths: T3Paths, text: string, now: number): Promise<string> {
  await mkdir(paths.backupsDir, { recursive: true });
  const file = join(paths.backupsDir, `service.env.pre-anthropic-proxy.${Math.floor(now / 1000)}`);
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

async function writeServiceEnv(paths: T3Paths, before: string | undefined, after: string, now: number): Promise<string | undefined> {
  if (before === after) return undefined;
  const saved = before !== undefined ? await backup(paths, before, now) : undefined;
  let mode = 0o600;
  try {
    mode = (await stat(paths.serviceEnv)).mode & 0o777;
  } catch {}
  await writeAtomicMode(paths.serviceEnv, after, mode);
  return saved;
}

export interface T3Options {
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface InstallResult {
  preload: string;
  serviceEnv: string;
  backup: string | undefined;
  changed: boolean;
}

export async function installT3Proxy(opts: T3Options & { proxyUrl: string; caPath: string }): Promise<InstallResult> {
  const paths = t3Paths(opts);
  const before = await readOptional(paths.serviceEnv);
  // Validate before touching anything.
  const after = upsertServiceEnv(before ?? "", { preloadPath: paths.preload, proxyUrl: opts.proxyUrl, caPath: opts.caPath });
  const preloadChanged = (await readOptional(paths.preload)) !== PRELOAD_SOURCE;
  if (preloadChanged) await writeAtomicMode(paths.preload, PRELOAD_SOURCE, 0o644);
  else await chmod(paths.preload, 0o644);
  const saved = await writeServiceEnv(paths, before, after, (opts.now ?? Date.now)());
  return { preload: paths.preload, serviceEnv: paths.serviceEnv, backup: saved, changed: preloadChanged || before !== after };
}

export async function removeT3Proxy(opts: T3Options = {}): Promise<InstallResult> {
  const paths = t3Paths(opts);
  const before = await readOptional(paths.serviceEnv);
  let saved: string | undefined;
  if (before !== undefined) saved = await writeServiceEnv(paths, before, removeFromServiceEnv(before, paths.preload), (opts.now ?? Date.now)());
  const hadPreload = (await readOptional(paths.preload)) !== undefined;
  await rm(paths.preload, { force: true });
  return { preload: paths.preload, serviceEnv: paths.serviceEnv, backup: saved, changed: saved !== undefined || hadPreload };
}

/** Read-only: what is wrong with the install (empty when installed and current). */
export async function checkT3Proxy(opts: T3Options = {}): Promise<string[]> {
  const paths = t3Paths(opts);
  const problems: string[] = [];
  const text = await readOptional(paths.serviceEnv);
  if (text === undefined) problems.push(`${paths.serviceEnv} is missing`);
  else {
    const bad = forbiddenProxyVars(text);
    if (bad.length > 0) problems.push(`forbidden proxy variable(s) in ${paths.serviceEnv}: ${bad.join(", ")} (breaks every T3 child)`);
    const missing = missingKeys(text, paths.preload);
    if (missing.length > 0) problems.push(`missing keys: ${missing.join(", ")}`);
  }
  const preload = await readOptional(paths.preload);
  if (preload === undefined) problems.push(`preload missing: ${paths.preload}`);
  else if (preload !== PRELOAD_SOURCE) problems.push(`preload out of date: ${paths.preload} (run ais gateway t3-proxy)`);
  return problems;
}

/**
 * For `ais doctor`: problems that break T3 even when this command was never run (a forbidden proxy variable) or that a
 * past install left behind (an old preload). Empty on hosts with no T3 service.env and no preload.
 */
export async function t3ProxyDoctorProblems(opts: T3Options = {}): Promise<string[]> {
  const paths = t3Paths(opts);
  const problems: string[] = [];
  const text = await readOptional(paths.serviceEnv).catch(() => undefined);
  if (text !== undefined) {
    const bad = forbiddenProxyVars(text);
    if (bad.length > 0) problems.push(`${paths.serviceEnv} sets ${bad.join(", ")}: this breaks git, gh, npm and codex in every T3 thread (gateway proxy only serves api.anthropic.com); remove it, use ais gateway t3-proxy`);
  }
  const preload = await readOptional(paths.preload).catch(() => undefined);
  if (preload !== undefined && preload !== PRELOAD_SOURCE) problems.push(`T3 preload ${paths.preload} is out of date; run ais gateway t3-proxy, then restart T3`);
  return problems;
}

/** HTTPS_PROXY of any <t3Home>/gateway/t3-claude-*\/settings.json env (the gateway folders already set up for T3). */
export async function proxyFromT3Folders(opts: T3Options = {}): Promise<string | undefined> {
  const dir = join(t3Paths(opts).t3Home, "gateway");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith("t3-claude-")).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name, "settings.json"), "utf8")) as { env?: Record<string, unknown> };
      const v = parsed.env?.HTTPS_PROXY;
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    } catch {}
  }
  return undefined;
}
