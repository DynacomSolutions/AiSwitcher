import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  buildCodexGatewayAuth,
  codexGatewayHomeProblem,
  codexLocalGatewayEnv,
  configureCodexGatewayHome,
  migrateLocalGatewayConfigText,
  migrateRegisteredLocalCodexHomes,
  usesLocalGatewayTls,
  loadCodexGatewayHomes,
  parseGatewayProvider,
  refreshRegisteredCodexHomes,
  registerCodexGatewayHome,
  transformCodexGatewayConfig,
} from "../../src/identities/codex-gateway-home.ts";

const TOKEN = "aisgw_SYNTHETIC_FIXTURE_0123456789";
const BASE = "https://gw.example.com/gateway";
const CONFIG = `model = "gpt-5"
model_provider = "ais-gateway"

# keep this comment
[model_providers.ais-gateway]
name = "AIS"
base_url = "${BASE}/t3-demo"
wire_api = "responses"

[model_providers.ais-gateway.auth]
command = "printf"
args = ["x"]

[projects."/work/demo"]
trust_level = "trusted"
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ais-cgh-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("auth.json", () => {
  test("shape", () => {
    const auth = JSON.parse(buildCodexGatewayAuth("t3-demo", TOKEN));
    expect(auth).toMatchObject({ OPENAI_API_KEY: null, last_refresh: "2099-01-01T00:00:00Z", tokens: { access_token: TOKEN, refresh_token: "none", account_id: "ais-t3-demo" } });
    const [h, c, s] = auth.tokens.id_token.split(".");
    expect(s).toBe("c2ln");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "none", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      email: "t3-demo@gateway.invalid",
      exp: 4102444800,
      iat: 1700000000,
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "ais-t3-demo" },
    });
  });
});

describe("config.toml transform", () => {
  const out = transformCodexGatewayConfig(CONFIG, BASE, "t3-demo");
  const parsed = parseToml(out) as Record<string, any>;

  test("top-level chatgpt_base_url, requires_openai_auth once, auth table gone", () => {
    expect(parsed.chatgpt_base_url).toBe(`${BASE}/t3-demo/backend-api`);
    expect(out.indexOf("chatgpt_base_url")).toBeLessThan(out.indexOf("["));
    expect(parsed.model_providers["ais-gateway"].requires_openai_auth).toBe(true);
    expect(parsed.model_providers["ais-gateway"].auth).toBeUndefined();
    expect(out.match(/requires_openai_auth/g)).toHaveLength(1);
  });
  test("keeps other content", () => {
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.model_providers["ais-gateway"].wire_api).toBe("responses");
    expect(parsed.projects["/work/demo"].trust_level).toBe("trusted");
    expect(out).toContain("# keep this comment");
  });
  test("idempotent, and fixes requires_openai_auth = false", () => {
    expect(transformCodexGatewayConfig(out, BASE, "t3-demo")).toBe(out);
    const flipped = transformCodexGatewayConfig(out.replace("requires_openai_auth = true", "requires_openai_auth = false"), BASE, "t3-demo");
    expect(flipped).toBe(out);
  });
  test("parses base and app", () => {
    expect(parseGatewayProvider(CONFIG)).toEqual({ base: BASE, app: "t3-demo" });
    expect(() => parseGatewayProvider('model = "x"\n')).toThrow(/base_url/);
  });
});

describe("configureCodexGatewayHome", () => {
  test("writes 0600 auth.json, rewrites config, check passes", async () => {
    writeFileSync(join(dir, "config.toml"), CONFIG, { mode: 0o640 });
    expect(await codexGatewayHomeProblem(dir)).toMatch(/auth|needs/);
    expect(await configureCodexGatewayHome(dir, TOKEN)).toEqual({ app: "t3-demo" });
    expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "config.toml")).mode & 0o777).toBe(0o640);
    expect(await codexGatewayHomeProblem(dir)).toBeUndefined();
    const before = readFileSync(join(dir, "config.toml"), "utf8");
    await configureCodexGatewayHome(dir, TOKEN);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(before);
  });
});

describe("registry", () => {
  test("register is unique per dir; refresh rewrites only that app's homes", async () => {
    const reg = join(dir, "reg.json");
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    await registerCodexGatewayHome({ dir: a, app: "one" }, reg);
    await registerCodexGatewayHome({ dir: a, app: "one" }, reg);
    await registerCodexGatewayHome({ dir: b, app: "two" }, reg);
    expect(await loadCodexGatewayHomes(reg)).toHaveLength(2);
    expect(await refreshRegisteredCodexHomes("one", TOKEN, reg)).toEqual({ updated: 1, failed: [] });
    expect(JSON.parse(readFileSync(join(a, "auth.json"), "utf8")).tokens.access_token).toBe(TOKEN);
    expect(() => statSync(join(b, "auth.json"))).toThrow();
  });
  test("missing registry is empty", async () => {
    expect(await loadCodexGatewayHomes(join(dir, "none.json"))).toEqual([]);
  });
});

describe("local gateway route", () => {
  const localConfig = (url: string) => `model_provider = "ais-gateway"\n\n[model_providers.ais-gateway]\nbase_url = "${url}"\n`;
  test("a loopback base_url ending in a local route key maps to that route's app", () => {
    expect(parseGatewayProvider(localConfig("http://127.0.0.1:47140/codex"))).toEqual({ base: "http://127.0.0.1:47140", app: "agents-codex", route: "codex" });
    expect(parseGatewayProvider(localConfig("http://localhost:47140/codex/"))).toMatchObject({ app: "agents-codex", route: "codex" });
  });
  test("the cluster form keeps the last segment as the app, also for a route-like name on a non-loopback host", () => {
    expect(parseGatewayProvider(localConfig("https://gw.example.com/gateway/codex"))).toEqual({ base: "https://gw.example.com/gateway", app: "codex" });
    expect(parseGatewayProvider(localConfig("http://127.0.0.1:47140/codex/agents-codex"))).toEqual({ base: "http://127.0.0.1:47140/codex", app: "agents-codex" });
  });
  test("chatgpt_base_url stays under the route the local gateway serves", () => {
    const out = transformCodexGatewayConfig(localConfig("http://127.0.0.1:47140/codex"), "http://127.0.0.1:47140", "agents-codex", "codex");
    expect((parseToml(out) as Record<string, unknown>).chatgpt_base_url).toBe("http://127.0.0.1:47140/codex/backend-api");
  });
  test("configure and --check on a local-route folder use the agents-codex placeholder", async () => {
    writeFileSync(join(dir, "config.toml"), localConfig("http://127.0.0.1:47140/codex"));
    expect(await configureCodexGatewayHome(dir, TOKEN)).toEqual({ app: "agents-codex" });
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).tokens.account_id).toBe("ais-agents-codex");
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain('chatgpt_base_url = "https://localhost:47141/codex/backend-api"');
    expect(await codexGatewayHomeProblem(dir)).toBeUndefined();
  });
});

describe("local gateway over HTTPS", () => {
  const PROVIDER_ONLY = `model_provider = "ais-gateway"

[model_providers.ais-gateway]
name = "AIS"
base_url = "http://127.0.0.1:47140/codex"
`;
  // Placeholder-login home: top-level chatgpt_base_url on the local plain-HTTP gateway.
  const LOCAL = `chatgpt_base_url = "http://127.0.0.1:47140/codex/backend-api"\n${PROVIDER_ONLY}`;
  // route-all API-key home: provider base_url + auth command, no chatgpt_base_url.
  const API_KEY_HOME = `${PROVIDER_ONLY}wire_api = "responses"\n\n[model_providers.ais-gateway.auth]\ncommand = "/opt/ais/bin/ais-codex-gateway-helper"\n`;
  const dirs: string[] = [];
  const home = (config: string): string => {
    const d = mkdtempSync(join(tmpdir(), "ais-codex-local-"));
    dirs.push(d);
    writeFileSync(join(d, "config.toml"), config);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("migration rewrites only the local http codex URLs", () => {
    const text = LOCAL.replace("127.0.0.1", "localhost");
    const out = migrateLocalGatewayConfigText(text, 47140, 47141);
    expect(out).toContain('chatgpt_base_url = "https://localhost:47141/codex/backend-api"');
    expect(out).toContain('base_url = "https://localhost:47141/codex"');
    expect(out).not.toContain("http://127.0.0.1");
    const remote = `base_url = "https://gateway.example.com/gateway/t3"\n`;
    expect(migrateLocalGatewayConfigText(remote, 47140, 47141)).toBe(remote);
    expect(migrateLocalGatewayConfigText(out, 47140, 47141)).toBe(out);
  });

  test("configure writes https://localhost:<tlsPort> for a local target and the result validates", async () => {
    const dir = home(PROVIDER_ONLY);
    await configureCodexGatewayHome(dir, TOKEN);
    const cfg = parseToml(readFileSync(join(dir, "config.toml"), "utf8")) as { chatgpt_base_url?: string; model_providers: Record<string, { base_url: string }> };
    expect(cfg.chatgpt_base_url).toBe("https://localhost:47141/codex/backend-api");
    expect(cfg.model_providers["ais-gateway"]?.base_url).toBe("https://localhost:47141/codex");
    expect(await codexGatewayHomeProblem(dir)).toBeUndefined();
    expect(parseGatewayProvider(readFileSync(join(dir, "config.toml"), "utf8"))).toEqual({ base: "https://localhost:47141", app: "agents-codex", route: "codex" });
  });

  test("a route-all API-key home stays on plain http everywhere", async () => {
    expect(migrateLocalGatewayConfigText(API_KEY_HOME, 47140, 47141)).toBe(API_KEY_HOME);
    const bundle = join(tmpdir(), `ais-bundle-apikey-${process.pid}.pem`);
    writeFileSync(bundle, "x");
    const registry = join(tmpdir(), `ais-homes-${process.pid}.json`);
    try {
      const dir = home(API_KEY_HOME);
      expect(await codexLocalGatewayEnv(dir, {}, bundle)).toEqual({});
      expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(API_KEY_HOME);
      writeFileSync(registry, JSON.stringify([{ dir, app: "agents-codex" }]));
      expect(await migrateRegisteredLocalCodexHomes(47140, 47141, registry)).toEqual([]);
      expect(readFileSync(join(dir, "config.toml"), "utf8")).toBe(API_KEY_HOME);
      // The placeholder-login home in the same registry does migrate.
      const placeholder = home(LOCAL);
      writeFileSync(registry, JSON.stringify([{ dir, app: "agents-codex" }, { dir: placeholder, app: "agents-codex" }]));
      expect(await migrateRegisteredLocalCodexHomes(47140, 47141, registry)).toEqual([placeholder]);
      expect(readFileSync(join(placeholder, "config.toml"), "utf8")).toContain('chatgpt_base_url = "https://localhost:47141/codex/backend-api"');
    } finally {
      rmSync(bundle, { force: true });
      rmSync(registry, { force: true });
    }
  });

  test("launcher env carries CODEX_CA_CERTIFICATE only for local-HTTPS homes", async () => {
    const bundle = join(tmpdir(), `ais-bundle-${process.pid}.pem`);
    writeFileSync(bundle, "x");
    try {
      const https = home(migrateLocalGatewayConfigText(LOCAL, 47140, 47141));
      expect(await codexLocalGatewayEnv(https, {}, bundle)).toEqual({ CODEX_CA_CERTIFICATE: bundle });
      expect(await codexLocalGatewayEnv(https, { CODEX_CA_CERTIFICATE: "/mine.pem" }, bundle)).toEqual({});
      const remote = home(CONFIG);
      expect(await codexLocalGatewayEnv(remote, {}, bundle)).toEqual({});
      expect(await codexLocalGatewayEnv(join(tmpdir(), "no-such-home-xyz"), {}, bundle)).toEqual({});
      // A home still on plain http is migrated on launch once the bundle exists.
      const old = home(LOCAL);
      expect(await codexLocalGatewayEnv(old, {}, bundle)).toEqual({ CODEX_CA_CERTIFICATE: bundle });
      expect(readFileSync(join(old, "config.toml"), "utf8")).toContain("https://localhost:47141/codex");
      expect(usesLocalGatewayTls(readFileSync(join(old, "config.toml"), "utf8"), 47141)).toBe(true);
      // No bundle yet (older gateway without HTTPS): untouched.
      const waiting = home(LOCAL);
      expect(await codexLocalGatewayEnv(waiting, {}, join(tmpdir(), "missing-bundle.pem"))).toEqual({});
      expect(readFileSync(join(waiting, "config.toml"), "utf8")).toBe(LOCAL);
    } finally {
      rmSync(bundle, { force: true });
    }
  });
});
