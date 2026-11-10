import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  buildCodexGatewayAuth,
  codexGatewayHomeProblem,
  configureCodexGatewayHome,
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
