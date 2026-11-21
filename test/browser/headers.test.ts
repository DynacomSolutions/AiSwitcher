import { expect, test } from "bun:test";
import { browserHeaders, isOtherProviderName } from "../../src/browser/headers.ts";

const TOKEN = "aisg_SYNTHETIC_FIXTURE_tok_abc";
const id = (name: string, extra: object = {}) => ({ name, label: name, configDir: `/ids/${name}`, ...extra });
const file: any = {
  version: 1,
  identities: [id("alpha"), id("beta", { retired: true }), id("team-pool", { configDir: "/ids/pool", swapPool: { accounts: ["alpha"], active: "alpha" } })],
};
const real = (p: string): string => {
  if (p.endsWith("/projects") || p.endsWith("/sessions")) throw new Error("ENOENT");
  return p;
};
const base = {
  cwd: "/w/proj",
  loadFile: async () => file,
  real,
  t3Gateway: "/t3/gateway",
  readToken: async (dir: string) => (dir === "/ids/alpha" ? TOKEN : undefined),
  poolAuth: async () => ({ identity: "alpha", token: TOKEN }),
  label: async () => "Fix the login page",
};

test("claude identity: bearer token, encoded label, never a session id, no pool", async () => {
  const h = await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/ids/alpha", CLAUDE_CODE_SESSION_ID: "0b3b1a52-3c1e-4f7e-9d54-3a0f6d2a9c11" } });
  expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(h["X-AIS-Session-Id"]).toBeUndefined();
  expect(decodeURIComponent(h["X-AIS-Session-Label"]!)).toBe("Fix the login page");
  expect(h["X-AIS-Pool"]).toBeUndefined();
});

test("pool folder: active member token and pool header", async () => {
  const h = await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/ids/pool" } });
  expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(h["X-AIS-Pool"]).toBe("team-pool");
  expect(h["X-AIS-Session-Id"]).toBeUndefined();
});

test("T3 gateway folder maps by name", async () => {
  const h = await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/t3/gateway/t3-claude-alpha" } });
  expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
});

test("codex: --tool and --config-dir, no session id header", async () => {
  const h = await browserHeaders({ ...base, env: { CLAUDE_CODE_SESSION_ID: "x" }, tool: "codex", configDir: "/ids/alpha" });
  expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(h["X-AIS-Session-Id"]).toBeUndefined();
});

test("prints nothing for no identity, retired identity, no token, pool error, other providers, no folder", async () => {
  expect(await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/elsewhere" } })).toEqual({});
  expect(await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/ids/beta" } })).toEqual({});
  expect(await browserHeaders({ ...base, readToken: async () => undefined, env: { CLAUDE_CONFIG_DIR: "/ids/alpha" } })).toEqual({});
  expect(await browserHeaders({ ...base, poolAuth: async () => ({ error: "no token" }), env: { CLAUDE_CONFIG_DIR: "/ids/pool" } })).toEqual({});
  expect(await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/t3/gateway/t3-claude-kimi-alpha" } })).toEqual({});
  expect(await browserHeaders({ ...base, env: { CLAUDE_CONFIG_DIR: "/t3/gateway/t3-claude-zai-pool" } })).toEqual({});
  expect(await browserHeaders({ ...base, env: {} })).toEqual({});
  expect(await browserHeaders({ ...base, loadFile: async () => { throw new Error("x"); }, env: { CLAUDE_CONFIG_DIR: "/ids/alpha" } })).toEqual({});
});

test("a provider folder named like an identity is still refused", async () => {
  const f: any = { version: 1, identities: [id("t3-claude-kimi-alpha", { configDir: "/t3/gateway/t3-claude-kimi-alpha" })] };
  expect(await browserHeaders({ ...base, loadFile: async () => f, env: { CLAUDE_CONFIG_DIR: "/t3/gateway/t3-claude-kimi-alpha" } })).toEqual({});
});

test("provider name check", () => {
  for (const n of ["t3-claude-kimi-alpha", "t3-claude-zai-pool", "kimi", "zai-x"]) expect(isOtherProviderName(n)).toBe(true);
  for (const n of ["t3-claude-alpha", "pool", "team"]) expect(isOtherProviderName(n)).toBe(false);
});

test("--tool=claude never reads CODEX_HOME", async () => {
  expect(await browserHeaders({ ...base, tool: "claude", env: { CODEX_HOME: "/ids/alpha" } })).toEqual({});
});

test("a Kimi or Z.ai folder is refused with trailing slash, dot or dot-dot segments", async () => {
  for (const d of ["/t3/gateway/t3-claude-kimi-pool/.", "/t3/gateway/t3-claude-kimi-pool/", "/t3/gateway/t3-claude-zai-pool//", "/t3/gateway/x/../t3-claude-kimi-pool/."]) {
    const f: any = { version: 1, identities: [id("p", { configDir: d })] };
    expect(await browserHeaders({ ...base, loadFile: async () => f, env: { CLAUDE_CONFIG_DIR: d } })).toEqual({});
  }
});

test("agent pod: no registry match, token from AIS_BROWSER_AGENT_TOKEN_FILE, no pool header", async () => {
  const readTokenPath = async (p: string) => (p === "/run/ais-browser/token" ? TOKEN : undefined);
  const env = { CLAUDE_CONFIG_DIR: "/home/u/.claude/identities/swap", AIS_BROWSER_AGENT_TOKEN_FILE: "/run/ais-browser/token" };
  const h = await browserHeaders({ ...base, readTokenPath, env });
  expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(h["X-AIS-Pool"]).toBeUndefined();
  expect(h["X-AIS-Session-Id"]).toBeUndefined();
  // A pod has no registry file at all: loading it fails, the token file still applies.
  const noRegistry = await browserHeaders({ ...base, readTokenPath, loadFile: async () => { throw new Error("ENOENT"); }, env });
  expect(noRegistry.Authorization).toBe(`Bearer ${TOKEN}`);
  // Missing or empty token file: nothing.
  expect(await browserHeaders({ ...base, readTokenPath: async () => undefined, env })).toEqual({});
});

test("pod token file never overrides the registry or the Kimi and Z.ai refusal", async () => {
  const readTokenPath = async () => "aisg_SYNTHETIC_FIXTURE_other";
  const file = "/run/ais-browser/token";
  // A registered identity without a token stays without headers.
  expect(await browserHeaders({ ...base, readToken: async () => undefined, readTokenPath, env: { CLAUDE_CONFIG_DIR: "/ids/alpha", AIS_BROWSER_AGENT_TOKEN_FILE: file } })).toEqual({});
  // A registered identity with a token uses its own token.
  const own = await browserHeaders({ ...base, readTokenPath, env: { CLAUDE_CONFIG_DIR: "/ids/alpha", AIS_BROWSER_AGENT_TOKEN_FILE: file } });
  expect(own.Authorization).toBe(`Bearer ${TOKEN}`);
  // Other-provider folders get nothing.
  for (const d of ["/home/u/.claude/identities/kimi-dynacom", "/home/u/.claude/identities/zai-dynacom"]) {
    expect(await browserHeaders({ ...base, readTokenPath, env: { CLAUDE_CONFIG_DIR: d, AIS_BROWSER_AGENT_TOKEN_FILE: file } })).toEqual({});
  }
});
