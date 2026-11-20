import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./pool/fs.ts";

/** Environment marker passed only to the Claude process that needs the account preload. */
export const CLAUDE_ACCOUNT_PRELOAD_MARKER = "AIS_CLAUDE_ACCOUNT_PRELOAD";
export const CLAUDE_ACCOUNT_PRELOAD_PATH = (home = homedir()): string => join(home, ".ais", "claude", "account-preload.cjs");

/**
 * The Claude account preload only rewrites authenticated, read-only account calls.
 * Model traffic continues to use Claude's configured ANTHROPIC_BASE_URL directly.
 */
export const CLAUDE_ACCOUNT_PRELOAD_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const nodeHttp = require("node:http");
const nodeHttps = require("node:https");
const { syncBuiltinESMExports } = require("node:module");

const ownMarker = "AIS_CLAUDE_ACCOUNT_PRELOAD";
const enabled = process.env[ownMarker] === "1";
delete process.env[ownMarker];

function removeOwnBunOption() {
  const raw = process.env.BUN_OPTIONS;
  if (!raw) return;
  const tokens = optionTokens(raw);
  const own = path.resolve(__filename);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const value = token === "--preload" ? tokens[i + 1] : token.startsWith("--preload=") ? token.slice("--preload=".length) : undefined;
    if (value !== undefined && path.resolve(String(value).replace(/^['"]|['"]$/g, "")) === own) {
      if (token === "--preload") i += 1;
      continue;
    }
    kept.push(token);
  }
  if (kept.length === 0) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = kept.join(" ");
}

function optionTokens(raw) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const char of String(raw)) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token !== "") { tokens.push(token); token = ""; }
    } else token += char;
  }
  if (escaped) token += "\\";
  if (token !== "") tokens.push(token);
  return tokens;
}
removeOwnBunOption();
if (!enabled) {
  module.exports = {};
} else {

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function loopback(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function configuredBase() {
  const folder = process.env.CLAUDE_CONFIG_DIR;
  if (!folder) return undefined;
  const settings = readJson(path.join(folder, "settings.json"));
  const raw = process.env.ANTHROPIC_BASE_URL || settings && settings.env && settings.env.ANTHROPIC_BASE_URL;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const base = new URL(raw);
    if (base.username || base.password || base.hash) return undefined;
    if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback(base.hostname))) return undefined;
    return base;
  } catch { return undefined; }
}

function gatewayToken() {
  const folder = process.env.CLAUDE_CONFIG_DIR;
  if (!folder) return undefined;
  const oauth = readJson(path.join(folder, ".credentials.json"));
  const token = oauth && oauth.claudeAiOauth && oauth.claudeAiOauth.accessToken;
  return typeof token === "string" && /^aisg_/i.test(token) ? token : undefined;
}

const base = configuredBase();
const token = gatewayToken();
if (base && token) {

function header(headers, name) {
  if (Array.isArray(headers)) {
    const item = headers.find((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === name);
    return item && item[1];
  }
  if (!headers || typeof headers !== "object") return undefined;
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function accountPath(value) {
  const raw = String(value || "");
  return /^\/api\/oauth\/(?:usage|profile)(?:\?|$)/.test(raw) ? raw : undefined;
}

function hasGatewayAuth(value) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value || ""));
  return match !== null && match[1] === token;
}

function apiHost(value) {
  return String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/:\d+$/, "") === "api.anthropic.com";
}

function targetFor(requestPath) {
  const target = new URL(base.origin);
  target.pathname = base.pathname.replace(/\/+$/, "") + requestPath.split("?", 1)[0];
  const query = requestPath.indexOf("?");
  target.search = query === -1 ? "" : requestPath.slice(query);
  return target;
}

function rewriteOptions(options) {
  if (!options || typeof options !== "object" || options instanceof URL) return undefined;
  const requestPath = accountPath(options.path);
  const auth = header(options.headers, "authorization");
  if (!apiHost(options.hostname || options.host) || String(options.method || "GET").toUpperCase() !== "GET" || !requestPath || !hasGatewayAuth(auth)) return undefined;
  const target = targetFor(requestPath);
  const headers = Array.isArray(options.headers)
    ? options.headers.filter((entry) => !Array.isArray(entry) || String(entry[0]).toLowerCase() !== "host")
    : { ...(options.headers || {}) };
  if (!Array.isArray(headers)) for (const key of Object.keys(headers)) if (key.toLowerCase() === "host") delete headers[key];
  const {
    protocol: _protocol,
    hostname: _hostname,
    host: _host,
    port: _port,
    path: _path,
    socketPath: _socketPath,
    auth: _auth,
    servername: _servername,
    ...preserved
  } = options;
  const next = {
    ...preserved,
    protocol: target.protocol,
    hostname: target.hostname,
    port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: options.method || "GET",
    headers,
    ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
  };
  return next;
}

function requestOptions(input, override) {
  if (typeof input !== "string" && !(input instanceof URL)) return input;
  let url;
  try { url = new URL(String(input)); } catch { return input; }
  return { protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, ...(override || {}) };
}

function rewritten(input, options) {
  const hasOptions = typeof options === "object" && options !== null && typeof options !== "function";
  return rewriteOptions(requestOptions(input, hasOptions ? options : undefined));
}

function wrapRequest(native, targetTransport, targetNative) {
  return function aisClaudeRequest(input, options, callback) {
    const actualCallback = typeof callback === "function" ? callback : typeof options === "function" ? options : undefined;
    const next = rewritten(input, options);
    if (!next) return native.apply(this, arguments);
    return targetNative.call(targetTransport, next, actualCallback);
  };
}

const nativeHttpsRequest = nodeHttps.request;
const nativeHttpRequest = nodeHttp.request;
const nativeHttpsGet = nodeHttps.get;
const nativeHttpGet = nodeHttp.get;
const targetTransport = base.protocol === "https:" ? nodeHttps : nodeHttp;
const targetNative = base.protocol === "https:" ? nativeHttpsRequest : nativeHttpRequest;
nodeHttps.request = wrapRequest(nativeHttpsRequest, targetTransport, targetNative);
nodeHttp.request = wrapRequest(nativeHttpRequest, targetTransport, targetNative);
nodeHttps.get = function aisClaudeGet(input, options, callback) {
  const next = rewritten(input, options);
  if (!next) return nativeHttpsGet.apply(this, arguments);
  const actualCallback = typeof callback === "function" ? callback : typeof options === "function" ? options : undefined;
  const request = targetNative.call(targetTransport, next, actualCallback);
  request.end();
  return request;
};
nodeHttp.get = function aisClaudeGet(input, options, callback) {
  const next = rewritten(input, options);
  if (!next) return nativeHttpGet.apply(this, arguments);
  const actualCallback = typeof callback === "function" ? callback : typeof options === "function" ? options : undefined;
  const request = targetNative.call(targetTransport, next, actualCallback);
  request.end();
  return request;
};
syncBuiltinESMExports();

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === "function") {
  globalThis.fetch = function aisClaudeFetch(input, init) {
    let effective;
    try { effective = input instanceof Request ? new Request(input, init) : new Request(String(input), init); } catch { return nativeFetch.apply(this, arguments); }
    let candidate;
    try { candidate = new URL(effective.url); } catch { return nativeFetch.apply(this, arguments); }
    const method = effective.method || "GET";
    const auth = effective.headers.get("authorization");
    if (candidate.origin !== "https://api.anthropic.com" || String(method).toUpperCase() !== "GET" || !accountPath(candidate.pathname + candidate.search) || !hasGatewayAuth(auth)) return nativeFetch.apply(this, arguments);
    const target = targetFor(candidate.pathname + candidate.search);
    // Fetch removes Authorization when a followed redirect changes origin. Keep the native redirect policy and this
    // rule, so an AIS bearer never crosses from the configured gateway to an unrelated origin.
    return nativeFetch.call(this, new Request(target, effective));
  };
}
}
}
`;

export function addClaudeAccountPreload(existing: string | undefined, preloadPath: string): string {
  const pathValue = preloadPath.trim();
  if (pathValue === "") throw new Error("Claude account preload path is required");
  const tokens = bunOptionTokens(existing ?? "");
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--preload" && tokens[i + 1] === pathValue) {
      i += 1;
      continue;
    }
    if (token === `--preload=${pathValue}`) continue;
    kept.push(token);
  }
  kept.push("--preload", quoteBunOption(pathValue));
  return kept.join(" ");
}

function bunOptionTokens(raw: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const char of raw) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token !== "") { tokens.push(token); token = ""; }
    } else token += char;
  }
  if (escaped) token += "\\";
  if (token !== "") tokens.push(token);
  return tokens;
}

function quoteBunOption(value: string): string {
  return /\s/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

export async function installClaudeAccountPreload(home = homedir()): Promise<string> {
  const path = CLAUDE_ACCOUNT_PRELOAD_PATH(home);
  await mkdir(join(home, ".ais", "claude"), { recursive: true, mode: 0o700 });
  let current: string | undefined;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== CLAUDE_ACCOUNT_PRELOAD_SOURCE) await writeFileAtomic(path, CLAUDE_ACCOUNT_PRELOAD_SOURCE);
  return path;
}
